/**
 * Channel context: config load+validate, CHANNEL.md/MEMORY.md, system-prompt
 * append assembly, model alias resolution, channel-name cache.
 * Spec §Channel ↔ repo interface, §Model switching, §Model token.
 */
import { readFileSync } from "node:fs";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ChannelConfig, ChannelContext, ModelsConfig, ProvidersConfig, ResolvedModel, SlackPort } from "./types.ts";

/** <repo root>/data — resolved from this module's dir, never process.cwd(). */
export const DATA_DIR: string = new URL("../data/", import.meta.url).pathname;
/** <repo root>/models.json */
export const MODELS_PATH: string = new URL("../models.json", import.meta.url).pathname;
/** <repo root>/providers.json */
export const PROVIDERS_PATH: string = new URL("../providers.json", import.meta.url).pathname;
/** <repo root>/permissions.json — server-wide standing grants merged into every channel. */
export const PERMISSIONS_PATH: string = new URL("../permissions.json", import.meta.url).pathname;

const MEMORY_LIMIT_BYTES = 16 * 1024;
const channelNames = new Map<string, Promise<string | undefined>>();
const CONFIG_KEYS: Record<string, true> = { repos: true, model: true, permissionMode: true, allowedCommands: true };
const PERMISSION_KEYS: Record<string, true> = { directories: true, commandPrefixes: true };

interface ServerPermissions {
  directories: string[];
  commandPrefixes: string[];
  warnings: string[];
}

/** Missing file = no server grants. Unparseable/invalid = throw (Run refused). */
async function readServerPermissions(path: string): Promise<ServerPermissions> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { directories: [], commandPrefixes: [], warnings: [] };
    throw new Error(`Unable to read server permissions ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Unable to parse server permissions ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(raw)) throw new Error(`Invalid server permissions ${path}: expected a JSON object`);
  const warnings = Object.keys(raw)
    .filter((key) => !PERMISSION_KEYS[key])
    .map((key) => `Unknown server permissions key "${key}"`);
  if (raw.directories !== undefined && (!Array.isArray(raw.directories)
    || raw.directories.some((entry) => typeof entry !== "string" || !entry.trim()))) {
    throw new Error(`Invalid server permissions ${path}: directories must be an array of non-empty strings`);
  }
  if (raw.commandPrefixes !== undefined && (!Array.isArray(raw.commandPrefixes)
    || raw.commandPrefixes.some((entry) => typeof entry !== "string" || !entry.trim()))) {
    throw new Error(`Invalid server permissions ${path}: commandPrefixes must be an array of non-empty strings`);
  }
  return {
    directories: (raw.directories ?? []) as string[],
    commandPrefixes: ((raw.commandPrefixes ?? []) as string[]).map((command) => command.trim()),
    warnings,
  };
}

/** ~-expansion, base-relative resolution, and must-be-an-existing-directory validation. */
async function resolveGrantedDirectory(entry: string, baseDir: string, sourcePath: string): Promise<string> {
  const expanded = entry === "~" ? homedir() : entry.startsWith("~/") ? join(homedir(), entry.slice(2)) : entry;
  const absolute = isAbsolute(expanded) ? resolve(expanded) : resolve(baseDir, expanded);
  try {
    if (!(await stat(absolute)).isDirectory()) {
      throw new Error(`granted path must be a directory: ${absolute}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("granted path must be")) throw error;
    throw new Error(`Invalid ${sourcePath}: granted path does not exist: ${absolute}`);
  }
  return absolute;
}

