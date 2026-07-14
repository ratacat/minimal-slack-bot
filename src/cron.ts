/**
 * Durable channel cron jobs: 5-field cron parser, SQLite job store,
 * scheduler tick, unattended executor (fresh session per fire), and the
 * `[cron]` Slack command surface.
 */
import { Database } from "bun:sqlite";
import { PROJECTS_DIR, redactSecrets, replyThreadTs } from "./runs.ts";
import { resolveModel } from "./channels.ts";
import { resolveProviderProfile } from "./providers.ts";
import { log } from "./log.ts";
import type { query } from "@anthropic-ai/claude-agent-sdk";
import type { ChannelContext, InboundMessage, ModelsConfig, Options, ProvidersConfig, SlackPort } from "./types.ts";

export const CRON_TICK_MS = 30 * 1000;
export const MAX_CRON_BUDGET_USD = 1;
export const QUIET_SENTINEL = "NOTHING_NOTABLE";
const RESULT_CAP = 2000;

export interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  /** POSIX: when both dom and dow are restricted, a time matches if either matches. */
  domRestricted: boolean;
  dowRestricted: boolean;
}

const BOUNDS: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

/** Parse a 5-field cron expression (numbers, `*`, lists, ranges, steps). Throws on invalid input. */
export function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron expression must have 5 fields, got ${parts.length}: "${expr}"`);
  const sets = parts.map((part, i) => {
    const [lo, hi] = BOUNDS[i]!;
    const out = new Set<number>();
    for (const piece of part.split(",")) {
      const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(piece);
      if (!match) throw new Error(`invalid cron field "${piece}" in "${expr}"`);
      const step = match[2] ? Number(match[2]) : 1;
      if (step < 1) throw new Error(`invalid step in "${piece}"`);
      let start = lo;
      let end = hi;
      if (match[1] !== "*") {
        const [a, b] = match[1]!.split("-").map(Number);
        start = a!;
        end = b ?? (match[2] ? hi : a!);
      }
      if (start < lo || end > hi || start > end) throw new Error(`cron field "${piece}" out of range ${lo}-${hi}`);
      for (let v = start; v <= end; v += step) out.add(i === 4 && v === 7 ? 0 : v); // dow 7 = Sunday
    }
    return out;
  });
  return {
    minute: sets[0]!, hour: sets[1]!, dom: sets[2]!, month: sets[3]!, dow: sets[4]!,
    domRestricted: parts[2] !== "*",
    dowRestricted: parts[4] !== "*",
  };
}

/** Next fire time strictly after `from`, or null if none within ~366 days. */
export function nextFire(fields: CronFields, from: Date): Date | null {
  const t = new Date(from);
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    const dayOk = fields.domRestricted && fields.dowRestricted
      ? fields.dom.has(t.getDate()) || fields.dow.has(t.getDay())
      : fields.dom.has(t.getDate()) && fields.dow.has(t.getDay());
    if (fields.month.has(t.getMonth() + 1) && dayOk && fields.hour.has(t.getHours()) && fields.minute.has(t.getMinutes())) {
      return t;
    }
    t.setMinutes(t.getMinutes() + 1);
  }
  return null;
}

export interface CronJob {
  id: number;
  channelId: string;
  name: string;
  schedule: string;
  prompt: string;
  enabled: number;
  createdBy: string;
  createdAt: number;
  lastRunAt: number | null;
  lastStatus: string | null;
  lastResult: string | null;
  lastError: string | null;
  runCount: number;
  errorCount: number;
  nextRunAt: number | null;
}

export interface CronStore {
  add(job: { channelId: string; name: string; schedule: string; prompt: string; createdBy: string; nextRunAt: number | null }): CronJob;
  get(id: number): CronJob | undefined;
  list(channelId: string): CronJob[];
  due(now: number): CronJob[];
  setEnabled(id: number, enabled: boolean, nextRunAt: number | null): void;
  remove(id: number): boolean;
  recordFire(id: number, args: { status: "ok" | "quiet" | "error"; result?: string; error?: string; nextRunAt: number | null }): void;
  close(): void;
}

const JOB_COLUMNS = `id, channel_id AS channelId, name, schedule, prompt, enabled,
  created_by AS createdBy, created_at AS createdAt, last_run_at AS lastRunAt,
  last_status AS lastStatus, last_result AS lastResult, last_error AS lastError,
  run_count AS runCount, error_count AS errorCount, next_run_at AS nextRunAt`;

export function openCronStore(dbPath: string): CronStore {
  const db = new Database(dbPath);
  db.run("PRAGMA journal_mode = WAL");
  db.run(`CREATE TABLE IF NOT EXISTS cron_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    name TEXT NOT NULL,
    schedule TEXT NOT NULL,
    prompt TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_run_at INTEGER,
    last_status TEXT,
    last_result TEXT,
    last_error TEXT,
    run_count INTEGER NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0,
    next_run_at INTEGER
  )`);
  const insert = db.query<{ id: number }, [string, string, string, string, string, number, number | null]>(
    `INSERT INTO cron_jobs (channel_id, name, schedule, prompt, created_by, created_at, next_run_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  );
  const get = db.query<CronJob, [number]>(`SELECT ${JOB_COLUMNS} FROM cron_jobs WHERE id = ?`);
  const list = db.query<CronJob, [string]>(`SELECT ${JOB_COLUMNS} FROM cron_jobs WHERE channel_id = ? ORDER BY id`);
  const due = db.query<CronJob, [number]>(
    `SELECT ${JOB_COLUMNS} FROM cron_jobs WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?`,
  );
  const enable = db.query<void, [number, number | null, number]>(
    "UPDATE cron_jobs SET enabled = ?, next_run_at = ? WHERE id = ?",
  );
  const remove = db.query<void, [number]>("DELETE FROM cron_jobs WHERE id = ?");
  const fireOk = db.query<void, [number, string, string | null, number | null, number]>(
    `UPDATE cron_jobs SET last_run_at = ?, last_status = ?, last_result = ?, last_error = NULL,
     run_count = run_count + 1, next_run_at = ? WHERE id = ?`,
  );
  const fireErr = db.query<void, [number, string | null, number | null, number]>(
    `UPDATE cron_jobs SET last_run_at = ?, last_status = 'error', last_error = ?,
     run_count = run_count + 1, error_count = error_count + 1, next_run_at = ? WHERE id = ?`,
  );

  return {
    add(job) {
      const row = insert.get(job.channelId, job.name, job.schedule, job.prompt, job.createdBy, Date.now(), job.nextRunAt)!;
      return get.get(row.id)!;
    },
    get: (id) => get.get(id) ?? undefined,
    list: (channelId) => list.all(channelId),
    due: (now) => due.all(now),
    setEnabled: (id, enabled, nextRunAt) => enable.run(enabled ? 1 : 0, enabled ? nextRunAt : null, id),
    remove(id) {
      remove.run(id);
      return db.query<{ n: number }, []>("SELECT changes() AS n").get()!.n > 0;
    },
    recordFire(id, { status, result, error, nextRunAt }) {
      if (status === "error") fireErr.run(Date.now(), (error ?? "").slice(0, RESULT_CAP), nextRunAt, id);
      else fireOk.run(Date.now(), status, (result ?? "").slice(0, RESULT_CAP), nextRunAt, id);
    },
    close: () => db.close(),
  };
}

