/**
 * Run owner: per-thread serialization, streaming input queue, options assembly,
 * SDK stream → status/result posting, stall watchdog, resume pre-check.
 * Spec §Run lifecycle, §Model token, §Write safety.
 */
import type { HookCallback, HookJSONOutput, SDKResultMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { parseLeadingToken, resolveModel } from "./channels.ts";
import { log } from "./log.ts";
import { resolveProviderProfile, validateProviderReferences } from "./providers.ts";
import type { InboundMessage, Options, Query, RunDeps, RunManager } from "./types.ts";

export const STALL_TIMEOUT_MS = 30 * 60 * 1000;
export const MAX_BUDGET_USD = 5;
export const PROJECTS_DIR = "/Users/jaredsmith/Projects";
export const DCG_PATH = "/Users/jaredsmith/.local/bin/dcg";

const dcgHook: HookCallback = async (input, _toolUseId, { signal }) => {
  const proc = Bun.spawn([DCG_PATH], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, DCG_ROBOT: "1", DCG_NO_COLOR: "1" },
  });
  const abort = () => proc.kill();
  signal.addEventListener("abort", abort, { once: true });
  try {
    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (!stdout.trim()) {
      if (exitCode === 0) return {};
      throw new Error(stderr.trim() || `dcg exited ${exitCode}`);
    }
    return JSON.parse(stdout) as HookJSONOutput;
  } finally {
    signal.removeEventListener("abort", abort);
  }
};

const DCG_HOOKS = { PreToolUse: [{ matcher: "Bash", hooks: [dcgHook], timeout: 5 }] };


interface ThreadState {
  channelId: string;
  threadKey: string;
  queue: InboundMessage[];
  /** Runs chained but not yet started. */
  scheduled: number;
  live: boolean;
  /** Input iterable closed — a queued message belongs to the NEXT Run (spec §Run lifecycle step 3). */
  closed: boolean;
  chain: Promise<void>;
  wake: (() => void) | null;
  query: Query | null;
  abort: AbortController | null;
  stopClicks: number;
  statusTs: string | null;
  /** First mention landed mid-thread: fetch prior replies before the first prompt. */
  needContext: boolean;
}

interface RunOpts {
  stallMs?: number;
  throttleMs?: number;
}

function beforeSlackTs(candidate: string, current: string): boolean {
  const [candidateSeconds = "0", candidateFraction = ""] = candidate.split(".");
  const [currentSeconds = "0", currentFraction = ""] = current.split(".");
  const seconds = BigInt(candidateSeconds) - BigInt(currentSeconds);
  if (seconds !== 0n) return seconds < 0n;
  return candidateFraction.padEnd(6, "0") < currentFraction.padEnd(6, "0");
}

function toolLine(name: string, rawInput: unknown): string {
  const input: Record<string, unknown> =
    rawInput && typeof rawInput === "object" ? (rawInput as Record<string, unknown>) : {};
  if (name === "TodoWrite" && Array.isArray(input.todos)) {
    const active = input.todos.find((t) => t?.status === "in_progress");
    return `📝 ${active?.content ?? "updating todos"}`.slice(0, 150);
  }
  const arg = input.file_path ?? input.command ?? input.pattern ?? input.path ?? input.url ?? input.description ?? "";
  return `🔧 ${name} ${String(arg)}`.trim().slice(0, 150);
}

