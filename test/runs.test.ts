import { describe, expect, mock, test, vi } from "bun:test";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { createRunManager } from "../src/runs.ts";
import type {
  ApprovalPort,
  ChannelContext,
  InboundMessage,
  ModelsConfig,
  RunDeps,
  ProvidersConfig,
  RunManager,
  ThreadRow,
  ThreadStore,
} from "../src/types.ts";

/** Event-driven list: tests await the Nth item instead of sleeping. */
interface Tracker<T> {
  items: T[];
  push(v: T): void;
  at(n: number): Promise<T>;
}

function tracker<T>(): Tracker<T> {
  const items: T[] = [];
  const waiters: Array<{ n: number; resolve: (v: T) => void }> = [];
  return {
    items,
    push(v: T) {
      items.push(v);
      for (const w of [...waiters]) {
        const item = items[w.n - 1];
        if (item !== undefined) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(item);
        }
      }
    },
    at(n: number): Promise<T> {
      const item = items[n - 1];
      if (item !== undefined) return Promise.resolve(item);
      const { promise, resolve } = Promise.withResolvers<T>();
      waiters.push({ n, resolve });
      return promise;
    },
  };
}

/** Yield microtasks until cond holds — all fake I/O is microtask-driven, no timers needed. */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    if (cond()) return;
    await Promise.resolve();
  }
  throw new Error("condition never became true");
}

interface PostArgs { channel: string; threadTs?: string; text: string; blocks?: unknown[] }
interface UpdateArgs { channel: string; ts: string; text: string; blocks?: unknown[] }
interface DeleteArgs { channel: string; ts: string }
interface UploadArgs { channel: string; threadTs?: string; filename: string; content: string }

interface FakeSlack {
  posts: Tracker<PostArgs>;
  updates: Tracker<UpdateArgs>;
  deletes: Tracker<DeleteArgs>;
  uploads: Tracker<UploadArgs>;
  fetches: Tracker<{ channel: string; threadTs: string; limit: number }>;
  port: RunDeps["slack"];
}

function fakeSlack(replies: Array<{ ts: string; userId: string; text: string }> = []): FakeSlack {
  const posts = tracker<PostArgs>();
  const updates = tracker<UpdateArgs>();
  const deletes = tracker<DeleteArgs>();
  const uploads = tracker<UploadArgs>();
  const fetches = tracker<{ channel: string; threadTs: string; limit: number }>();
  return {
    posts, updates, deletes, uploads, fetches,
    port: {
      async postMessage(args: PostArgs) {
        posts.push(args);
        return { ts: `ts${posts.items.length}` };
      },
      async updateMessage(args: UpdateArgs) { updates.push(args); },
      async deleteMessage(args: DeleteArgs) { deletes.push(args); },
      async uploadTextFile(args: UploadArgs) { uploads.push(args); },
      async fetchThreadReplies(channel: string, threadTs: string, limit: number) {
        fetches.push({ channel, threadTs, limit });
        return replies;
      },
      async fetchChannelName() { return undefined; },
    },
  };
}

function fakeStore(seed: ThreadRow[] = []): ThreadStore {
  const rows = new Map<string, ThreadRow>();
  const k = (c: string, t: string) => `${c}|${t}`;
  for (const r of seed) rows.set(k(r.channelId, r.threadKey), { ...r });
  const upsert = (c: string, t: string): ThreadRow => {
    let r = rows.get(k(c, t));
    if (!r) {
      r = { channelId: c, threadKey: t, sessionId: null, model: null, activeStatusTs: null, updatedAt: 0 };
      rows.set(k(c, t), r);
    }
    return r;
  };
  return {
    get: (c, t) => rows.get(k(c, t)),
    setSession: (c, t, s) => { upsert(c, t).sessionId = s; },
    clearSession: (c, t) => { upsert(c, t).sessionId = null; },
    setModel: (c, t, a) => { upsert(c, t).model = a; },
    setActiveStatus: (c, t, s) => { upsert(c, t).activeStatusTs = s; },
    listActiveStatuses: () =>
      [...rows.values()]
        .filter((r) => r.activeStatusTs !== null)
        .map((r) => ({ channelId: r.channelId, threadKey: r.threadKey, activeStatusTs: r.activeStatusTs! })),
    close: () => {},
  };
}

interface QueryCall {
  options: Record<string, unknown>;
  fed: Tracker<SDKUserMessage>;
  emit(m: Partial<SDKMessage> & { type: string }): void;
  interruptCalls: number;
  /** End the SDK stream without a result message (interrupt behavior). */
  end(): void;
}

