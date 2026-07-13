/**
 * Run owner: per-thread serialization, streaming input queue, options assembly,
 * SDK stream → status/result posting, stall watchdog, resume pre-check.
 * Spec §Run lifecycle, §Model token, §Write safety.
 */
import type { RunDeps, RunManager } from "./types.ts";

export const STALL_TIMEOUT_MS = 30 * 60 * 1000;
export const MAX_BUDGET_USD = 5;

export function createRunManager(deps: RunDeps): RunManager {
  throw new Error("stub: not implemented");
}
