/** SQLite thread rows (bun:sqlite, WAL). Spec §SQLite schema. */
import type { ThreadStore } from "./types.ts";

export function openThreadStore(dbPath: string): ThreadStore {
  throw new Error("stub: not implemented");
}