/** Throws Error when the file is unparseable or `default` names no known alias. */
export function loadModels(path: string = MODELS_PATH): ModelsConfig {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Unable to parse models file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!isRecord(value) || typeof value.default !== "string") {
    throw new Error(`Invalid models file ${path}: missing string default alias`);
  }
  if (!isRecord(value.aliases)) {
    throw new Error(`Invalid models file ${path}: aliases must be an object`);
  }
  for (const [alias, config] of Object.entries(value.aliases)) {
    if (!isRecord(config) || typeof config.model !== "string") {
      throw new Error(`Invalid models file ${path}: alias "${alias}" must have a string model`);
    }
    if (config.effort !== undefined && !["low", "medium", "high", "xhigh", "max"].includes(String(config.effort))) {
      throw new Error(`Invalid models file ${path}: alias "${alias}" effort must be low, medium, high, xhigh, or max`);
    }
    if (config.providerProfile !== undefined && typeof config.providerProfile !== "string") {
      throw new Error(`Invalid models file ${path}: alias "${alias}" providerProfile must be a string`);
    }
    if (config.env !== undefined && (!isRecord(config.env) || Object.values(config.env).some((entry) => typeof entry !== "string"))) {
      throw new Error(`Invalid models file ${path}: alias "${alias}" env must contain only string values`);
    }
  }
  if (!(value.default in value.aliases)) {
    throw new Error(`Invalid models file ${path}: default alias "${value.default}" is not defined`);
  }
  return value as unknown as ModelsConfig;
}

/** Throws Error when the provider file is invalid or default profile is missing. */
export function loadProviders(path: string = PROVIDERS_PATH): ProvidersConfig {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Unable to parse providers file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(value) || typeof value.default !== "string" || !isRecord(value.profiles)) {
    throw new Error(`Invalid providers file ${path}: requires string default and object profiles`);
  }
  const modes = new Set(["api-key", "claude-subscription", "proxy"]);
  for (const [name, profile] of Object.entries(value.profiles)) {
    if (!isRecord(profile) || typeof profile.mode !== "string" || !modes.has(profile.mode)) {
      throw new Error(`Invalid providers file ${path}: profile "${name}" has unknown mode`);
    }
    if (profile.env !== undefined && (!isRecord(profile.env) || Object.values(profile.env).some((entry) => typeof entry !== "string"))) {
      throw new Error(`Invalid providers file ${path}: profile "${name}" env must contain only string values`);
    }
    if (profile.mode === "proxy" && (!isRecord(profile.env) || typeof profile.env.ANTHROPIC_BASE_URL !== "string")) {
      throw new Error(`Invalid providers file ${path}: proxy profile "${name}" requires env.ANTHROPIC_BASE_URL`);
    }
    if (profile.pathToClaudeCodeExecutable !== undefined && typeof profile.pathToClaudeCodeExecutable !== "string") {
      throw new Error(`Invalid providers file ${path}: profile "${name}" executable path must be a string`);
    }
  }
  if (!(value.default in value.profiles)) {
    throw new Error(`Invalid providers file ${path}: default profile "${value.default}" is not defined`);
  }
  return value as unknown as ProvidersConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolution: thread override → channel alias → default. */
export function resolveModel(
  models: ModelsConfig,
  threadAlias: string | null,
  channelAlias?: string,
): ResolvedModel {
  const threadKnown = threadAlias !== null && threadAlias in models.aliases;
  const alias = threadKnown
    ? threadAlias
    : channelAlias && channelAlias in models.aliases
      ? channelAlias
      : models.default;
  const resolved: ResolvedModel = { alias, ...models.aliases[alias]! };
  if (threadAlias !== null && !threadKnown) resolved.staleThreadAlias = threadAlias;
  return resolved;
}
/** Leading `[token]` (case-insensitive lowered), tolerating leading whitespace. */
export function parseLeadingToken(text: string): { token: string | null; rest: string } {
  const match = /^\s*\[([\w-]+)\]/u.exec(text);
  return match
    ? { token: match[1]!.toLowerCase(), rest: text.slice(match[0].length).trim() }
    : { token: null, rest: text };
}

/**
 * Per-Run channel context loader. Auto-creates the channel dir with empty
 * config for unknown ids. Merges server-wide permissions.json grants into the
 * channel's effective repos/allowedCommands. Throws Error on fatal config problems.
 */