/** Controllable fake Query: test emits SDK messages; drains prompt input; ends when input closes. */
function fakeQueryFn() {
  const calls = tracker<QueryCall>();
  const queryFn = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Record<string, unknown> }) => {
    const outbox: SDKMessage[] = [];
    const waker: { fn: (() => void) | null } = { fn: null };
    let inputDone = false;
    let streamEnded = false;
    const fed = tracker<SDKUserMessage>();
    const call: QueryCall = {
      options: params.options ?? {},
      fed,
      emit(m) {
        outbox.push(m as SDKMessage);
        waker.fn?.();
      },
      end() {
        streamEnded = true;
        waker.fn?.();
      },
      interruptCalls: 0,
    };
    const abort = call.options.abortController as AbortController | undefined;
    abort?.signal.addEventListener("abort", () => { waker.fn?.(); });
    // Drain the streaming input like the real SDK; stream ends after input closes.
    (async () => {
      for await (const um of params.prompt as AsyncIterable<SDKUserMessage>) fed.push(um);
      inputDone = true;
      waker.fn?.();
    })();
    const q = {
      async *[Symbol.asyncIterator]() {
        while (true) {
          if (abort?.signal.aborted) throw new Error("aborted by controller");
          while (outbox.length) yield outbox.shift()!;
          if (streamEnded) return;
          if (inputDone) return;
          const { promise, resolve } = Promise.withResolvers<void>();
          waker.fn = resolve;
          await promise;
        }
      },
      async interrupt() { call.interruptCalls++; },
      async setModel() {},
    };
    calls.push(call);
    return q;
  };
  return { calls, queryFn: queryFn as unknown as RunDeps["queryFn"] };
}

const MODELS: ModelsConfig = {
  default: "sonnet",
  aliases: {
    sonnet: { model: "claude-sonnet" },
    opus: { model: "claude-opus", env: { ANTHROPIC_BASE_URL: "http://opus.local" } },
    haiku: { model: "haiku" },
  },
};

function ctxFor(channelId: string): ChannelContext {
  return {
    channelDir: `/data/${channelId}`,
    workspaceDir: `/data/${channelId}/workspace`,
    config: { repos: ["/repo/a"], allowedCommands: [], permissionMode: "default" },
    systemPromptAppend: "APPEND",
    warnings: [],
  };
}

const approvals: ApprovalPort = {
  canUseToolFor: () => async () => ({ behavior: "deny", message: "no" }),
  handleAction: async () => {},
};

interface Harness {
  deps: RunDeps;
  slack: FakeSlack;
  store: ThreadStore;
  calls: Tracker<QueryCall>;
  curations: Tracker<{ sessionId: string; channelDir: string; model: string }>;
  sessionInfo: Set<string>;
}

interface HarnessOptions {
  seed?: ThreadRow[];
  replies?: Array<{ ts: string; userId: string; text: string }>;
  ctxThrows?: string;
  models?: ModelsConfig;
  stallMs?: number;
  warnings?: string[];
  channelModel?: string;
  providers?: ProvidersConfig;
  loadModelsError?: string;
  loadProvidersError?: string;
  allowedCommands?: string[];
}

function harness(over: HarnessOptions = {}): [RunManager, Harness] {
  const slack = fakeSlack(over.replies);
  const store = fakeStore(over.seed);
  const { calls, queryFn } = fakeQueryFn();
  const curations = tracker<{ sessionId: string; channelDir: string; model: string }>();
  const sessionInfo = new Set<string>(["s-known"]);
  const deps: RunDeps = {
    slack: slack.port,
    store,
    approvals,
    loadChannelContext: async (channelId) => {
      if (over.ctxThrows) throw new Error(over.ctxThrows);
      const ctx = ctxFor(channelId);
      ctx.warnings = over.warnings ?? [];
      if (over.channelModel) ctx.config.model = over.channelModel;
      if (over.allowedCommands) ctx.config.allowedCommands = over.allowedCommands;
      return ctx;
    },
    loadModels: () => {
      if (over.loadModelsError) throw new Error(over.loadModelsError);
      return over.models ?? MODELS;
    },
    loadProviders: () => {
      if (over.loadProvidersError) throw new Error(over.loadProvidersError);
      return over.providers ?? {
        default: "test",
        profiles: { test: { mode: "api-key", env: { ANTHROPIC_API_KEY: "test-key" } } },
      };
    },
    queryFn,
    getSessionInfoFn: (async (id: string) =>
      sessionInfo.has(id) ? { sessionId: id } : undefined) as unknown as RunDeps["getSessionInfoFn"],
    runCuration: async (args, model) => { curations.push({ ...args, model: model.model }); },
  };
  const rm = createRunManager(deps, { stallMs: over.stallMs ?? 60_000, throttleMs: 0 });
  return [rm, { deps, slack, store, calls, curations, sessionInfo }];
}

function msg(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channelId: "C1", channelType: "channel", threadKey: "100", ts: "100",
    userId: "U1", text: "hello", mentionsBot: false, ...over,
  };
}

const init = (sessionId: string) =>
  ({ type: "system", subtype: "init", session_id: sessionId, apiKeySource: "ANTHROPIC_API_KEY" });
const success = (text: string, cost = 0.12) =>
  ({ type: "result", subtype: "success", result: text, total_cost_usd: cost, modelUsage: {}, permission_denials: [] });
const errorResult = (errors: string[]) =>
  ({ type: "result", subtype: "error_max_turns", errors, total_cost_usd: 0.3, modelUsage: {}, permission_denials: [] });