export interface CronDeps {
  slack: SlackPort;
  store: CronStore;
  loadChannelContext(channelId: string, threadKey: string): Promise<ChannelContext>;
  loadModels(): ModelsConfig;
  loadProviders(): ProvidersConfig;
  queryFn: typeof query;
}

export interface CronManager {
  /** `[cron] ...` command from dispatch. Replies in-channel; never throws. */
  handleCommand(msg: InboundMessage, rest: string): Promise<void>;
  start(): void;
  stop(): void;
  /** Exposed for tests / manual fires. */
  fire(job: CronJob, manual?: boolean): Promise<void>;
}

const USAGE = [
  "*cron commands:*",
  "`[cron] add <m> <h> <dom> <mon> <dow> <prompt...>` - schedule a job (5-field cron, local time)",
  "`[cron] list` - jobs in this channel",
  "`[cron] info <id>` - stats: last fire, result, errors",
  "`[cron] run <id>` - fire now",
  "`[cron] enable <id>` / `[cron] disable <id>`",
  "`[cron] rm <id>` - delete",
  `_Jobs run unattended: only this channel's allowedCommands are permitted, and a reply of exactly \`${QUIET_SENTINEL}\` is recorded but not posted._`,
].join("\n");

function ago(ts: number | null): string {
  if (!ts) return "never";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function inFuture(ts: number | null): string {
  if (!ts) return "-";
  const s = Math.max(0, Math.round((ts - Date.now()) / 1000));
  if (s < 90) return `in ${s}s`;
  if (s < 5400) return `in ${Math.round(s / 60)}m`;
  return `in ${Math.round(s / 3600)}h`;
}

function jobLine(job: CronJob): string {
  const state = job.enabled ? "🟢" : "⏸️";
  const last = job.lastStatus ? `${job.lastStatus === "error" ? "❌" : job.lastStatus === "quiet" ? "🤫" : "✅"} ${ago(job.lastRunAt)}` : "never fired";
  return `${state} *#${job.id}* \`${job.schedule}\` ${job.name} - last: ${last}, next: ${job.enabled ? inFuture(job.nextRunAt) : "paused"}, runs: ${job.runCount}${job.errorCount ? ` (${job.errorCount} errors)` : ""}`;
}

export function createCronManager(deps: CronDeps): CronManager {
  let timer: ReturnType<typeof setInterval> | null = null;
  const running = new Set<number>();

  async function fire(job: CronJob, manual = false): Promise<void> {
    if (running.has(job.id)) return;
    running.add(job.id);
    const next = computeNext(job);
    try {
      const ctx = await deps.loadChannelContext(job.channelId, job.channelId);
      const models = deps.loadModels();
      const resolved = resolveModel(models, null, ctx.config.model);
      const entry = models.aliases[resolved.alias]!;
      const provider = resolveProviderProfile(deps.loadProviders(), entry, process.env);
      const options: Options = {
        cwd: ctx.workspaceDir,
        additionalDirectories: [...new Set([...ctx.config.repos, PROJECTS_DIR])],
        systemPrompt: { type: "preset", preset: "claude_code", append: ctx.systemPromptAppend },
        model: entry.model,
        ...(entry.effort ? { effort: entry.effort } : {}),
        env: provider.env,
        // Unattended fires never inherit interactive acceptEdits: every tool not
        // in allowedTools must hit the deny canUseTool below (permission redesign:
        // bead slackbot-layered-permissions-p97.3).
        permissionMode: "default",
        canUseTool: async (toolName) => ({
          behavior: "deny",
          message: `unattended cron run: "${toolName}" requires approval - add the command to allowedCommands to permit it`,
        }),
        maxBudgetUsd: MAX_CRON_BUDGET_USD,
        allowedTools: ctx.config.allowedCommands.map((command) => `Bash(${command}:*)`),
        persistSession: false,
        settingSources: [],
        skills: [],
        strictMcpConfig: true,
        stderr: (data: string) => log("cron_sdk_stderr", { jobId: job.id, data: redactSecrets(data) }),
      };
      const prompt = [
        `Scheduled background job "${job.name}" (cron \`${job.schedule}\`, job #${job.id}). Task:`,
        job.prompt,
        "",
        `You are running unattended. If there is nothing notable to report, reply with exactly ${QUIET_SENTINEL} and nothing else.`,
        "Otherwise reply with a concise report; it will be posted to the Slack channel.",
      ].join("\n");
      let resultText: string | null = null;
      let errors: string[] = [];
      for await (const sm of deps.queryFn({ prompt, options })) {
        if (sm.type === "result") {
          if (sm.subtype === "success") resultText = sm.result || "";
          else errors = sm.errors;
        }
      }
      if (resultText === null) {
        deps.store.recordFire(job.id, { status: "error", error: errors.join("\n") || "run ended without result", nextRunAt: next });
        log("cron_fire_error", { jobId: job.id, errors });
        return;
      }
      const quiet = resultText.trim() === QUIET_SENTINEL;
      deps.store.recordFire(job.id, { status: quiet ? "quiet" : "ok", result: resultText, nextRunAt: next });
      log("cron_fire", { jobId: job.id, channelId: job.channelId, quiet, manual });
      if (!quiet || manual) {
        const text = quiet ? `🕒 *${job.name}* (#${job.id}): ${QUIET_SENTINEL}` : `🕒 *${job.name}* (#${job.id})\n${resultText}`;
        if (text.length > 4000) {
          await deps.slack.uploadTextFile({ channel: job.channelId, filename: `cron-${job.id}.md`, content: text });
        } else {
          await deps.slack.postMessage({ channel: job.channelId, text });
        }
      }
    } catch (error) {
      deps.store.recordFire(job.id, { status: "error", error: redactSecrets(error), nextRunAt: next });
      log("cron_fire_error", { jobId: job.id, error: redactSecrets(error) });
    } finally {
      running.delete(job.id);
    }
  }

  function computeNext(job: CronJob): number | null {
    try {
      return nextFire(parseCron(job.schedule), new Date())?.getTime() ?? null;
    } catch {
      return null;
    }
  }

  function tick(): void {
    for (const job of deps.store.due(Date.now())) {
      void fire(job).catch((error) => log("cron_fire_error", { jobId: job.id, error: String(error) }));
    }
  }

  async function handleCommand(msg: InboundMessage, rest: string): Promise<void> {
    const replyTs = replyThreadTs(msg);
    const reply = (text: string) =>
      deps.slack.postMessage({ channel: msg.channelId, threadTs: replyTs, text }).then(() => {}, (e) => log("post_error", { error: String(e) }));
    try {
      const [sub = "", ...args] = rest.trim().split(/\s+/);
      const argText = rest.trim().slice(sub.length).trim();
      const byId = (): CronJob | null => {
        const job = deps.store.get(Number(args[0]));
        if (!job || job.channelId !== msg.channelId) return null;
        return job;
      };
      switch (sub.toLowerCase()) {
        case "add": {
          const parts = argText.split(/\s+/);
          const schedule = parts.slice(0, 5).join(" ");
          const prompt = parts.slice(5).join(" ");
          if (!prompt) return reply("usage: `[cron] add <m> <h> <dom> <mon> <dow> <prompt...>`");
          const fields = parseCron(schedule); // throws with a useful message on bad input
          const name = prompt.length > 48 ? `${prompt.slice(0, 45)}...` : prompt;
          const job = deps.store.add({
            channelId: msg.channelId, name, schedule, prompt,
            createdBy: msg.userId, nextRunAt: nextFire(fields, new Date())?.getTime() ?? null,
          });
          return reply(`added job *#${job.id}* \`${schedule}\` - first fire ${inFuture(job.nextRunAt)}`);
        }
        case "list": {
          const jobs = deps.store.list(msg.channelId);
          return reply(jobs.length ? jobs.map(jobLine).join("\n") : "no cron jobs in this channel - `[cron] add ...` to create one");
        }
        case "info": {
          const job = byId();
          if (!job) return reply(`no job #${args[0]} in this channel`);
          const lines = [
            jobLine(job),
            `prompt: ${job.prompt}`,
            `created by <@${job.createdBy}> ${ago(job.createdAt)}`,
          ];
          if (job.lastError) lines.push(`last error: \`\`\`${job.lastError.slice(0, 500)}\`\`\``);
          else if (job.lastResult) lines.push(`last result: \`\`\`${job.lastResult.slice(0, 500)}\`\`\``);
          return reply(lines.join("\n"));
        }
        case "run": {
          const job = byId();
          if (!job) return reply(`no job #${args[0]} in this channel`);
          await reply(`firing *#${job.id}* now...`);
          void fire(job, true);
          return;
        }
        case "enable":
        case "disable": {
          const job = byId();
          if (!job) return reply(`no job #${args[0]} in this channel`);
          const enabled = sub.toLowerCase() === "enable";
          const next = enabled ? computeNext(job) : null;
          deps.store.setEnabled(job.id, enabled, next);
          return reply(`job *#${job.id}* ${enabled ? `enabled - next fire ${inFuture(next)}` : "disabled"}`);
        }
        case "rm":
        case "delete": {
          const job = byId();
          if (!job) return reply(`no job #${args[0]} in this channel`);
          deps.store.remove(job.id);
          return reply(`deleted job *#${job.id}* (${job.name})`);
        }
        default:
          return reply(USAGE);
      }
    } catch (error) {
      await deps.slack
        .postMessage({ channel: msg.channelId, threadTs: replyTs, text: `⚠️ ${redactSecrets((error as Error).message)}` })
        .catch((e) => log("post_error", { error: String(e) }));
    }
  }

  return {
    handleCommand,
    fire,
    start() {
      if (timer) return;
      timer = setInterval(tick, CRON_TICK_MS);
      tick();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