export function createChannelContextLoader(
  slack: SlackPort,
  dataDir: string = DATA_DIR,
  permissionsPath: string = PERMISSIONS_PATH,
): (channelId: string, threadKey: string) => Promise<ChannelContext> {
  return async (channelId, threadKey) => {
    const channelDir = join(dataDir, "channels", channelId);
    const workspaceDir = join(channelDir, "workspace");
    const configPath = join(channelDir, "config.json");
    await mkdir(workspaceDir, { recursive: true });
    try {
      await access(configPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        await writeFile(configPath, "{}", { flag: "wx" });
      } catch (writeError) {
        if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
      }
    }

    let contents: string;
    try {
      contents = await readFile(configPath, "utf8");
    } catch (error) {
      throw new Error(`Unable to read channel config ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(contents);
    } catch (error) {
      throw new Error(`Unable to parse channel config ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!isRecord(raw)) throw new Error(`Invalid channel config ${configPath}: expected a JSON object`);
    const warnings = Object.keys(raw)
      .filter((key) => !CONFIG_KEYS[key])
      .map((key) => `Unknown channel config key "${key}"`);
    if (raw.permissionMode !== undefined && raw.permissionMode !== "default" && raw.permissionMode !== "acceptEdits") {
      throw new Error(`Invalid channel config ${configPath}: permissionMode must be "default" or "acceptEdits"`);
    }
    if (raw.repos !== undefined && (!Array.isArray(raw.repos) || raw.repos.some((repo) => typeof repo !== "string"))) {
      throw new Error(`Invalid channel config ${configPath}: repos must be an array of strings`);
    }
    if (raw.allowedCommands !== undefined && (!Array.isArray(raw.allowedCommands)
      || raw.allowedCommands.some((command) => typeof command !== "string" || !command.trim()))) {
      throw new Error(`Invalid channel config ${configPath}: allowedCommands must be an array of non-empty strings`);
    }
    if (raw.model !== undefined && typeof raw.model !== "string") {
      throw new Error(`Invalid channel config ${configPath}: model must be a string`);
    }

    const server = await readServerPermissions(permissionsPath);
    warnings.push(...server.warnings);
    const channelRepos = await Promise.all(
      (raw.repos ?? []).map((repo) => resolveGrantedDirectory(repo, channelDir, configPath)),
    );
    const serverDirectories = await Promise.all(
      server.directories.map((entry) => resolveGrantedDirectory(entry, dirname(permissionsPath), permissionsPath)),
    );
    const config: ChannelConfig = {
      repos: [...new Set([...channelRepos, ...serverDirectories])],
      allowedCommands: [...new Set([
        ...(raw.allowedCommands ?? []).map((command) => String(command).trim()),
        ...server.commandPrefixes,
      ])],
      ...(typeof raw.model === "string" ? { model: raw.model } : {}),
      permissionMode: raw.permissionMode === "acceptEdits" ? "acceptEdits" : "default",
    };

    let nameRequest = channelNames.get(channelId);
    if (!nameRequest) {
      nameRequest = slack.fetchChannelName(channelId).catch((error) => {
        channelNames.delete(channelId);
        throw error;
      });
      channelNames.set(channelId, nameRequest);
    }
    const channelName = await nameRequest;
    const channelMarkdown = await readOptional(join(channelDir, "CHANNEL.md"));
    let memoryMarkdown = await readOptional(join(channelDir, "MEMORY.md"));
    let memoryWarning = "";
    if (memoryMarkdown && Buffer.byteLength(memoryMarkdown) > MEMORY_LIMIT_BYTES) {
      const bytes = Buffer.from(memoryMarkdown);
      let start = bytes.length - MEMORY_LIMIT_BYTES;
      while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
      memoryMarkdown = bytes.subarray(start).toString("utf8");
      memoryWarning = `MEMORY.md truncated to its last ${MEMORY_LIMIT_BYTES} bytes.`;
      warnings.push(memoryWarning);
    }

    const systemPromptAppend = [
      "--- SLACK CONTEXT ---",
      `Slack channel: ${channelName ?? "unnamed conversation"} (${channelId})`,
      `Thread key: ${threadKey}`,
      "--- REPOSITORIES ---",
      config.repos.length ? config.repos.join("\n") : "no repos configured",
      "--- RESPONSE FORMAT ---",
      "Format replies as Slack mrkdwn, not standard Markdown.",
      "--- CHANNEL.md ---",
      channelMarkdown || "(not present)",
      "--- MEMORY.md ---",
      memoryWarning,
      memoryMarkdown || "(not present)",
      "--- END SLACK CONTEXT ---",
    ].filter(Boolean).join("\n");

    return { channelDir, workspaceDir, config, systemPromptAppend, warnings };
  };
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}