const toolUse = (name: string, input: Record<string, unknown>) =>
  ({ type: "assistant", message: { content: [{ type: "tool_use", name, input, id: "t1" }] } });

function userText(um: SDKUserMessage): string {
  return String(um.message.content);
}

describe("routing + run start", () => {
  test("posts one working status before the SDK emits init", async () => {
    const [rm, h] = harness();
    rm.dispatch(msg({ threadKey: "C1", mentionsBot: false, text: "slow start" }));
    const call = await h.calls.at(1);
    const status = await h.slack.posts.at(1);
    expect(status.text).toBe("⏳ working…");
    expect(status.threadTs).toBeUndefined();

    call.emit(init("s1"));
    call.emit(init("s1"));
    await until(() => h.store.get("C1", "C1")?.sessionId === "s1");
    expect(h.slack.posts.items).toHaveLength(1);
  });
  test("posts working status before scoped resume validation", async () => {
    const [rm, h] = harness({
      seed: [{ channelId: "C1", threadKey: "100", sessionId: "s-known", model: null, activeStatusTs: null, updatedAt: 0 }],
    });
    const gate = Promise.withResolvers<void>();
    let lookupDir: string | undefined;
    h.deps.getSessionInfoFn = (async (_id: string, options?: { dir?: string }) => {
      lookupDir = options?.dir;
      await gate.promise;
      return { sessionId: "s-known" };
    }) as RunDeps["getSessionInfoFn"];

    rm.dispatch(msg({ mentionsBot: true, text: "resume" }));
    const status = await h.slack.posts.at(1);
    await until(() => lookupDir !== undefined);

    expect(status.text).toBe("⏳ working…");
    expect(lookupDir).toBe("/data/C1/workspace");
    expect(h.calls.items).toHaveLength(0);
    gate.resolve();
    expect((await h.calls.at(1)).options.resume).toBe("s-known");
  });
  test("top-level channel message starts a Run without a mention and posts in-channel", async () => {
    const [rm, h] = harness();
    rm.dispatch(msg({ threadKey: "C1", mentionsBot: false, text: "do it" }));
    const call = await h.calls.at(1);
    const fed = await call.fed.at(1);
    expect(userText(fed)).toBe("<@U1>: do it");
    call.emit(init("s1"));
    const status = await h.slack.posts.at(1);
    expect(status.threadTs).toBeUndefined();
    await until(() => h.store.get("C1", "C1")?.sessionId === "s1");
    expect(h.store.get("C1", "C1")!.sessionId).toBe("s1");
    call.emit(success("done"));
    const reply = await h.slack.posts.at(2);
    expect(reply.text).toBe("done");
    expect(reply.threadTs).toBeUndefined();
    const final = await h.slack.deletes.at(1);
    expect(final).toEqual({ channel: "C1", ts: "ts1" });
    await until(() => h.store.get("C1", "C1")!.activeStatusTs === null);
  });

  test("later top-level channel messages resume the rolling channel session", async () => {
    const [rm, h] = harness({
      seed: [{ channelId: "C1", threadKey: "C1", sessionId: "s-known", model: null, activeStatusTs: null, updatedAt: 0 }],
    });
    rm.dispatch(msg({ threadKey: "C1", ts: "200", text: "continue" }));
    const call = await h.calls.at(1);
    expect(call.options.resume).toBe("s-known");
    call.emit(init("s-known"));
    expect((await h.slack.posts.at(1)).threadTs).toBeUndefined();
  });

  test("untracked non-mention reply inside a Slack thread is ignored", async () => {
    const [rm, h] = harness();
    rm.dispatch(msg({ mentionsBot: false, threadTs: "100", ts: "101" }));
    expect(h.calls.items.length).toBe(0);
    rm.dispatch(msg({ mentionsBot: true, threadTs: "100", ts: "102", text: "now" }));
    const call = await h.calls.at(1);
    expect(userText(await call.fed.at(1))).toContain("<@U1>: now");
  });

  test("explicit Slack-thread conversations keep replies in that thread", async () => {
    const [rm, h] = harness();
    rm.dispatch(msg({ mentionsBot: true, threadTs: "100", ts: "101", text: "thread work" }));
    const call = await h.calls.at(1);
    call.emit(init("s1"));
    const status = await h.slack.posts.at(1);
    expect(status.threadTs).toBe("100");
    call.emit(success("done"));
    expect((await h.slack.posts.at(2)).threadTs).toBe("100");
  });

  test("plain reply in tracked thread resumes with stored session id", async () => {
    const [rm, h] = harness({
      seed: [{ channelId: "C1", threadKey: "100", sessionId: "s-known", model: null, activeStatusTs: null, updatedAt: 0 }],
    });
    rm.dispatch(msg({ text: "continue" }));
    const call = await h.calls.at(1);
    expect(call.options.resume).toBe("s-known");
  });

  test("DM reply is top-level (no threadTs) and untracked DM starts a session", async () => {
    const [rm, h] = harness();
    rm.dispatch(msg({ channelType: "im", channelId: "D1", threadKey: "D1", mentionsBot: false }));
    const call = await h.calls.at(1);
    call.emit(init("s1"));
    const status = await h.slack.posts.at(1);
    expect(status.threadTs).toBeUndefined();
    call.emit(success("hi"));
    const reply = await h.slack.posts.at(2);
    expect(reply.threadTs).toBeUndefined();
  });

  test("mid-thread first mention prepends fetched thread replies", async () => {
    const [rm, h] = harness({ replies: [{ ts: "99", userId: "U9", text: "earlier chatter" }] });
    rm.dispatch(msg({ mentionsBot: true, threadTs: "100", ts: "105", text: "summarize" }));
    const call = await h.calls.at(1);
    const fed = await call.fed.at(1);
    expect(userText(fed)).toContain("Prior thread context:");
    expect(userText(fed)).toContain("<@U9>: earlier chatter");
    expect(userText(fed)).toContain("<@U1>: summarize");
    expect(h.slack.fetches.items[0]).toEqual({ channel: "C1", threadTs: "100", limit: 50 });
  });

  test("mid-thread backfill excludes the current and later replies", async () => {
    const [rm, h] = harness({ replies: [
      { ts: "99", userId: "U9", text: "earlier chatter" },
      { ts: "105", userId: "U1", text: "summarize" },
      { ts: "106", userId: "U2", text: "later chatter" },
    ] });
    rm.dispatch(msg({ mentionsBot: true, threadTs: "100", ts: "105", text: "summarize" }));
    const call = await h.calls.at(1);
    const text = userText(await call.fed.at(1));
    expect(text).toContain("earlier chatter");
    expect(text.match(/summarize/g)).toHaveLength(1);
    expect(text).not.toContain("later chatter");
  });

  test("mid-thread backfill orders same-second replies by ts fraction", async () => {
    const [rm, h] = harness({ replies: [
      { ts: "105.000001", userId: "U9", text: "just before" },
      { ts: "105.000002", userId: "U1", text: "summarize" },
      { ts: "105.000003", userId: "U2", text: "just after" },
    ] });
    rm.dispatch(msg({ mentionsBot: true, threadTs: "100", ts: "105.000002", text: "summarize" }));
    const call = await h.calls.at(1);
    const text = userText(await call.fed.at(1));
    expect(text).toContain("just before");
    expect(text).not.toContain("just after");
    expect(text.match(/summarize/g)).toHaveLength(1);
  });
});

