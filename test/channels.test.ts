import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { SlackPort } from "../src/types.ts";
import { createChannelContextLoader, loadModels, loadProviders, parseLeadingToken, resolveModel } from "../src/channels.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function modelFile(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "slackbot-channels-"));
  tempDirs.push(dir);
  const path = join(dir, "models.json");
  await writeFile(path, contents);
  return path;
}

async function dataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "slackbot-data-"));
  tempDirs.push(dir);
  return dir;
}

function fakeSlack(channelName: string | undefined = "engineering") {
  let nameCalls = 0;
  const slack: SlackPort = {
    postMessage: async () => ({ ts: "1" }),
    updateMessage: async () => {},
    deleteMessage: async () => {},
    uploadTextFile: async () => {},
    fetchThreadReplies: async () => [],
    fetchChannelName: async () => {
      nameCalls++;
      return channelName;
    },
  };
  return { slack, get nameCalls() { return nameCalls; } };
}

async function channelFiles(root: string, channelId: string, config: unknown): Promise<string> {
  const dir = join(root, "channels", channelId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "config.json"), typeof config === "string" ? config : JSON.stringify(config));
  return dir;
}

describe("loadModels", () => {
  test("loads aliases and preserves provider env", async () => {
    const path = await modelFile(JSON.stringify({
      default: "sonnet",
      aliases: {
        sonnet: { model: "sonnet" },
        ds4: { model: "deepseek", env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8000" } },
      },
    }));

    expect(loadModels(path)).toEqual({
      default: "sonnet",
      aliases: {
        sonnet: { model: "sonnet" },
        ds4: { model: "deepseek", env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8000" } },
      },
    });
  });
  test("loads a supported model effort and rejects unknown effort", async () => {
    const valid = await modelFile(JSON.stringify({
      default: "fable-low",
      aliases: { "fable-low": { model: "claude-fable-5", effort: "low", providerProfile: "vibeproxy" } },
    }));
    expect(loadModels(valid).aliases["fable-low"]?.effort).toBe("low");

    const invalid = await modelFile(JSON.stringify({
      default: "fable",
      aliases: { fable: { model: "claude-fable-5", effort: "tiny" } },
    }));
    expect(() => loadModels(invalid)).toThrow("effort must be low, medium, high, xhigh, or max");
  });

  test("rejects unparseable JSON with the file path", async () => {
    const path = await modelFile("{");
    expect(() => loadModels(path)).toThrow(`Unable to parse models file ${path}`);
  });

  test("rejects a missing default", async () => {
    const path = await modelFile(JSON.stringify({ aliases: { sonnet: { model: "sonnet" } } }));
    expect(() => loadModels(path)).toThrow("default");
  });

  test("rejects a default that is not an alias", async () => {
    const path = await modelFile(JSON.stringify({
      default: "opus",
      aliases: { sonnet: { model: "sonnet" } },
    }));
    expect(() => loadModels(path)).toThrow('default alias "opus"');
  });

  test("rejects aliases without string models", async () => {
    const path = await modelFile(JSON.stringify({
      default: "opus",
      aliases: { opus: { model: 42 } },
    }));
    expect(() => loadModels(path)).toThrow('alias "opus"');
  });

  test("rejects a non-object aliases value", async () => {
    const path = await modelFile(JSON.stringify({ default: "sonnet", aliases: [] }));
    expect(() => loadModels(path)).toThrow("aliases must be an object");
  });

  test("rejects a default alias entry that is not an object", async () => {
    const path = await modelFile(JSON.stringify({ default: "sonnet", aliases: { sonnet: "sonnet" } }));
    expect(() => loadModels(path)).toThrow('alias "sonnet"');
  });

  test("rejects non-string alias env values", async () => {
    const path = await modelFile(JSON.stringify({
      default: "sonnet",
      aliases: { sonnet: { model: "sonnet", env: { PORT: 8000 } } },
    }));
    expect(() => loadModels(path)).toThrow('alias "sonnet" env');
  });
});

describe("loadProviders", () => {
  test("loads subscription, API-key, and proxy profiles", async () => {
    const path = await modelFile(JSON.stringify({
      default: "subscription",
      profiles: {
        subscription: { mode: "claude-subscription" },
        api: { mode: "api-key" },
        proxy: { mode: "proxy", env: { ANTHROPIC_BASE_URL: "http://localhost:8317" } },
      },
    }));

    expect(loadProviders(path)).toMatchObject({ default: "subscription" });
  });

  test("rejects an unknown mode, incomplete proxy, or missing default profile", async () => {
    const badMode = await modelFile(JSON.stringify({
      default: "bad",
      profiles: { bad: { mode: "oauth-file" } },
    }));
    expect(() => loadProviders(badMode)).toThrow("unknown mode");

    const badProxy = await modelFile(JSON.stringify({
      default: "proxy",
      profiles: { proxy: { mode: "proxy" } },
    }));
    expect(() => loadProviders(badProxy)).toThrow("requires env.ANTHROPIC_BASE_URL");

    const badDefault = await modelFile(JSON.stringify({
      default: "missing",
      profiles: { subscription: { mode: "claude-subscription" } },
    }));
    expect(() => loadProviders(badDefault)).toThrow("default profile");
  });
});

describe("resolveModel", () => {
  const models = {
    default: "sonnet",
    aliases: {
      sonnet: { model: "claude-sonnet" },
      opus: { model: "claude-opus", env: { PROVIDER: "anthropic" } },
      haiku: { model: "claude-haiku" },
    },
  };

  test("uses thread override before channel and default", () => {
    expect(resolveModel(models, "opus", "haiku")).toEqual({
      alias: "opus",
      model: "claude-opus",
      env: { PROVIDER: "anthropic" },
    });
  });


  test("uses channel alias when there is no thread override", () => {
    expect(resolveModel(models, null, "haiku")).toEqual({ alias: "haiku", model: "claude-haiku" });
  });

  test("uses the default without overrides", () => {
    expect(resolveModel(models, null)).toEqual({ alias: "sonnet", model: "claude-sonnet" });
  });

  test("marks a removed thread alias stale and otherwise resolves normally", () => {
    expect(resolveModel(models, "removed", "haiku")).toEqual({
      alias: "haiku",
      model: "claude-haiku",
      staleThreadAlias: "removed",
    });
  });

  test("treats a removed channel alias as config drift and falls to default", () => {
    expect(resolveModel(models, null, "removed")).toEqual({ alias: "sonnet", model: "claude-sonnet" });
  });

  test("falls to default and marks stale when both persisted aliases drift", () => {
    expect(resolveModel(models, "removed-thread", "removed-channel")).toEqual({
      alias: "sonnet",
      model: "claude-sonnet",
      staleThreadAlias: "removed-thread",
    });
  });
});

describe("parseLeadingToken", () => {
  test.each([
    ["[Opus] do x", { token: "opus", rest: "do x" }],
    ["[WIP] fix tests", { token: "wip", rest: "fix tests" }],
    ["plain", { token: null, rest: "plain" }],
    ["[models]", { token: "models", rest: "" }],
    ["[opus]", { token: "opus", rest: "" }],
    ["  [HaIkU]   do y  ", { token: "haiku", rest: "do y" }],
    ["[Fable-Low] go", { token: "fable-low", rest: "go" }],
  ])("parses %s", (text, expected) => {
    expect(parseLeadingToken(text)).toEqual(expected);
  });

  test("keeps the original text when no leading word token exists", () => {
    expect(parseLeadingToken("  plain  ")).toEqual({ token: null, rest: "  plain  " });
    expect(parseLeadingToken("[not a word] text")).toEqual({ token: null, rest: "[not a word] text" });
  });
});

describe("createChannelContextLoader", () => {
  test("auto-creates an unknown channel with empty config and workspace", async () => {
    const root = await dataDir();
    const fake = fakeSlack(undefined);
    const context = await createChannelContextLoader(fake.slack, root, join(root, "permissions.json"))("D123", "D123");

    expect(context.channelDir).toBe(join(root, "channels", "D123"));
    expect(context.workspaceDir).toBe(join(context.channelDir, "workspace"));
    expect(context.config).toEqual({ repos: [], allowedCommands: [], permissionMode: "default" });
    expect(await readFile(join(context.channelDir, "config.json"), "utf8")).toBe("{}");
    expect(context.systemPromptAppend).toContain("D123");
    expect(context.systemPromptAppend).toContain("no repos configured");
  });

  test("rejects unparseable channel config with a useful path", async () => {
    const root = await dataDir();
    const dir = await channelFiles(root, "CBADJSON", "{");
    await expect(createChannelContextLoader(fakeSlack().slack, root, join(root, "permissions.json"))("CBADJSON", "thread"))
      .rejects.toThrow(`Unable to parse channel config ${join(dir, "config.json")}`);
  });

  test("does not misreport unreadable config as a JSON parse error", async () => {
    const root = await dataDir();
    const dir = join(root, "channels", "CDIRECTORYCONFIG");
    await mkdir(join(dir, "config.json"), { recursive: true });

    await expect(createChannelContextLoader(fakeSlack().slack, root, join(root, "permissions.json"))("CDIRECTORYCONFIG", "thread"))
      .rejects.toThrow(`Unable to read channel config ${join(dir, "config.json")}`);
  });

  test("rejects invalid permission modes", async () => {
    const root = await dataDir();
    await channelFiles(root, "CBADMODE", { permissionMode: "dontAsk" });
    await expect(createChannelContextLoader(fakeSlack().slack, root, join(root, "permissions.json"))("CBADMODE", "thread"))
      .rejects.toThrow("permissionMode");
  });

  test("rejects nonexistent repos", async () => {
    const root = await dataDir();
    const missing = join(root, "missing-repo");
    await channelFiles(root, "CMISSING", { repos: [missing] });
    await expect(createChannelContextLoader(fakeSlack().slack, root, join(root, "permissions.json"))("CMISSING", "thread"))
      .rejects.toThrow(missing);
  });

  test("rejects regular files in repos", async () => {
    const root = await dataDir();
    const file = join(root, "not-a-repo");
    await writeFile(file, "plain file");
    await channelFiles(root, "CFILE", { repos: [file] });

    await expect(createChannelContextLoader(fakeSlack().slack, root, join(root, "permissions.json"))("CFILE", "thread"))
      .rejects.toThrow("must be a directory");
  });

  test("rejects malformed repos entries", async () => {
    const root = await dataDir();
    await channelFiles(root, "CBADREPOS", { repos: "not-an-array" });
    await expect(createChannelContextLoader(fakeSlack().slack, root, join(root, "permissions.json"))("CBADREPOS", "thread"))
      .rejects.toThrow("repos");
  });

  test("rejects malformed allowed command entries", async () => {
    const root = await dataDir();
    await channelFiles(root, "CBADCOMMANDS", { allowedCommands: ["pm2", 42] });
    await expect(createChannelContextLoader(fakeSlack().slack, root, join(root, "permissions.json"))("CBADCOMMANDS", "thread"))
      .rejects.toThrow("allowedCommands");
    await channelFiles(root, "CBLANKCOMMAND", { allowedCommands: ["pm2", "   "] });
    await expect(createChannelContextLoader(fakeSlack().slack, root, join(root, "permissions.json"))("CBLANKCOMMAND", "thread"))
      .rejects.toThrow("allowedCommands");
  });

  test("rejects non-object configs and non-string model aliases", async () => {
    const root = await dataDir();
    await channelFiles(root, "CARRAY", []);
    await expect(createChannelContextLoader(fakeSlack().slack, root, join(root, "permissions.json"))("CARRAY", "thread"))
      .rejects.toThrow("expected a JSON object");
    await channelFiles(root, "CBADMODEL", { model: 42 });
    await expect(createChannelContextLoader(fakeSlack().slack, root, join(root, "permissions.json"))("CBADMODEL", "thread"))
      .rejects.toThrow("model must be a string");
  });

  test("resolves relative repo paths from the channel directory", async () => {
    const root = await dataDir();
    const dir = await channelFiles(root, "CRELATIVE", { repos: ["repo"] });
    const repo = join(dir, "repo");
    await mkdir(repo);

    const context = await createChannelContextLoader(fakeSlack().slack, root, join(root, "permissions.json"))("CRELATIVE", "thread");

    expect(context.config.repos).toEqual([repo]);
  });

  test("loads allowed command prefixes into channel policy", async () => {
    const root = await dataDir();
    await channelFiles(root, "CCOMMANDS", { allowedCommands: ["pm2", "bun test"] });

    const context = await createChannelContextLoader(fakeSlack().slack, root, join(root, "permissions.json"))("CCOMMANDS", "thread");

    expect(context.config.allowedCommands).toEqual(["pm2", "bun test"]);
  });

  test("warns for unknown keys, expands home repos, and assembles the prompt", async () => {
    const root = await dataDir();
    const homeRepo = join(homedir(), `.slackbot-test-repo-${crypto.randomUUID()}`);
    await mkdir(homeRepo);
    tempDirs.push(homeRepo);
    const tildeRepo = `~/${homeRepo.slice(homedir().length + 1)}`;
    const dir = await channelFiles(root, "C123", {
      repos: [tildeRepo],
      model: "opus",
      permissionMode: "acceptEdits",
      surprise: true,
    });
    await writeFile(join(dir, "CHANNEL.md"), "Channel conventions");
    await writeFile(join(dir, "MEMORY.md"), "Curated memory");
    const fake = fakeSlack("build-team");
    const load = createChannelContextLoader(fake.slack, root, join(root, "permissions.json"));

    const first = await load("C123", "171.001");
    const second = await load("C123", "171.002");

    expect(first.config).toEqual({
      repos: [homeRepo],
      model: "opus",
      allowedCommands: [],
      permissionMode: "acceptEdits",
    });
    expect(isAbsolute(first.config.repos[0]!)).toBe(true);
    expect(first.warnings).toContain('Unknown channel config key "surprise"');
    expect(first.systemPromptAppend).toContain("build-team");
    expect(first.systemPromptAppend).toContain("C123");
    expect(first.systemPromptAppend).toContain("171.001");
    expect(first.systemPromptAppend).toContain(homeRepo);
    expect(first.systemPromptAppend).toContain("Slack mrkdwn");
    const append = first.systemPromptAppend;
    expect(append.indexOf("--- SLACK CONTEXT ---")).toBeLessThan(append.indexOf("--- REPOSITORIES ---"));
    expect(append.indexOf("--- REPOSITORIES ---")).toBeLessThan(append.indexOf("--- RESPONSE FORMAT ---"));
    expect(append.indexOf("--- RESPONSE FORMAT ---")).toBeLessThan(append.indexOf("--- CHANNEL.md ---"));
    expect(append.indexOf("--- CHANNEL.md ---")).toBeLessThan(append.indexOf("--- MEMORY.md ---"));
    expect(first.systemPromptAppend).toContain("Channel conventions");
    expect(first.systemPromptAppend).toContain("Curated memory");
    expect(second.systemPromptAppend).toContain("171.002");
    expect(fake.nameCalls).toBe(1);
  });

  test("shares the channel-name cache across loader instances", async () => {
    const root = await dataDir();
    const channelId = `CCACHE-${crypto.randomUUID()}`;
    await channelFiles(root, channelId, {});
    const fake = fakeSlack("cached-name");

    await createChannelContextLoader(fake.slack, root, join(root, "permissions.json"))(channelId, "first");
    await createChannelContextLoader(fake.slack, root, join(root, "permissions.json"))(channelId, "second");

    expect(fake.nameCalls).toBe(1);
  });

  test("retries channel-name lookup after a failed request", async () => {
    const root = await dataDir();
    const channelId = `CRETRY-${crypto.randomUUID()}`;
    await channelFiles(root, channelId, {});
    let calls = 0;
    const fake = fakeSlack("recovered");
    fake.slack.fetchChannelName = async () => {
      calls++;
      if (calls === 1) throw new Error("Slack unavailable");
      return "recovered";
    };
    const load = createChannelContextLoader(fake.slack, root, join(root, "permissions.json"));

    await expect(load(channelId, "first")).rejects.toThrow("Slack unavailable");
    expect((await load(channelId, "second")).systemPromptAppend).toContain("recovered");
    expect(calls).toBe(2);
  });

  test("tail-truncates MEMORY.md at 16KB and warns in context and prompt", async () => {
    const root = await dataDir();
    const dir = await channelFiles(root, "CLARGE", {});
    const head = "H".repeat(1024);
    const tail = "T".repeat(16 * 1024);
    await writeFile(join(dir, "MEMORY.md"), head + tail);

    const context = await createChannelContextLoader(fakeSlack().slack, root, join(root, "permissions.json"))("CLARGE", "thread");

    expect(context.warnings.some((warning) => warning.includes("truncated"))).toBe(true);
    expect(context.systemPromptAppend).toContain("MEMORY.md truncated");
    expect(context.systemPromptAppend).not.toContain(head);
    expect(context.systemPromptAppend).toContain(tail);
  });

  test("keeps a valid UTF-8 tail when truncating multibyte memory", async () => {
    const root = await dataDir();
    const dir = await channelFiles(root, "CUNICODE", {});
    const memory = "x".repeat(16 * 1024 - 2) + "🙂".repeat(4095);
    await writeFile(join(dir, "MEMORY.md"), memory);

    const context = await createChannelContextLoader(fakeSlack().slack, root, join(root, "permissions.json"))("CUNICODE", "thread");
    const memorySection = context.systemPromptAppend.split("--- MEMORY.md ---\n")[1]!.split("\n--- END SLACK CONTEXT ---")[0]!;

    expect(Buffer.byteLength(memorySection.split("\n").slice(1).join("\n"))).toBeLessThanOrEqual(16 * 1024);
    expect(context.systemPromptAppend).not.toContain("�");
  });

  test("does not split a multibyte character at the 16KB boundary", async () => {
    const root = await dataDir();
    const dir = await channelFiles(root, "CBOUNDARY", {});
    await writeFile(join(dir, "MEMORY.md"), "a".repeat(10) + "🙂" + "z".repeat(16 * 1024 - 2));

    const context = await createChannelContextLoader(fakeSlack().slack, root, join(root, "permissions.json"))("CBOUNDARY", "thread");

    expect(context.systemPromptAppend).not.toContain("�");
  });
});

describe("server permissions", () => {
  async function serverFile(root: string, contents: unknown): Promise<string> {
    const path = join(root, "permissions.json");
    await writeFile(path, typeof contents === "string" ? contents : JSON.stringify(contents));
    return path;
  }

  test("merges server directories and commands into a configured channel, deduped", async () => {
    const root = await dataDir();
    const serverRepo = join(root, "server-repo");
    await mkdir(serverRepo);
    await serverFile(root, { directories: [serverRepo], commandPrefixes: ["pm2", "websearch"] });
    const dir = await channelFiles(root, "CMERGE", { repos: ["repo"], allowedCommands: ["pm2", "bun test"] });
    await mkdir(join(dir, "repo"));

    const context = await createChannelContextLoader(fakeSlack().slack, root, join(root, "permissions.json"))("CMERGE", "thread");

    expect(context.config.repos).toEqual([join(dir, "repo"), serverRepo]);
    expect(context.config.allowedCommands).toEqual(["pm2", "bun test", "websearch"]);
    expect(context.systemPromptAppend).toContain(serverRepo);
  });

  test("grants server permissions to an unknown channel with empty config", async () => {
    const root = await dataDir();
    const serverRepo = join(root, "server-repo");
    await mkdir(serverRepo);
    await serverFile(root, { directories: ["server-repo"], commandPrefixes: ["wideband"] });

    const context = await createChannelContextLoader(fakeSlack().slack, root, join(root, "permissions.json"))("CNEW", "CNEW");

    // relative server entries resolve against the permissions file's directory
    expect(context.config.repos).toEqual([serverRepo]);
    expect(context.config.allowedCommands).toEqual(["wideband"]);
  });

  test("missing permissions.json leaves channel grants unchanged", async () => {
    const root = await dataDir();
    await channelFiles(root, "CONLY", { allowedCommands: ["pm2"] });

    const context = await createChannelContextLoader(fakeSlack().slack, root, join(root, "permissions.json"))("CONLY", "thread");

    expect(context.config.repos).toEqual([]);
    expect(context.config.allowedCommands).toEqual(["pm2"]);
  });

  test("does not misreport an unreadable permissions file as a parse error", async () => {
    const root = await dataDir();
    const path = join(root, "permissions.json");
    await mkdir(path, { recursive: true }); // a directory: readable check fails, not JSON.parse

    await expect(createChannelContextLoader(fakeSlack().slack, root, path)("CDIRPERMS", "thread"))
      .rejects.toThrow(`Unable to read server permissions ${path}`);
  });

  test("rejects unparseable and malformed permissions files with the path", async () => {
    const root = await dataDir();
    const path = await serverFile(root, "{");
    const load = createChannelContextLoader(fakeSlack().slack, root, path);
    await expect(load("CBAD", "thread")).rejects.toThrow(`Unable to parse server permissions ${path}`);

    await serverFile(root, { directories: "not-an-array" });
    await expect(load("CBAD", "thread")).rejects.toThrow("directories must be an array of non-empty strings");

    await serverFile(root, { commandPrefixes: ["pm2", "  "] });
    await expect(load("CBAD", "thread")).rejects.toThrow("commandPrefixes must be an array of non-empty strings");
  });

  test("rejects nonexistent server directories", async () => {
    const root = await dataDir();
    const missing = join(root, "never-created");
    const path = await serverFile(root, { directories: [missing] });

    await expect(createChannelContextLoader(fakeSlack().slack, root, path)("CGONE", "thread"))
      .rejects.toThrow(`Invalid ${path}: granted path does not exist: ${missing}`);
  });

  test("warns on unknown server permission keys without failing the run", async () => {
    const root = await dataDir();
    await serverFile(root, { commandPrefixes: ["pm2"], ceiling: [] });

    const context = await createChannelContextLoader(fakeSlack().slack, root, join(root, "permissions.json"))("CWARN", "thread");

    expect(context.warnings).toContain('Unknown server permissions key "ceiling"');
    expect(context.config.allowedCommands).toEqual(["pm2"]);
  });
});
