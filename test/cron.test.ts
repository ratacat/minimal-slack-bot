import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import {
  MAX_CRON_BUDGET_USD,
  QUIET_SENTINEL,
  createCronManager,
  nextFire,
  openCronStore,
  parseCron,
} from "../src/cron.ts";
import type { CronDeps, CronJob, CronManager, CronStore } from "../src/cron.ts";
import type { ChannelContext, InboundMessage, ModelsConfig, ProvidersConfig, SlackPort } from "../src/types.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function temporaryStore(): Promise<CronStore> {
  const dir = await mkdtemp(join(tmpdir(), "slackbot-cron-"));
  tempDirs.push(dir);
  return openCronStore(join(dir, "cron.sqlite"));
}

/** Yield microtasks until cond holds — the fakes are microtask-driven, no timers needed. */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    if (cond()) return;
    await Promise.resolve();
  }
  throw new Error("condition never became true");
}

describe("parseCron", () => {
  test("expands steps, ranges, and lists with restriction flags", () => {
    const fields = parseCron("*/15 9-17 1,15 * 1-5");
    expect([...fields.minute].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
    expect([...fields.hour].sort((a, b) => a - b)).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect([...fields.dom].sort((a, b) => a - b)).toEqual([1, 15]);
    expect(fields.month.size).toBe(12);
    expect([...fields.dow].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(fields.domRestricted).toBeTrue();
    expect(fields.dowRestricted).toBeTrue();
  });

  test("maps day-of-week 7 onto Sunday (0)", () => {
    const fields = parseCron("0 12 * * 7");
    expect(fields.dow.has(0)).toBeTrue();
    expect(fields.dow.has(7)).toBeFalse();
  });

  test("supports start/step fields running to the field bound", () => {
    const fields = parseCron("5/2 * * * *");
    expect(fields.minute.has(5)).toBeTrue();
    expect(fields.minute.has(7)).toBeTrue();
    expect(fields.minute.has(59)).toBeTrue();
    expect(fields.minute.has(6)).toBeFalse();
    expect(fields.minute.has(3)).toBeFalse();
  });

  test.each([
    ["* * * *", "must have 5 fields"],
    ["60 * * * *", "out of range"],
    ["* * 32 * *", "out of range"],
    ["*/0 * * * *", "invalid step"],
    ["a * * * *", "invalid cron field"],
    ["5-1 * * * *", "out of range"],
  ])("rejects %s", (expr, message) => {
    expect(() => parseCron(expr)).toThrow(message);
  });
});

describe("nextFire", () => {
  test("finds the next match strictly after the reference minute", () => {
    const fields = parseCron("30 14 * * *");
    expect(nextFire(fields, new Date(2026, 6, 14, 14, 0))).toEqual(new Date(2026, 6, 14, 14, 30));
    // exactly on the match → strictly after → the next day
    expect(nextFire(fields, new Date(2026, 6, 14, 14, 30))).toEqual(new Date(2026, 6, 15, 14, 30));
  });

  test("uses POSIX OR when both day-of-month and day-of-week are restricted", () => {
    // From Wed 2026-07-01: dom=13 OR dow=Friday → Friday 2026-07-03, not Friday-the-13th
    const fields = parseCron("0 0 13 * 5");
    expect(nextFire(fields, new Date(2026, 6, 1, 0, 0))).toEqual(new Date(2026, 6, 3, 0, 0));
  });

  test("uses AND when only day-of-month is restricted", () => {
    const fields = parseCron("0 0 13 * *");
    expect(nextFire(fields, new Date(2026, 6, 1, 0, 0))).toEqual(new Date(2026, 6, 13, 0, 0));
  });

  test("returns null when no time matches within the scan window", () => {
    expect(nextFire(parseCron("0 0 30 2 *"), new Date(2026, 6, 1))).toBeNull();
  });
});

describe("openCronStore", () => {
  test("adds, lists per channel, and removes jobs", async () => {
    const store = await temporaryStore();
    try {
      const a = store.add({ channelId: "C1", name: "a", schedule: "* * * * *", prompt: "p", createdBy: "U1", nextRunAt: 1000 });
      const b = store.add({ channelId: "C2", name: "b", schedule: "* * * * *", prompt: "p", createdBy: "U1", nextRunAt: null });
      expect(a).toMatchObject({ id: 1, channelId: "C1", enabled: 1, runCount: 0, errorCount: 0, nextRunAt: 1000 });
      expect(store.list("C1").map((job) => job.id)).toEqual([1]);
      expect(store.list("C2").map((job) => job.id)).toEqual([b.id]);
      expect(store.remove(a.id)).toBeTrue();
      expect(store.remove(a.id)).toBeFalse();
      expect(store.get(a.id)).toBeUndefined();
    } finally {
      store.close();
    }
  });

  test("due returns only enabled jobs at or before now", async () => {
    const store = await temporaryStore();
    try {
      const due = store.add({ channelId: "C1", name: "due", schedule: "* * * * *", prompt: "p", createdBy: "U1", nextRunAt: 5000 });
      const later = store.add({ channelId: "C1", name: "later", schedule: "* * * * *", prompt: "p", createdBy: "U1", nextRunAt: 5001 });
      const disabled = store.add({ channelId: "C1", name: "off", schedule: "* * * * *", prompt: "p", createdBy: "U1", nextRunAt: 4000 });
      store.setEnabled(disabled.id, false, null);

      expect(store.due(5000).map((job) => job.id)).toEqual([due.id]);
      expect(store.due(5001).map((job) => job.id).sort()).toEqual([due.id, later.id].sort());

      store.setEnabled(disabled.id, true, 100);
      expect(store.due(5000).map((job) => job.id)).toContain(disabled.id);
    } finally {
      store.close();
    }
  });

  test("recordFire tracks status, counters, and caps stored text", async () => {
    const store = await temporaryStore();
    try {
      const job = store.add({ channelId: "C1", name: "j", schedule: "* * * * *", prompt: "p", createdBy: "U1", nextRunAt: 1 });
      store.recordFire(job.id, { status: "ok", result: "x".repeat(3000), nextRunAt: 2 });
      let row = store.get(job.id)!;
      expect(row).toMatchObject({ lastStatus: "ok", runCount: 1, errorCount: 0, nextRunAt: 2, lastError: null });
      expect(row.lastResult).toHaveLength(2000);

      store.recordFire(job.id, { status: "quiet", result: QUIET_SENTINEL, nextRunAt: 3 });
      row = store.get(job.id)!;
      expect(row).toMatchObject({ lastStatus: "quiet", runCount: 2, errorCount: 0 });

      store.recordFire(job.id, { status: "error", error: "boom", nextRunAt: 4 });
      row = store.get(job.id)!;
      expect(row).toMatchObject({ lastStatus: "error", lastError: "boom", runCount: 3, errorCount: 1, nextRunAt: 4 });

      store.recordFire(job.id, { status: "error", error: "e".repeat(3000), nextRunAt: 5 });
      row = store.get(job.id)!;
      expect(row.lastError).toHaveLength(2000);
      expect(row).toMatchObject({ runCount: 4, errorCount: 2 });
    } finally {
      store.close();
    }
  });
});

interface CronQueryCall {
  prompt: string;
  options: Record<string, unknown>;
}

interface CronHarness {
  manager: CronManager;
  store: CronStore;
  posts: Array<{ channel: string; threadTs?: string; text: string }>;
  uploads: Array<{ channel: string; filename: string; content: string }>;
  calls: CronQueryCall[];
}

interface CronHarnessOptions {
  resultText?: string | null;
  errors?: string[];
  queryThrows?: string;
  ctxThrows?: string;
  /** Resolves once a query is running; the query finishes when `release` settles. */
  gate?: { started: () => void; release: Promise<void> };
  permissionMode?: "default" | "acceptEdits";
  allowedCommands?: string[];
}

const CRON_MODELS: ModelsConfig = { default: "sonnet", aliases: { sonnet: { model: "claude-sonnet" } } };
const CRON_PROVIDERS: ProvidersConfig = {
  default: "test",
  profiles: { test: { mode: "api-key", env: { ANTHROPIC_API_KEY: "test-key" } } },
};

async function cronHarness(over: CronHarnessOptions = {}): Promise<CronHarness> {
  const store = await temporaryStore();
  const posts: CronHarness["posts"] = [];
  const uploads: CronHarness["uploads"] = [];
  const calls: CronQueryCall[] = [];
  const slack: SlackPort = {
    async postMessage(args) {
      posts.push(args);
      return { ts: `ts${posts.length}` };
    },
    async updateMessage() {},
    async deleteMessage() {},
    async uploadTextFile(args) {
      uploads.push(args);
    },
    async fetchThreadReplies() {
      return [];
    },
    async fetchChannelName() {
      return undefined;
    },
  };
  const deps: CronDeps = {
    slack,
    store,
    loadChannelContext: async (channelId): Promise<ChannelContext> => {
      if (over.ctxThrows) throw new Error(over.ctxThrows);
      return {
        channelDir: `/data/${channelId}`,
        workspaceDir: `/data/${channelId}/workspace`,
        config: {
          repos: ["/repo/a"],
          allowedCommands: over.allowedCommands ?? ["pm2", "bun test"],
          permissionMode: over.permissionMode ?? "acceptEdits",
        },
        systemPromptAppend: "APPEND",
        warnings: [],
      };
    },
    loadModels: () => CRON_MODELS,
    loadProviders: () => CRON_PROVIDERS,
    queryFn: ((params: { prompt: string; options: Record<string, unknown> }) => {
      if (over.queryThrows) throw new Error(over.queryThrows);
      calls.push(params);
      return (async function* () {
        over.gate?.started();
        if (over.gate) await over.gate.release;
        if (over.errors) {
          yield { type: "result", subtype: "error_max_turns", errors: over.errors };
        } else if (over.resultText !== null) {
          yield { type: "result", subtype: "success", result: over.resultText ?? "report body" };
        }
      })();
    }) as unknown as CronDeps["queryFn"],
  };
  return { manager: createCronManager(deps), store, posts, uploads, calls };
}

function seedJob(store: CronStore, over: Partial<Parameters<CronStore["add"]>[0]> = {}): CronJob {
  return store.add({
    channelId: "C1",
    name: "nightly",
    schedule: "0 3 * * *",
    prompt: "check the repo",
    createdBy: "U1",
    nextRunAt: Date.now(),
    ...over,
  });
}

function channelMsg(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channelId: "C1", channelType: "channel", threadKey: "C1", ts: "100",
    userId: "U1", text: "[cron] ignored", mentionsBot: true, ...over,
  };
}

describe("cron fire", () => {
  test("assembles unattended options: no acceptEdits, channel commands only, cron budget", async () => {
    const h = await cronHarness({ permissionMode: "acceptEdits" });
    try {
      const job = seedJob(h.store);
      await h.manager.fire(job);

      expect(h.calls).toHaveLength(1);
      const options = h.calls[0]!.options;
      expect(options.permissionMode).toBe("default"); // never inherits interactive acceptEdits
      expect(options.allowedTools).toEqual(["Bash(pm2:*)", "Bash(bun test:*)"]);
      expect(options.allowedTools).not.toContain("Bash(*)");
      expect(options.maxBudgetUsd).toBe(MAX_CRON_BUDGET_USD);
      expect(options.persistSession).toBeFalse();
      expect(options.cwd).toBe("/data/C1/workspace");
      expect(options.settingSources).toEqual([]);
      expect(options.strictMcpConfig).toBeTrue();
      expect(h.calls[0]!.prompt).toContain("check the repo");
      expect(h.calls[0]!.prompt).toContain(QUIET_SENTINEL);

      const canUseTool = options.canUseTool as CanUseTool;
      const decision = await canUseTool("Edit", {}, { signal: new AbortController().signal } as Parameters<CanUseTool>[2]);
      expect(decision?.behavior).toBe("deny");
      if (decision?.behavior !== "deny") throw new Error("expected denial");
      expect(decision.message).toContain("allowedCommands");
    } finally {
      h.store.close();
    }
  });

  test("posts a non-quiet report and records the fire", async () => {
    const h = await cronHarness({ resultText: "found 3 stale branches" });
    try {
      const job = seedJob(h.store);
      await h.manager.fire(job);

      expect(h.posts).toHaveLength(1);
      expect(h.posts[0]!.text).toContain("nightly");
      expect(h.posts[0]!.text).toContain("found 3 stale branches");
      const row = h.store.get(job.id)!;
      expect(row).toMatchObject({ lastStatus: "ok", runCount: 1, errorCount: 0 });
      expect(row.lastResult).toBe("found 3 stale branches");
      expect(row.nextRunAt).toBeGreaterThan(Date.now());
    } finally {
      h.store.close();
    }
  });

  test("records a quiet fire without posting, but posts on manual fire", async () => {
    const h = await cronHarness({ resultText: QUIET_SENTINEL });
    try {
      const job = seedJob(h.store);
      await h.manager.fire(job);
      expect(h.posts).toHaveLength(0);
      expect(h.store.get(job.id)!.lastStatus).toBe("quiet");

      await h.manager.fire(h.store.get(job.id)!, true);
      expect(h.posts).toHaveLength(1);
      expect(h.posts[0]!.text).toContain(QUIET_SENTINEL);
    } finally {
      h.store.close();
    }
  });

  test("records an error result without posting to the channel", async () => {
    const h = await cronHarness({ errors: ["budget exceeded"] });
    try {
      const job = seedJob(h.store);
      await h.manager.fire(job);

      expect(h.posts).toHaveLength(0);
      expect(h.store.get(job.id)!).toMatchObject({ lastStatus: "error", lastError: "budget exceeded", errorCount: 1 });
    } finally {
      h.store.close();
    }
  });

  test("records a thrown query error with secrets redacted", async () => {
    const h = await cronHarness({ queryThrows: "ANTHROPIC_AUTH_TOKEN=super-secret rejected" });
    try {
      const job = seedJob(h.store);
      await h.manager.fire(job);

      const row = h.store.get(job.id)!;
      expect(row.lastStatus).toBe("error");
      expect(row.lastError).toContain("[REDACTED]");
      expect(row.lastError).not.toContain("super-secret");
    } finally {
      h.store.close();
    }
  });

  test("uploads oversized reports as a snippet instead of posting", async () => {
    const h = await cronHarness({ resultText: "x".repeat(4001) });
    try {
      const job = seedJob(h.store);
      await h.manager.fire(job);

      expect(h.posts).toHaveLength(0);
      expect(h.uploads).toHaveLength(1);
      expect(h.uploads[0]!.filename).toBe(`cron-${job.id}.md`);
      expect(h.uploads[0]!.content).toContain("x".repeat(4001));
    } finally {
      h.store.close();
    }
  });

  test("a job never overlaps itself: a second fire during a live run is dropped", async () => {
    const startedGate = Promise.withResolvers<void>();
    const releaseGate = Promise.withResolvers<void>();
    const h = await cronHarness({ gate: { started: startedGate.resolve, release: releaseGate.promise } });
    try {
      const job = seedJob(h.store);
      const first = h.manager.fire(job);
      await startedGate.promise;
      await h.manager.fire(job); // guard: returns without a second query
      expect(h.calls).toHaveLength(1);

      releaseGate.resolve();
      await first;
      expect(h.store.get(job.id)!.runCount).toBe(1);
    } finally {
      h.store.close();
    }
  });

  test("records a fire error when the channel context refuses to load", async () => {
    const h = await cronHarness({ ctxThrows: "Invalid channel config: bad repos" });
    try {
      const job = seedJob(h.store);
      await h.manager.fire(job);

      expect(h.posts).toHaveLength(0);
      expect(h.calls).toHaveLength(0);
      const row = h.store.get(job.id)!;
      expect(row).toMatchObject({ lastStatus: "error", errorCount: 1 });
      expect(row.lastError).toContain("Invalid channel config: bad repos");
      expect(row.nextRunAt).toBeGreaterThan(Date.now()); // still rescheduled after the failure
    } finally {
      h.store.close();
    }
  });

  test("start fires due jobs on the immediate tick; disabled jobs stay idle", async () => {
    const h = await cronHarness({ resultText: QUIET_SENTINEL });
    try {
      const due = seedJob(h.store, { nextRunAt: Date.now() - 1000 });
      const paused = seedJob(h.store, { name: "paused", nextRunAt: Date.now() - 1000 });
      h.store.setEnabled(paused.id, false, null);

      h.manager.start();
      await until(() => h.store.get(due.id)?.runCount === 1);

      expect(h.calls).toHaveLength(1);
      expect(h.store.get(paused.id)!.runCount).toBe(0);
    } finally {
      h.manager.stop();
      h.store.close();
    }
  });
});

describe("cron handleCommand", () => {
  test("add schedules a job, truncates long names, and replies with the first fire", async () => {
    const h = await cronHarness();
    try {
      const longPrompt = "summarize everything that happened in the repository today in detail";
      await h.manager.handleCommand(channelMsg(), `add 0 9 * * 1-5 ${longPrompt}`);

      const jobs = h.store.list("C1");
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!).toMatchObject({ schedule: "0 9 * * 1-5", prompt: longPrompt, createdBy: "U1" });
      expect(jobs[0]!.name).toHaveLength(48);
      expect(jobs[0]!.name.endsWith("...")).toBeTrue();
      expect(jobs[0]!.nextRunAt).toBeGreaterThan(Date.now());
      expect(h.posts[0]!.text).toContain("added job");
      expect(h.posts[0]!.text).toContain("first fire");
    } finally {
      h.store.close();
    }
  });

  test("run fires immediately and posts even a quiet result", async () => {
    const h = await cronHarness({ resultText: QUIET_SENTINEL });
    try {
      const job = seedJob(h.store);
      await h.manager.handleCommand(channelMsg(), `run ${job.id}`);

      expect(h.posts[0]!.text).toContain("firing");
      await until(() => h.posts.length === 2);
      expect(h.posts[1]!.text).toContain(QUIET_SENTINEL);
      expect(h.store.get(job.id)!.lastStatus).toBe("quiet");
    } finally {
      h.store.close();
    }
  });

  test("info surfaces the last error after a failed fire", async () => {
    const h = await cronHarness();
    try {
      const job = seedJob(h.store);
      h.store.recordFire(job.id, { status: "error", error: "exploded badly", nextRunAt: null });

      await h.manager.handleCommand(channelMsg(), `info ${job.id}`);

      expect(h.posts[0]!.text).toContain("last error");
      expect(h.posts[0]!.text).toContain("exploded badly");
    } finally {
      h.store.close();
    }
  });

  test("add without a prompt replies usage; invalid cron replies the parse error", async () => {
    const h = await cronHarness();
    try {
      await h.manager.handleCommand(channelMsg(), "add 0 9 * * 1-5");
      expect(h.posts[0]!.text).toContain("usage:");

      await h.manager.handleCommand(channelMsg(), "add 61 9 * * 1-5 do things");
      expect(h.posts[1]!.text).toContain("⚠️");
      expect(h.posts[1]!.text).toContain("out of range");
      expect(h.store.list("C1")).toHaveLength(0);
    } finally {
      h.store.close();
    }
  });

  test("list, info, enable, disable, and rm operate only on this channel's jobs", async () => {
    const h = await cronHarness();
    try {
      const job = seedJob(h.store, { channelId: "C1" });
      seedJob(h.store, { channelId: "C2", name: "other-channel" });

      await h.manager.handleCommand(channelMsg(), "list");
      expect(h.posts[0]!.text).toContain("nightly");
      expect(h.posts[0]!.text).not.toContain("other-channel");

      await h.manager.handleCommand(channelMsg(), `info ${job.id}`);
      expect(h.posts[1]!.text).toContain("check the repo");

      const foreign = h.store.list("C2")[0]!;
      await h.manager.handleCommand(channelMsg(), `info ${foreign.id}`);
      expect(h.posts[2]!.text).toContain(`no job #${foreign.id}`);

      await h.manager.handleCommand(channelMsg(), `disable ${job.id}`);
      expect(h.store.get(job.id)!).toMatchObject({ enabled: 0, nextRunAt: null });

      await h.manager.handleCommand(channelMsg(), `enable ${job.id}`);
      const enabled = h.store.get(job.id)!;
      expect(enabled.enabled).toBe(1);
      expect(enabled.nextRunAt).toBeGreaterThan(Date.now());

      await h.manager.handleCommand(channelMsg(), `rm ${job.id}`);
      expect(h.store.get(job.id)).toBeUndefined();
      expect(h.store.list("C2")).toHaveLength(1);
    } finally {
      h.store.close();
    }
  });

  test("unknown subcommands reply with usage", async () => {
    const h = await cronHarness();
    try {
      await h.manager.handleCommand(channelMsg(), "wat");
      expect(h.posts[0]!.text).toContain("cron commands");
    } finally {
      h.store.close();
    }
  });

  test("DM cron replies stay top-level; thread replies stay threaded", async () => {
    const h = await cronHarness();
    try {
      await h.manager.handleCommand(channelMsg({ channelType: "im", channelId: "D1", threadKey: "D1", threadTs: "99" }), "list");
      expect(h.posts[0]!.threadTs).toBeUndefined();

      await h.manager.handleCommand(channelMsg({ threadTs: "100", threadKey: "100" }), "list");
      expect(h.posts[1]!.threadTs).toBe("100");
    } finally {
      h.store.close();
    }
  });
});