describe("steering + close invariant", () => {
  test("second dispatch mid-run feeds the SAME query input (no second queryFn call)", async () => {
    const [rm, h] = harness();
    rm.dispatch(msg({ mentionsBot: true, text: "first" }));
    const call = await h.calls.at(1);
    call.emit(init("s1"));
    await call.fed.at(1);
    rm.dispatch(msg({ ts: "101", text: "also this" }));
    const second = await call.fed.at(2);
    expect(userText(second)).toBe("<@U1>: also this");
    expect(h.calls.items.length).toBe(1);
  });

  test("message after result+empty-queue starts a NEW query with resume", async () => {
    const [rm, h] = harness();
    rm.dispatch(msg({ mentionsBot: true, text: "first" }));
    const call1 = await h.calls.at(1);
    call1.emit(init("s1"));
    await call1.fed.at(1);
    call1.emit(success("ok"));
    await h.slack.posts.at(2); // run 1 fully finished
    h.sessionInfo.add("s1"); // run 1's session now exists on disk
    rm.dispatch(msg({ ts: "110", text: "next" }));
    const call2 = await h.calls.at(2);
    expect(call2.options.resume).toBe("s1");
    expect(userText(await call2.fed.at(1))).toBe("<@U1>: next");
  });

  test("fileNote is appended to the fed prompt", async () => {
    const [rm, h] = harness();
    rm.dispatch(msg({ mentionsBot: true, text: "look", fileNote: "(a file was attached but not ingested)" }));
    const call = await h.calls.at(1);
    expect(userText(await call.fed.at(1))).toBe("<@U1>: look\n(a file was attached but not ingested)");
  });
});

