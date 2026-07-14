import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { query } from "@anthropic-ai/claude-agent-sdk";
import { createCurator } from "../src/memory.ts";
import type { ModelAlias, ProvidersConfig } from "../src/types.ts";

interface QueryCapture {
  prompt: unknown;
  options: unknown;
}

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

interface RegisteredTool {
  handler(args: Record<string, string>, extra: unknown): Promise<ToolResult>;
}

interface MemoryServer {
  instance: { _registeredTools: Record<string, RegisteredTool> };
}

const dirs: string[] = [];
const HAIKU: ModelAlias = { model: "haiku" };
const PROVIDERS: ProvidersConfig = { default: "test", profiles: { test: { mode: "api-key", env: { ANTHROPIC_API_KEY: "test-key" } } } };
const loadProviders = () => PROVIDERS;

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function channelDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "slackbot-memory-"));
  dirs.push(dir);
  return dir;
}

function emptyStream() {
  return (async function* () {})();
}

function memoryServer(capture: QueryCapture): MemoryServer {
  const options = capture.options as { mcpServers: { memory: unknown } };
  return options.mcpServers.memory as MemoryServer;
}

describe("createCurator", () => {
  test("uses the isolated curation query configuration", async () => {
    const dir = await channelDir();
    await writeFile(join(dir, "MEMORY.md"), "é\n");
    const captures: QueryCapture[] = [];
    const queryFn = ((params: QueryCapture) => {
      captures.push(params);
      return emptyStream();
    }) as unknown as typeof query;

    await createCurator(queryFn, loadProviders)({ sessionId: "session-1", channelDir: dir }, HAIKU);

    expect(captures).toHaveLength(1);
    expect(captures[0]?.prompt).toBe(
      "Persist only what survives this conversation: durable facts, decisions, operator preferences, and repo gotchas; not task minutiae. MEMORY.md is currently 3 bytes. Consolidate with memory_replace when it exceeds 8KB.",
    );
    const options = captures[0]?.options as Record<string, unknown>;
    const { mcpServers, env, ...staticOptions } = options;
    expect(env).toEqual(expect.objectContaining({ PATH: expect.any(String) }));
    expect(staticOptions).toEqual({
      cwd: join(dir, "workspace"),
      resume: "session-1",
      forkSession: true,
      persistSession: false,
      model: "haiku",
      maxTurns: 4,
      systemPrompt:
        "Persist only durable facts, decisions, operator preferences, and repo gotchas; never task minutiae. Use memory_append for new durable entries. When MEMORY.md exceeds 8192 bytes, consolidate it with memory_replace.",
      settingSources: [],
      skills: [],
      tools: [],
      allowedTools: ["mcp__memory__memory_append", "mcp__memory__memory_replace"],
      permissionMode: "dontAsk",
      strictMcpConfig: true,
    });
    expect(mcpServers).toEqual({ memory: expect.objectContaining({ type: "sdk", name: "memory" }) });
  });

  test("appends dated memory entries and retains a final newline", async () => {
    const dir = await channelDir();
    const captures: QueryCapture[] = [];
    const queryFn = ((params: QueryCapture) => {
      captures.push(params);
      return emptyStream();
    }) as unknown as typeof query;

    await createCurator(queryFn, loadProviders)({ sessionId: "session-1", channelDir: dir }, HAIKU);
    const append = memoryServer(captures[0]!).instance._registeredTools.memory_append!.handler;
    await append({ text: "First durable fact" }, undefined);
    await append({ text: "Second durable fact" }, undefined);

    const content = await readFile(join(dir, "MEMORY.md"), "utf8");
    expect(content).toMatch(
      /^- \[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] First durable fact\n- \[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] Second durable fact\n$/,
    );
  });

  test("replaces existing memory exactly", async () => {
    const dir = await channelDir();
    await writeFile(join(dir, "MEMORY.md"), "Keep old decision\n");
    const captures: QueryCapture[] = [];
    const queryFn = ((params: QueryCapture) => {
      captures.push(params);
      return emptyStream();
    }) as unknown as typeof query;

    await createCurator(queryFn, loadProviders)({ sessionId: "session-1", channelDir: dir }, HAIKU);
    const replace = memoryServer(captures[0]!).instance._registeredTools.memory_replace!.handler;
    await replace({ old: "old", new: "new" }, undefined);

    expect(await readFile(join(dir, "MEMORY.md"), "utf8")).toBe("Keep new decision\n");
  });

  test("reports a missing replacement without modifying memory", async () => {
    const dir = await channelDir();
    const path = join(dir, "MEMORY.md");
    await writeFile(path, "Retain this entry\n");
    const captures: QueryCapture[] = [];
    const queryFn = ((params: QueryCapture) => {
      captures.push(params);
      return emptyStream();
    }) as unknown as typeof query;

    await createCurator(queryFn, loadProviders)({ sessionId: "session-1", channelDir: dir }, HAIKU);
    const replace = memoryServer(captures[0]!).instance._registeredTools.memory_replace!.handler;
    const result = await replace({ old: "missing", new: "replacement" }, undefined);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("not found");
    expect(await readFile(path, "utf8")).toBe("Retain this entry\n");
  });

  test("serializes curations for one channel directory", async () => {
    const dir = await channelDir();
    const events: string[] = [];
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const queryFn = ((params: { options?: { resume?: string } }) =>
      (async function* () {
        const sessionId = params.options?.resume!;
        events.push(`${sessionId}:start`);
        if (sessionId === "first") {
          markFirstStarted();
          await firstGate;
        }
        events.push(`${sessionId}:finish`);
      })()) as unknown as typeof query;
    const curate = createCurator(queryFn, loadProviders);

    const first = curate({ sessionId: "first", channelDir: dir }, HAIKU);
    await firstStarted;
    const second = curate({ sessionId: "second", channelDir: dir }, HAIKU);
    await Promise.resolve();
    expect(events).toEqual(["first:start"]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:finish", "second:start", "second:finish"]);
  });

  test("allows curations for different channel directories to overlap", async () => {
    const firstDir = await channelDir();
    const secondDir = await channelDir();
    const events: string[] = [];
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    let markFirstStarted!: () => void;
    let markSecondStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const secondStarted = new Promise<void>((resolve) => {
      markSecondStarted = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const queryFn = ((params: { options?: { resume?: string } }) =>
      (async function* () {
        const sessionId = params.options?.resume!;
        events.push(`${sessionId}:start`);
        if (sessionId === "first") {
          markFirstStarted();
          await firstGate;
        } else {
          markSecondStarted();
          await secondGate;
        }
        events.push(`${sessionId}:finish`);
      })()) as unknown as typeof query;
    const curate = createCurator(queryFn, loadProviders);

    const first = curate({ sessionId: "first", channelDir: firstDir }, HAIKU);
    const second = curate({ sessionId: "second", channelDir: secondDir }, HAIKU);
    await Promise.all([firstStarted, secondStarted]);
    expect(events).toEqual(expect.arrayContaining(["first:start", "second:start"]));

    releaseFirst();
    releaseSecond();
    await Promise.all([first, second]);
  });

  test("logs query failures and resolves", async () => {
    const dir = await channelDir();
    const logSpy = mock((_line: string) => {});
    const originalLog = console.log;
    console.log = logSpy;
    const queryFn = (() => {
      throw new Error("curation query failed");
    }) as unknown as typeof query;

    try {
      await expect(createCurator(queryFn, loadProviders)({ sessionId: "session-1", channelDir: dir }, HAIKU)).resolves.toBeUndefined();
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(JSON.parse(logSpy.mock.calls[0]![0])).toMatchObject({
        event: "curation_error",
        channelDir: dir,
        error: "curation query failed",
      });
    } finally {
      console.log = originalLog;
    }
  });
});
