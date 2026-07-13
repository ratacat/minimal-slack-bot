/** Curation run + memory_append/memory_replace tools. Spec §Memory. */
import type { query } from "@anthropic-ai/claude-agent-sdk";
import type { CurationArgs } from "./types.ts";

/** Curation runs serialize per channelDir; failures log and never throw. */
export function createCurator(queryFn: typeof query): (args: CurationArgs) => Promise<void> {
  throw new Error("stub: not implemented");
}