describe("model token policy", () => {
  test("alias switch persists and is used by the next Run's options.model", async () => {
    const [rm, h] = harness();
    rm.dispatch(msg({ mentionsBot: true, text: "[opus] do it" }));
    const call = await h.calls.at(1);
    expect(h.store.get("C1", "100")!.model).toBe("opus");
    expect(call.options.model).toBe("claude-opus");
    expect(userText(await call.fed.at(1))).toBe("<@U1>: do it");
  });

  test("bare alias posts confirmation and never calls queryFn", async () => {
    const [rm, h] = harness();
    rm.dispatch(msg({ mentionsBot: true, text: "[opus]" }));
    const posted = await h.slack.posts.at(1);
    expect(posted.text).toBe("switched to opus");
    expect(h.store.get("C1", "100")!.model).toBe("opus");
    expect(h.calls.items.length).toBe(0);
  });

  test("unknown token runs with the full original text", async () => {
    const [rm, h] = harness();
    rm.dispatch(msg({ mentionsBot: true, text: "[WIP] fix the tests" }));
    const call = await h.calls.at(1);
    expect(userText(await call.fed.at(1))).toBe("<@U1>: [WIP] fix the tests");
  });

  test("model token in an untracked non-mention Slack thread has no side effects", async () => {
    const [rm, h] = harness();
    rm.dispatch(msg({ mentionsBot: false, threadTs: "100", ts: "101", text: "[opus] do it" }));
    await Promise.resolve();
    expect(h.store.get("C1", "100")).toBeUndefined();
    expect(h.slack.posts.items.length).toBe(0);
    expect(h.calls.items.length).toBe(0);
  });

  test("[models] lists aliases + resolution and never calls queryFn", async () => {
    const [rm, h] = harness();
    rm.dispatch(msg({ mentionsBot: true, text: "[models]" }));
    const posted = await h.slack.posts.at(1);
    expect(posted.text).toContain("sonnet, opus");
    expect(posted.text).toContain("this conversation:");
    expect(h.calls.items.length).toBe(0);
  });

  test("[models] reports the channel default as the current resolution", async () => {
    const [rm, h] = harness({ channelModel: "opus" });
    rm.dispatch(msg({ mentionsBot: true, text: "[models]" }));
    const posted = await h.slack.posts.at(1);
    expect(posted.text).toContain("this conversation: opus");
    expect(h.calls.items.length).toBe(0);
  });

  test("[models] posts the channel config error instead of silently dropping", async () => {
    const [rm, h] = harness({ ctxThrows: "bad config: repo missing" });
    rm.dispatch(msg({ mentionsBot: true, text: "[models]" }));
    const posted = await h.slack.posts.at(1);
    expect(posted.text).toContain("bad config: repo missing");
    expect(h.calls.items.length).toBe(0);
  });

  test("stale persisted alias warns once, clears override, resolves to default", async () => {
    const [rm, h] = harness({
      seed: [{ channelId: "C1", threadKey: "100", sessionId: "s-known", model: "gone", activeStatusTs: null, updatedAt: 0 }],
    });
    rm.dispatch(msg({ text: "go" }));
    const call = await h.calls.at(1);
    expect(call.options.model).toBe("claude-sonnet");
    expect(h.store.get("C1", "100")!.model).toBeNull();
    const warned = await h.slack.posts.at(1);
    expect(warned.text).toContain('"gone" no longer exists');
  });
});

describe("resume pre-check + config errors", () => {
  test("lost session clears row and prefixes notice; no resume option", async () => {
    const [rm, h] = harness({
      seed: [{ channelId: "C1", threadKey: "100", sessionId: "s-lost", model: null, activeStatusTs: null, updatedAt: 0 }],
    });
    rm.dispatch(msg({ text: "hi again" }));
    const call = await h.calls.at(1);
    expect(call.options.resume).toBeUndefined();
    expect(h.store.get("C1", "100")!.sessionId).toBeNull();
    expect(userText(await call.fed.at(1))).toBe("(previous session lost; starting fresh)\n<@U1>: hi again");
  });

  test("loadChannelContext throw posts error in-thread and never calls queryFn", async () => {
    const [rm, h] = harness({ ctxThrows: "bad config: repo missing" });
    rm.dispatch(msg({ mentionsBot: true, threadTs: "100", ts: "101" }));
    const posted = await h.slack.posts.at(1);
    expect(posted.text).toContain("bad config: repo missing");
    expect(posted.threadTs).toBe("100");
    expect(h.calls.items.length).toBe(0);
  });
});

  test("non-fatal channel config warnings are logged", async () => {
    const originalLog = console.log;
    const lines: string[] = [];
    console.log = mock((line: string) => lines.push(line));
    try {
      const [rm, h] = harness({ warnings: ['Unknown channel config key "extra"'] });
      rm.dispatch(msg({ mentionsBot: true }));
      await h.calls.at(1);
      expect(lines.map((line) => JSON.parse(line))).toContainEqual(expect.objectContaining({
        event: "channel_config_warning",
        channelId: "C1",
        warning: 'Unknown channel config key "extra"',
      }));
    } finally {
      console.log = originalLog;
    }
  });

