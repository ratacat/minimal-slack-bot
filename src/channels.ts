/**
 * Channel context: config load+validate, CHANNEL.md/MEMORY.md, system-prompt
 * append assembly, model alias resolution, channel-name cache.
 * Spec §Channel ↔ repo interface, §Model switching, §Model token.
 */
import type { ChannelContext, ModelsConfig, ResolvedModel, SlackPort } from "./types.ts";

/** <repo root>/data — resolved from this module's dir, never process.cwd(). */
export const DATA_DIR: string = new URL("../data/", import.meta.url).pathname;
/** <repo root>/models.json */
export const MODELS_PATH: string = new URL("../models.json", import.meta.url).pathname;

/** Throws Error when the file is unparseable or `default` names no known alias. */
export function loadModels(path: string = MODELS_PATH): ModelsConfig {
  throw new Error("stub: not implemented");
}

/** Resolution: thread override → channel alias → default. */
export function resolveModel(
  models: ModelsConfig,
  threadAlias: string | null,
  channelAlias?: string,
): ResolvedModel {
  throw new Error("stub: not implemented");
}

/** Leading `[token]` (case-insensitive lowered), tolerating leading whitespace. */
export function parseLeadingToken(text: string): { token: string | null; rest: string } {
  throw new Error("stub: not implemented");
}

/**
 * Per-Run channel context loader. Auto-creates the channel dir with empty
 * config for unknown ids. Throws Error on fatal config problems.
 */
export function createChannelContextLoader(
  slack: SlackPort,
  dataDir: string = DATA_DIR,
): (channelId: string, threadKey: string) => Promise<ChannelContext> {
  throw new Error("stub: not implemented");
}
