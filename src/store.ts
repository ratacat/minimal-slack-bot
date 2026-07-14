/** SQLite thread rows (bun:sqlite, WAL). Spec §SQLite schema. */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ThreadRow, ThreadStore } from "./types.ts";

export function openThreadStore(dbPath: string): ThreadStore {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.run("PRAGMA journal_mode = WAL");
  db.run(`CREATE TABLE IF NOT EXISTS threads (
    channel_id TEXT NOT NULL,
    thread_key TEXT NOT NULL,
    session_id TEXT,
    model TEXT,
    active_status_ts TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (channel_id, thread_key)
  )`);

  const get = db.query<ThreadRow, [string, string]>(`SELECT
    channel_id AS channelId, thread_key AS threadKey, session_id AS sessionId,
    model, active_status_ts AS activeStatusTs, updated_at AS updatedAt
    FROM threads WHERE channel_id = ? AND thread_key = ?`);
  const session = db.query<void, [string, string, string | null, number]>(
    `INSERT INTO threads (channel_id, thread_key, session_id, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(channel_id, thread_key) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at`,
  );
  const model = db.query<void, [string, string, string | null, number]>(
    `INSERT INTO threads (channel_id, thread_key, model, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(channel_id, thread_key) DO UPDATE SET model = excluded.model, updated_at = excluded.updated_at`,
  );
  const status = db.query<void, [string, string, string | null, number]>(
    `INSERT INTO threads (channel_id, thread_key, active_status_ts, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(channel_id, thread_key) DO UPDATE SET active_status_ts = excluded.active_status_ts, updated_at = excluded.updated_at`,
  );
  const active = db.query<{ channelId: string; threadKey: string; activeStatusTs: string }, []>(
    "SELECT channel_id AS channelId, thread_key AS threadKey, active_status_ts AS activeStatusTs FROM threads WHERE active_status_ts IS NOT NULL",
  );
  const write = (statement: typeof session, channelId: string, threadKey: string, value: string | null) =>
    statement.run(channelId, threadKey, value, Date.now());

  return {
    get: (channelId, threadKey) => get.get(channelId, threadKey) ?? undefined,
    setSession: (channelId, threadKey, sessionId) => write(session, channelId, threadKey, sessionId),
    clearSession: (channelId, threadKey) => write(session, channelId, threadKey, null),
    setModel: (channelId, threadKey, alias) => write(model, channelId, threadKey, alias),
    setActiveStatus: (channelId, threadKey, statusTs) => write(status, channelId, threadKey, statusTs),
    listActiveStatuses: () => active.all(),
    close: () => db.close(),
  };
}