describe("results + observability", () => {
  test("error result subtype posts errors + resume hint; status finalized ⛔", async () => {
    const [rm, h] = harness();
    rm.dispatch(msg({ mentionsBot: true }));
    const call = await h.calls.at(1);
    call.emit(init("s1"));
    await h.slack.posts.at(1);
    call.emit(errorResult(["turn limit reached"]));
    const posted = await h.slack.posts.at(2);
    expect(posted.text).toContain("turn limit reached");
    expect(posted.text).toContain("reply to continue from the last completed state");
    const final = await h.slack.updates.at(1);
    expect(final.text).toContain("⛔");
    await until(() => h.store.get("C1", "100")!.activeStatusTs === null);
  });

  test("keeps active status durable when successful status deletion fails", async () => {
    const [rm, h] = harness();
    rm.dispatch(msg({ mentionsBot: true }));
    const call = await h.calls.at(1);
    call.emit(init("s1"));
    await h.slack.posts.at(1);
    await until(() => h.store.get("C1", "100")!.activeStatusTs === "ts1");
    h.deps.slack.deleteMessage = async () => { throw new Error("Slack unavailable"); };

    call.emit(success("done"));
    await h.slack.posts.at(2);
    await until(() => h.calls.items.length === 1 && h.store.get("C1", "100")!.activeStatusTs === "ts1");

    expect(h.store.get("C1", "100")!.activeStatusTs).toBe("ts1");
  });

  test("empty success text posts '(no text output)'", async () => {
    const [rm, h] = harness();
    rm.dispatch(msg({ mentionsBot: true }));
    const call = await h.calls.at(1);
    call.emit(init("s1"));
    call.emit(success(""));
    await h.slack.posts.at(1);
    const second = await h.slack.posts.at(2);
    expect(second.text).toBe("(no text output)");
  });

  test(">4000-char result goes through uploadTextFile", async () => {
    const [rm, h] = harness();
    rm.dispatch(msg({ mentionsBot: true, threadTs: "100", ts: "101" }));
    const call = await h.calls.at(1);
    call.emit(init("s1"));
    call.emit(success("x".repeat(4001)));
    const upload = await h.slack.uploads.at(1);
    expect(upload.content.length).toBe(4001);
    expect(upload.threadTs).toBe("100");
  });

  test("tool use updates status line and fires curation after the Run", async () => {
    const [rm, h] = harness();
    rm.dispatch(msg({ mentionsBot: true }));
    const call = await h.calls.at(1);
    call.emit(init("s1"));
    await h.slack.posts.at(1);
    call.emit(toolUse("Read", { file_path: "/repo/a/x.ts" }));
    const update = await h.slack.updates.at(1);
    expect(update.text).toContain("Read /repo/a/x.ts");
    call.emit(success("done"));
    const cur = await h.curations.at(1);
    expect(cur).toEqual({ sessionId: "s1", channelDir: "/data/C1", model: "haiku" });
  });

  test("no tool use → no curation", async () => {
    const [rm, h] = harness();
    rm.dispatch(msg({ mentionsBot: true }));
    const call = await h.calls.at(1);
    call.emit(init("s1"));
    call.emit(success("done"));
    await h.slack.posts.at(2);
    expect(h.curations.items.length).toBe(0);
  });
});

describe("watchdog + stop + sweeps", () => {
  test("watchdog aborts a silent run and posts the error path", async () => {
    const [rm, h] = harness({ stallMs: 10 });
    rm.dispatch(msg({ mentionsBot: true }));
    const call = await h.calls.at(1);
    call.emit(init("s1"));
    await h.slack.posts.at(1);
    // then silence: watchdog (10ms) aborts; we await the resulting error post, not a sleep
    const posted = await h.slack.posts.at(2);
    expect(posted.text).toContain("aborted by controller");
    await until(() => h.store.get("C1", "100")!.activeStatusTs === null);
    expect(h.store.get("C1", "100")!.activeStatusTs).toBeNull();
    expect(h.store.get("C1", "100")!.sessionId).toBe("s1"); // row untouched — resume stays valid
  });

  test("stream activity resets the watchdog instead of counting from run start", async () => {
    vi.useFakeTimers();
    try {
      const [rm, h] = harness({ stallMs: 60_000 });
      rm.dispatch(msg({ mentionsBot: true }));
      const call = await h.calls.at(1);
      call.emit(init("s1"));
      await until(() => h.store.get("C1", "100")?.sessionId === "s1"); // init consumed → watchdog reset

      vi.advanceTimersByTime(30_000);
      call.emit(toolUse("Read", { file_path: "/repo/a/x.ts" }));
      await h.slack.updates.at(1); // tool_use consumed → watchdog reset again
      vi.advanceTimersByTime(40_000); // 70s since start, 40s since last message: must NOT abort

      call.emit(success("survived"));
      const posted = await h.slack.posts.at(2);
      expect(posted.text).toBe("survived");
    } finally {
      vi.useRealTimers();
    }
  });

  test("stop: first click interrupts, second aborts, idle otherwise", async () => {
    const [rm, h] = harness();
    expect(await rm.stop("C1", "100")).toBe("idle");
    rm.dispatch(msg({ mentionsBot: true }));
    const call = await h.calls.at(1);
    call.emit(init("s1"));
    await h.slack.posts.at(1);
    expect(await rm.stop("C1", "100")).toBe("interrupted");
    expect(call.interruptCalls).toBe(1);
    expect(await rm.stop("C1", "100")).toBe("aborted");
    const errPost = await h.slack.posts.at(2);
    expect(errPost.text).toContain("aborted");
    await until(() => h.store.get("C1", "100")!.activeStatusTs === null);
    expect(h.store.get("C1", "100")!.sessionId).toBe("s1"); // abort keeps the row: resume stays valid
  });

  test("stream ending without a result finalizes the status as interrupted", async () => {
    const [rm, h] = harness();
    rm.dispatch(msg({ mentionsBot: true }));
    const call = await h.calls.at(1);
    call.emit(init("s1"));
    await h.slack.posts.at(1);
    call.end();
    const update = await h.slack.updates.at(1);
    expect(update.text).toBe("⛔ interrupted — reply to resume");
    await until(() => h.store.get("C1", "100")!.activeStatusTs === null);
  });

  test("bootSweep marks orphaned status messages and clears the field", async () => {
    const [rm, h] = harness({
      seed: [{ channelId: "C1", threadKey: "100", sessionId: "s1", model: null, activeStatusTs: "ts-old", updatedAt: 0 }],
    });
    await rm.bootSweep();
    const upd = await h.slack.updates.at(1);
    expect(upd).toMatchObject({ channel: "C1", ts: "ts-old", text: "interrupted by restart — reply to resume" });
    expect(h.store.get("C1", "100")!.activeStatusTs).toBeNull();
  });

  test("bootSweep retains the durable status when Slack update fails", async () => {
    const [rm, h] = harness({
      seed: [{ channelId: "C1", threadKey: "100", sessionId: "s1", model: null, activeStatusTs: "ts-old", updatedAt: 0 }],
    });
    h.deps.slack.updateMessage = async () => { throw new Error("Slack unavailable"); };

    await rm.bootSweep();

    expect(h.store.get("C1", "100")!.activeStatusTs).toBe("ts-old");
  });

  test("shutdown aborts live runs and marks their status interrupted", async () => {
    const [rm, h] = harness();
    rm.dispatch(msg({ mentionsBot: true }));
    const call = await h.calls.at(1);
    call.emit(init("s1"));
    await h.slack.posts.at(1);
    await until(() => h.store.get("C1", "100")?.activeStatusTs !== null);

    await rm.shutdown();

    expect((call.options.abortController as AbortController).signal.aborted).toBeTrue();

    const update = await h.slack.updates.at(1);
    expect(update).toMatchObject({
      channel: "C1",
      text: "interrupted by restart — reply to resume",
    });
    expect(h.store.get("C1", "100")!.activeStatusTs).toBeNull();
  });
  test("status message carries a Stop button with thread coordinates", async () => {
    const [rm, h] = harness();
    rm.dispatch(msg({ mentionsBot: true }));
    const call = await h.calls.at(1);
    call.emit(init("s1"));
    const status = await h.slack.posts.at(1);

    const blocks = status.blocks as Array<{ type: string; elements?: Array<{ action_id: string; value: string }> }>;
    const button = blocks.find((b) => b.type === "actions")?.elements?.[0];
    if (!button) throw new Error("no stop button in status blocks");
    expect(button.action_id).toBe("stop");
    expect(JSON.parse(button.value)).toEqual({ channelId: "C1", threadKey: "100" });
  });
});

