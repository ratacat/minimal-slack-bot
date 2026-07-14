import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openThreadStore } from "../src/store.ts";

function temporaryStore() {
  const dir = mkdtempSync(join(tmpdir(), "slackbot-store-"));
  const path = join(dir, "nested", "bot.sqlite");
  return { dir, path, store: openThreadStore(path) };
}

function cleanup(dir: string) {
  rmSync(dir, { force: true, recursive: true });
}

test("get returns undefined for an unknown thread", () => {
  const { dir, store } = temporaryStore();
  try {
    expect(store.get("C1", "T1")).toBeUndefined();
  } finally {
    store.close();
    cleanup(dir);
  }
});

test("setSession creates and reads a thread row", () => {
  const { dir, store } = temporaryStore();
  try {
    store.setSession("C1", "T1", "session-1");
    const row = store.get("C1", "T1");
    expect(row).toMatchObject({
      channelId: "C1",
      threadKey: "T1",
      sessionId: "session-1",
      model: null,
      activeStatusTs: null,
    });
    expect(typeof row?.updatedAt).toBe("number");
  } finally {
    store.close();
    cleanup(dir);
  }
});

test("setModel creates a row without a session", () => {
  const { dir, store } = temporaryStore();
  try {
    store.setModel("C1", "T1", "opus");
    expect(store.get("C1", "T1")).toMatchObject({ sessionId: null, model: "opus" });
  } finally {
    store.close();
    cleanup(dir);
  }
});

test("session updates preserve model and clearing preserves it", () => {
  const { dir, store } = temporaryStore();
  try {
    store.setModel("C1", "T1", "opus");
    store.setSession("C1", "T1", "session-1");
    expect(store.get("C1", "T1")).toMatchObject({ sessionId: "session-1", model: "opus" });
    store.clearSession("C1", "T1");
    expect(store.get("C1", "T1")).toMatchObject({ sessionId: null, model: "opus" });
  } finally {
    store.close();
    cleanup(dir);
  }
});

test("active statuses can be set, listed, and cleared", () => {
  const { dir, store } = temporaryStore();
  try {
    store.setActiveStatus("C1", "T1", "100.1");
    store.setModel("C1", "T2", "sonnet");
    expect(store.listActiveStatuses()).toEqual([
      { channelId: "C1", threadKey: "T1", activeStatusTs: "100.1" },
    ]);
    store.setActiveStatus("C1", "T1", null);
    expect(store.listActiveStatuses()).toEqual([]);
  } finally {
    store.close();
    cleanup(dir);
  }
});

test("rows persist across reopen and use WAL", () => {
  const { dir, path, store } = temporaryStore();
  try {
    store.setSession("C1", "T1", "session-1");
    store.setModel("C1", "T1", "opus");
    store.close();

    const db = new Database(path);
    expect(db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
    db.close();

    const reopened = openThreadStore(path);
    try {
      expect(reopened.get("C1", "T1")).toMatchObject({ sessionId: "session-1", model: "opus" });
    } finally {
      reopened.close();
    }
  } finally {
    store.close();
    cleanup(dir);
  }
});