export function redactSecrets(value: unknown): string {
  return String(value)
    .replace(/\b(ANTHROPIC_(?:API_KEY|AUTH_TOKEN))\s*[=:]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/\bAuthorization\s*:\s*Bearer\s+[^\s,;]+/gi, "Authorization: Bearer [REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/g, "Bearer [REDACTED]")
    .replace(/\bsk-ant-[A-Za-z0-9_-]+/g, "[REDACTED]");
}

/**
 * Where replies for a message go: DMs and top-level channel messages post
 * in-channel (undefined); explicit Slack-thread conversations stay threaded.
 */
export function replyThreadTs(msg: InboundMessage): string | undefined {
  return msg.channelType === "im" || !msg.threadTs ? undefined : msg.threadKey;
}
function statusBlocks(text: string, channelId: string, threadKey: string): unknown[] {
  const stop = {
    type: "button", text: { type: "plain_text", text: "Stop" },
    action_id: "stop", value: JSON.stringify({ channelId, threadKey }),
  };
  return [
    { type: "section", text: { type: "mrkdwn", text } },
    { type: "actions", elements: [stop] },
  ];
}
export function createRunManager(deps: RunDeps, opts: RunOpts = {}): RunManager {
  const stallMs = opts.stallMs ?? STALL_TIMEOUT_MS;
  const throttleMs = opts.throttleMs ?? 1000;
  const states = new Map<string, ThreadState>();

  function getState(channelId: string, threadKey: string): ThreadState {
    const k = `${channelId}\u0000${threadKey}`;
    let st = states.get(k);
    if (!st) {
      st = {
        channelId, threadKey, queue: [], scheduled: 0, live: false, closed: true,
        chain: Promise.resolve(), wake: null, query: null, abort: null,
        stopClicks: 0, statusTs: null, needContext: false,
      };
      states.set(k, st);
    }
    return st;
  }

  async function finalizeStatus(st: ThreadState, text: string, blocks?: unknown[]): Promise<void> {
    if (!st.statusTs) {
      deps.store.setActiveStatus(st.channelId, st.threadKey, null);
      return;
    }
    try {
      await deps.slack.updateMessage({ channel: st.channelId, ts: st.statusTs, text, blocks });
      deps.store.setActiveStatus(st.channelId, st.threadKey, null);
    } catch (error) {
      // Keep active_status_ts: the next boot sweep still has a durable handle.
      log("status_update_error", { channelId: st.channelId, threadKey: st.threadKey, error: String(error) });
    }
  }

  async function deleteStatus(st: ThreadState): Promise<void> {
    if (!st.statusTs) {
      deps.store.setActiveStatus(st.channelId, st.threadKey, null);
      return;
    }
    try {
      await deps.slack.deleteMessage({ channel: st.channelId, ts: st.statusTs });
      deps.store.setActiveStatus(st.channelId, st.threadKey, null);
    } catch (error) {
      // Keep active_status_ts so boot sweep can still clear the stale control message.
      log("status_delete_error", { channelId: st.channelId, threadKey: st.threadKey, error: String(error) });
    }
  }

  function post(channel: string, threadTs: string | undefined, text: string): void {
    deps.slack.postMessage({ channel, threadTs, text }).catch((e) => log("post_error", { error: String(e) }));
  }

  function dispatchInner(msg: InboundMessage): void {
    const { channelId, threadKey } = msg;
    const replyTs = replyThreadTs(msg);
    const st = getState(channelId, threadKey);
    const row = deps.store.get(channelId, threadKey);
    const joinsLive = st.scheduled > 0 || (st.live && !st.closed);
    const untracked = !row && !joinsLive;
    if (untracked && msg.threadTs && !msg.mentionsBot) {
      log("ignored", { channelId, threadKey, ts: msg.ts });
      return;
    }
    const { token, rest } = parseLeadingToken(msg.text);
    if (token) {
      try {
        const models = deps.loadModels();
        const providers = deps.loadProviders();
        validateProviderReferences(providers, models.aliases);
        if (token === "models") {
          void deps.loadChannelContext(channelId, threadKey).then((ctx) => {
            const resolved = resolveModel(models, row?.model ?? null, ctx.config.model);
            post(channelId, replyTs, `models: ${Object.keys(models.aliases).join(", ")}\nthis conversation: ${resolved.alias}`);
          }).catch((error) => {
            post(channelId, replyTs, `⚠️ ${redactSecrets((error as Error).message)}`);
            log("run_refused", { channelId, threadKey, error: redactSecrets(error) });
          });
          return; // no Run
        }
        if (models.aliases[token]) {
          deps.store.setModel(channelId, threadKey, token);
          if (!rest) {
            post(channelId, replyTs, `switched to ${token}`);
            return; // bare alias: no Run (spec §Model token)
          }
          msg = { ...msg, text: rest };
        } // unknown token → literal text, run normally
      } catch (error) {
        post(channelId, replyTs, `⚠️ ${redactSecrets((error as Error).message)}`);
        log("run_refused", { channelId, threadKey, error: redactSecrets(error) });
        return;
      }
    }
    if (untracked && msg.channelType !== "im" && msg.threadTs && msg.threadTs !== msg.ts) st.needContext = true;
    st.queue.push(msg);
    if (joinsLive) {
      st.wake?.();
      return;
    }
    st.scheduled++;
    st.chain = st.chain.then(() => runOne(st, replyTs)).catch((e) => log("run_chain_error", { error: String(e) }));
  }

  async function runOne(st: ThreadState, replyTs: string | undefined): Promise<void> {
    const { channelId, threadKey } = st;
    st.scheduled--;
    st.live = true;
    st.closed = false;
    st.stopClicks = 0;
    st.statusTs = null;
    let prefix = "";
    let sessionId: string | undefined;
    let usedTool = false;
    let channelDir: string | undefined;
    let alias = "";
    try {
      const startedAt = performance.now();
      const row = deps.store.get(channelId, threadKey);
      if (st.needContext) {
        st.needContext = false;
        const currentTs = st.queue[0]?.ts ?? "";
        const replies = await deps.slack.fetchThreadReplies(channelId, threadKey, 50);
        const prior = replies.filter((reply) => !currentTs || beforeSlackTs(reply.ts, currentTs));
        prefix = `Prior thread context:\n${prior.map((r) => `<@${r.userId}>: ${r.text}`).join("\n")}\n---\n${prefix}`;
      }
      const contextStartedAt = performance.now();
      let ctx;
      try {
        ctx = await deps.loadChannelContext(channelId, threadKey);
      } catch (e) {
        st.closed = true;
        st.queue.length = 0;
        post(channelId, replyTs, `⚠️ ${(e as Error).message}`);
        log("run_refused", { channelId, threadKey, error: String(e) });
        return;
      }
      const contextMs = Math.round(performance.now() - contextStartedAt);
      channelDir = ctx.channelDir;
      for (const warning of ctx.warnings) log("channel_config_warning", { channelId, warning });
      const models = deps.loadModels();
      const threadAlias = deps.store.get(channelId, threadKey)?.model ?? null;
      const resolved = resolveModel(models, threadAlias, ctx.config.model);
      if (resolved.staleThreadAlias) {
        post(channelId, replyTs, `⚠️ model alias "${resolved.staleThreadAlias}" no longer exists; using ${resolved.alias}`);
        deps.store.setModel(channelId, threadKey, null); // warn once
      }
      alias = resolved.alias;
      const entry = models.aliases[alias]!;
      if (!entry) throw new Error(`unknown model alias "${alias}"`); // boot validates default; unreachable in practice
      const provider = resolveProviderProfile(deps.loadProviders(), entry, process.env);
      const abort = new AbortController();
      st.abort = abort;
      const options: Options = {
        cwd: ctx.workspaceDir,
        additionalDirectories: [...new Set([...ctx.config.repos, PROJECTS_DIR])],
        systemPrompt: { type: "preset", preset: "claude_code", append: ctx.systemPromptAppend },
        model: entry.model,
        ...(entry.effort ? { effort: entry.effort } : {}),
        env: provider.env,
        permissionMode: ctx.config.permissionMode,
        canUseTool: deps.approvals.canUseToolFor(channelId, replyTs),
        maxBudgetUsd: MAX_BUDGET_USD,
        allowedTools: ["Bash(*)", ...ctx.config.allowedCommands.map((command) => `Bash(${command}:*)`)],
        disallowedTools: ["Bash(rm -rf:*)"],
        settingSources: [],
        hooks: DCG_HOOKS,
        skills: [],
        strictMcpConfig: true,
        abortController: abort,
        stderr: (data: string) => log("sdk_stderr", { data: redactSecrets(data) }),
        ...(provider.pathToClaudeCodeExecutable
          ? { pathToClaudeCodeExecutable: provider.pathToClaudeCodeExecutable }
          : {}),
      };
      const posted = await deps.slack.postMessage({
        channel: channelId, threadTs: replyTs, text: "⏳ working…",
        blocks: statusBlocks("⏳ working…", channelId, threadKey),
      });
      st.statusTs = posted.ts;
      deps.store.setActiveStatus(channelId, threadKey, posted.ts);
      const sessionLookupStartedAt = performance.now();
      if (row?.sessionId) {
        const info = await deps.getSessionInfoFn(row.sessionId, { dir: ctx.workspaceDir });
        if (info) sessionId = row.sessionId;
        else {
          deps.store.clearSession(channelId, threadKey);
          prefix = "(previous session lost; starting fresh)\n";
        }
      }
      const sessionLookupMs = Math.round(performance.now() - sessionLookupStartedAt);
      if (sessionId) options.resume = sessionId;

      let first = true;
      async function* input(): AsyncGenerator<SDKUserMessage, void> {
        while (true) {
          while (st.queue.length) {
            const im = st.queue.shift()!;
            let text = `<@${im.userId}>: ${im.text}`;
            if (im.fileNote) text += `\n${im.fileNote}`;
            if (first) {
              text = prefix + text;
              first = false;
            }
            yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
          }
          if (st.closed) return;
          const { promise, resolve } = Promise.withResolvers<void>();
          st.wake = resolve;
          await promise;
        }
      }
      const queryStartedAt = performance.now();
      const q = deps.queryFn({ prompt: input(), options });
      st.query = q;
      let result: SDKResultMessage | null = null;
      let lastUpdate = 0;
      let watchdog = setTimeout(() => abort.abort(), stallMs);
      let initialized = false;
      try {
        for await (const sm of q) {
          clearTimeout(watchdog);
          watchdog = setTimeout(() => abort.abort(), stallMs);
          if (sm.type === "system" && sm.subtype === "init") {
            sessionId = sm.session_id;
            deps.store.setSession(channelId, threadKey, sm.session_id); // crash-safe: store immediately
            if (!initialized) {
              initialized = true;
              log("run_start", { channelId, threadKey, session_id: sm.session_id, model: alias, providerProfile: provider.profileName, apiKeySource: sm.apiKeySource });
              log("run_startup", {
                channelId, threadKey, model: alias,
                status_posted_ms: Math.round(sessionLookupStartedAt - startedAt),
                context_load_ms: contextMs,
                session_lookup_ms: sessionLookupMs,
                sdk_init_ms: Math.round(performance.now() - queryStartedAt),
                total_ms: Math.round(performance.now() - startedAt),
              });
            }
          } else if (sm.type === "assistant") {
            for (const block of sm.message.content) {
              if (block.type !== "tool_use") continue;
              usedTool = true;
              if (st.statusTs && Date.now() - lastUpdate >= throttleMs) {
                lastUpdate = Date.now();
                const line = toolLine(block.name, block.input);
                deps.slack
                  .updateMessage({ channel: channelId, ts: st.statusTs, text: line, blocks: statusBlocks(line, channelId, threadKey) })
                  .catch((e) => log("status_update_error", { error: String(e) }));
              }
            }
          } else if (sm.type === "result") {
            result = sm;
            // CLOSE INVARIANT: same-tick check with dispatch's enqueue (spec step 3).
            if (st.queue.length === 0) {
              st.closed = true;
              st.wake?.();
            }
          }
        }
      } finally {
        clearTimeout(watchdog);
      }
      if (result) {
        if (result.subtype === "success") {
          const text = result.result || "(no text output)";
          if (text.length > 4000) {
            await deps.slack.uploadTextFile({ channel: channelId, threadTs: replyTs, filename: "result.md", content: text });
          } else {
            await deps.slack.postMessage({ channel: channelId, threadTs: replyTs, text });
          }
        } else {
          post(channelId, replyTs, `⛔ ${result.errors.join("\n")}\nreply to continue from the last completed state`);
        }
        if (result.subtype === "success") await deleteStatus(st);
        else await finalizeStatus(st, "⛔ stopped", [{ type: "section", text: { type: "mrkdwn", text: "⛔ stopped" } }]);
        log("run_end", {
          channelId, threadKey, session_id: sessionId, subtype: result.subtype,
          total_cost_usd: result.total_cost_usd, modelUsage: result.modelUsage,
          permission_denials: result.permission_denials.length,
        });
      }
      if (!result) {
        // Stream ended with no result message (interrupt/abort mid-turn): finalize
        // the status so no "⏳" orphan survives; resume stays valid (spec acceptance #11).
        await finalizeStatus(st, "⛔ interrupted — reply to resume");
        log("run_end", { channelId, threadKey, session_id: sessionId, subtype: "interrupted" });
      }
      if (usedTool && sessionId && channelDir) {
        const curationModel = models.aliases.haiku;
        if (curationModel) deps.runCuration({ sessionId, channelDir }, curationModel).catch((e) => log("curation_error", { error: redactSecrets(e) }));
        else log("curation_skipped", { channelId, threadKey, reason: "missing haiku model alias" });
      }
    } catch (e) {
      st.closed = true;
      st.queue.length = 0;
      post(channelId, replyTs, `⚠️ ${redactSecrets((e as Error).message)}`);
      await finalizeStatus(st, "⛔ run failed — reply to resume");
      log("run_error", { channelId, threadKey, error: redactSecrets(e) });
    } finally {
      st.closed = true;
      st.live = false;
      st.query = null;
      st.abort = null;
      st.wake?.();
    }
  }

  async function markInterrupted(channelId: string, ts: string): Promise<boolean> {
    try {
      await deps.slack.updateMessage({ channel: channelId, ts, text: "interrupted by restart — reply to resume" });
      return true;
    } catch (e) {
      log("boot_sweep_error", { channelId, ts, error: String(e) });
      return false;
    }
  }

  return {
    dispatch(msg: InboundMessage): void {
      try {
        dispatchInner(msg);
      } catch (e) {
        post(msg.channelId, replyThreadTs(msg), `⚠️ ${redactSecrets((e as Error).message)}`);
        log("dispatch_error", { error: redactSecrets(e) });
      }
    },
    async stop(channelId: string, threadKey: string) {
      const st = states.get(`${channelId}\u0000${threadKey}`);
      if (!st || !st.live || !st.query) return "idle";
      st.stopClicks++;
      if (st.stopClicks === 1) {
        await st.query.interrupt().catch((e) => log("interrupt_error", { error: String(e) }));
        return "interrupted";
      }
      st.abort?.abort();
      return "aborted";
    },
    async bootSweep() {
      for (const row of deps.store.listActiveStatuses()) {
        if (await markInterrupted(row.channelId, row.activeStatusTs)) {
          deps.store.setActiveStatus(row.channelId, row.threadKey, null);
        }
      }
    },
    async shutdown() {
      for (const st of states.values()) {
        if (!st.live) continue;
        st.abort?.abort();
        if (st.statusTs && await markInterrupted(st.channelId, st.statusTs)) {
          deps.store.setActiveStatus(st.channelId, st.threadKey, null);
        }
      }
    },
  };
}