describe("provider failure safety", () => {
  test("model token reload failures are posted instead of disappearing", async () => {
    const [rm, h] = harness({ loadModelsError: "models.json broken" });
    rm.dispatch(msg({ mentionsBot: true, text: "[terra] go" }));
    const posted = await h.slack.posts.at(1);
    expect(posted.text).toBe("⚠️ models.json broken");
    expect(h.calls.items.length).toBe(0);
  });

  test("run errors and SDK stderr redact provider credentials", async () => {
    const originalLog = console.log;
    const lines: string[] = [];
    console.log = mock((line: string) => { lines.push(line); });
    const [rm, h] = harness();
    h.deps.queryFn = (({ options }: { options?: Record<string, unknown> }) => {
      (options?.stderr as (data: string) => void)("Authorization: Bearer proxy-secret");
      throw new Error("ANTHROPIC_AUTH_TOKEN=proxy-secret-123");
    }) as RunDeps["queryFn"];
    try {
      rm.dispatch(msg({ mentionsBot: true }));
      const status = await h.slack.posts.at(1);
      expect(status.text).toBe("⏳ working…");
      const posted = await h.slack.posts.at(2);
      expect(posted.text).toBe("⚠️ ANTHROPIC_AUTH_TOKEN=[REDACTED]");
      expect(lines.join("\n")).not.toContain("proxy-secret");
      expect(lines.join("\n")).toContain("[REDACTED]");
    } finally {
      console.log = originalLog;
    }
  });

  test("missing haiku skips curation instead of using the main provider", async () => {
    const models: ModelsConfig = { default: "terra", aliases: { terra: { model: "gpt-5.6-terra", providerProfile: "vibeproxy" } } };
    const [rm, h] = harness({
      models,
      providers: { default: "vibeproxy", profiles: { vibeproxy: { mode: "proxy", env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317", ANTHROPIC_AUTH_TOKEN: "dummy" } } } },
    });
    rm.dispatch(msg({ mentionsBot: true }));
    const call = await h.calls.at(1);
    call.emit(init("s1"));
    call.emit(toolUse("Read", { file_path: "/repo/a/x.ts" }));
    call.emit(success("done"));
    await h.slack.posts.at(2);
    expect(h.curations.items.length).toBe(0);
  });
});

describe("options assembly", () => {
  test("env spreads process.env plus alias env; core options per spec", async () => {
    const previous = process.env.RUNS_TEST_MARKER;
    process.env.RUNS_TEST_MARKER = "yes";
    try {
      const [rm, h] = harness();
      rm.dispatch(msg({ mentionsBot: true, text: "[opus] go" }));
      const call = await h.calls.at(1);
      const env = call.options.env as Record<string, string>;
      expect(env.RUNS_TEST_MARKER).toBe("yes");
      expect(env.ANTHROPIC_BASE_URL).toBe("http://opus.local");
      expect(call.options.cwd).toBe("/data/C1/workspace");
      expect(call.options.additionalDirectories).toEqual(["/repo/a", "/Users/jaredsmith/Projects"]);
      expect(call.options.systemPrompt).toEqual({ type: "preset", preset: "claude_code", append: "APPEND" });
      expect(call.options.maxBudgetUsd).toBe(5);
      expect(call.options.disallowedTools).toEqual(["Bash(rm -rf:*)"]);
      expect(call.options.allowedTools).toEqual(["Bash(*)"]);
      expect(call.options.additionalDirectories).toContain("/Users/jaredsmith/Projects");
      expect(call.options.settingSources).toEqual([]);
      expect(call.options.strictMcpConfig).toBe(true);
      const hooks = call.options.hooks as {
        PreToolUse?: Array<{ matcher?: string; hooks: unknown[]; timeout?: number }>;
      };
      expect(hooks.PreToolUse).toHaveLength(1);
      expect(hooks.PreToolUse?.[0]?.matcher).toBe("Bash");
      expect(hooks.PreToolUse?.[0]?.hooks).toHaveLength(1);
    } finally {
      if (previous === undefined) delete process.env.RUNS_TEST_MARKER;
      else process.env.RUNS_TEST_MARKER = previous;
    }
  });

  test("DCG hook allows safe Bash and denies destructive Git", async () => {
    const [rm, h] = harness();
    rm.dispatch(msg({ mentionsBot: true }));
    const call = await h.calls.at(1);
    const hooks = call.options.hooks as {
      PreToolUse: Array<{
        hooks: Array<(input: unknown, toolUseId: string | undefined, options: { signal: AbortSignal }) => Promise<unknown>>;
      }>;
    };
    const hook = hooks.PreToolUse[0]!.hooks[0]!;
    const base = {
      session_id: "test-session",
      transcript_path: "/tmp/slackbot-dcg-test.jsonl",
      cwd: process.cwd(),
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_use_id: "tool-1",
    };

    expect(await hook({ ...base, tool_input: { command: "git status" } }, "tool-1", { signal: AbortSignal.timeout(5_000) })).toEqual({});
    const blocked = await hook(
      { ...base, tool_input: { command: "git reset --hard" } },
      "tool-1",
      { signal: AbortSignal.timeout(5_000) },
    ) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
    expect(blocked.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(blocked.hookSpecificOutput?.permissionDecisionReason).toContain("git reset --hard");
  });
  test("maps channel command prefixes to Bash allow rules", async () => {
    const [rm, h] = harness({ allowedCommands: ["pm2", "bun test"] });
    rm.dispatch(msg({ mentionsBot: true }));

    const call = await h.calls.at(1);

    expect(call.options.allowedTools).toEqual(["Bash(*)", "Bash(pm2:*)", "Bash(bun test:*)"]);
  });

  test("subscription provider removes API keys from the SDK environment", async () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "paid-key";
    try {
      const [rm, h] = harness({
        providers: { default: "subscription", profiles: { subscription: { mode: "claude-subscription" } } },
      });
      rm.dispatch(msg({ mentionsBot: true }));
      const call = await h.calls.at(1);
      const env = call.options.env as Record<string, string | undefined>;
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });

  test("model provider selects the VibeProxy profile", async () => {
    const models: ModelsConfig = {
      default: "terra",
      aliases: { terra: { model: "gpt-5.6-terra", providerProfile: "vibeproxy" } },
    };
    const [rm, h] = harness({
      models,
      providers: {
        default: "subscription",
        profiles: {
          subscription: { mode: "claude-subscription" },
          vibeproxy: { mode: "proxy", env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317", ANTHROPIC_AUTH_TOKEN: "dummy" } },
        },
      },
    });
    rm.dispatch(msg({ mentionsBot: true }));
    const call = await h.calls.at(1);
    const env = call.options.env as Record<string, string | undefined>;
    expect(call.options.model).toBe("gpt-5.6-terra");
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8317");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("dummy");
  });
  test("Fable Low uses VibeProxy with low SDK effort", async () => {
    const models: ModelsConfig = {
      default: "fable-low",
      aliases: {
        "fable-low": { model: "claude-fable-5", effort: "low", providerProfile: "vibeproxy" },
      },
    };
    const [rm, h] = harness({
      models,
      providers: {
        default: "subscription",
        profiles: {
          subscription: { mode: "claude-subscription" },
          vibeproxy: { mode: "proxy", env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317", ANTHROPIC_AUTH_TOKEN: "dummy" } },
        },
      },
    });
    rm.dispatch(msg({ mentionsBot: true }));
    const call = await h.calls.at(1);
    expect(call.options.model).toBe("claude-fable-5");
    expect(call.options.effort).toBe("low");
  });
});
