# Slackbot — channel-scoped Claude agent on ultra

Design spec, 2026-07-13. Status: awaiting review. Rev 2 (clarify pass).

## Goal

A minimal Slack-resident AI teammate running locally on ultra (Mac Studio), built on
the Claude Agent SDK (TS, Bun, pm2). Each Slack channel maps to one or more repos on
this machine; each thread is a persistent working session anyone in the channel can
steer. Model is switchable per channel and per thread.

Prior art: Anthropic's Claude Tag (claude.com/docs/claude-tag). We steal its state
model and drop its infrastructure — no sandboxes (real filesystem), no service
accounts (one bot, operator's creds).

## Vocabulary

- **Message** — one inbound Slack message (event).
- **Thread** — a Slack thread; owns exactly one Session. Key: `(channel_id, thread_key)`.
- **Session** — the SDK conversation transcript, persisted as jsonl by the SDK,
  addressed by `session_id`.
- **Run** — one `query()` invocation. A run may absorb several Messages via
  streaming input (steering). A Thread has at most one live Run.
- **Curation run** — the post-run memory sweep on haiku.

## Constraints

- Single operator, personal Slack workspace. No allowlist v1.
- Runs as a pm2 daemon; must survive restarts with zero session loss.
- Socket Mode only — no inbound ports on ultra.
- SDK version pinned in package.json; streaming-input semantics re-verified on bump.
- YAGNI throughout: the SDK owns the agent loop, tools, permissions plumbing,
  session persistence, context compaction. We own the glue (~550 lines).

## State model (from Claude Tag)

| Decision | Implementation |
|---|---|
| Thread = session; threads share nothing | `threads` table maps thread key → `session_id` |
| Thread durable, execution ephemeral | SDK persists sessions as jsonl under `~/.claude/projects/`; a Run resumes, works, exits. No long-lived agent processes between Runs. |
| Access follows the channel | `data/channels/<id>/config.json`: repos, permissionMode, model |
| Anyone in thread steers, no re-mention | Every human reply in a tracked thread feeds the session |
| Progress = one message edited in place | `chat.update` a status message from the SDK stream, throttled ≥1s |
| Memory scoped by place | Per-channel `MEMORY.md`, curated post-run. No cross-channel sharing. |

Simplification vs Claude Tag: channel config is re-read every Run (they lock at
thread start). Single operator; changes apply on the next Run.

## Architecture

```
Slack ⇄ (Socket Mode) ⇄ Bolt app (pm2, Bun)
                            ├─ bot.sqlite         thread → session map
                            ├─ query() per Run    Agent SDK, streaming input
                            │    ├─ cwd = data/channels/<id>/workspace/
                            │    ├─ additionalDirectories = config.repos
                            │    └─ canUseTool ⇄ Block Kit approve/deny
                            └─ data/channels/<id>/{config.json, CHANNEL.md, MEMORY.md}
```

### Files

```
src/
  index.ts      Bolt wiring: message events → filter → route; button actions   ~100
  runs.ts       Run owner: per-thread serialization, streaming input queue,
                options assembly, SDK stream → status/result posting           ~170
  store.ts      SQLite thread rows (bun:sqlite)                                 ~40
  channels.ts   channel context: config, CHANNEL.md/MEMORY.md, system-prompt
                append assembly, model alias resolution                         ~60
  approvals.ts  canUseTool ↔ Block Kit promise bridge                           ~70
  memory.ts     curation run + memory_append/memory_replace tools               ~50
data/
  channels/<channel_id>/{config.json, CHANNEL.md, MEMORY.md, workspace/}
  bot.sqlite
models.json
.env            SLACK_BOT_TOKEN, SLACK_APP_TOKEN, ANTHROPIC_API_KEY
```

Module boundaries (deletion-test checked): `runs.ts` is the single owner of run
lifecycle — `index.ts` only parses/filters Slack events and calls
`dispatch(inbound)`. Model alias resolution lives with channel config in
`channels.ts` (a separate `models.ts` failed the deletion test: its interface was
its implementation). `approvals.ts` and `memory.ts` stay separate: each hides a
real mechanism (promise bridge; curation protocol) behind a one-call interface.

Dependencies: `@slack/bolt`, `@anthropic-ai/claude-agent-sdk` (pinned), `bun:sqlite`.

### SQLite schema

```sql
CREATE TABLE threads (
  channel_id       TEXT NOT NULL,
  thread_key       TEXT NOT NULL,  -- thread_ts, or channel_id for DMs
  session_id       TEXT NOT NULL,
  model            TEXT,           -- thread override alias; null = channel/global
  active_status_ts TEXT,           -- ts of live status message; null when idle
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (channel_id, thread_key)
);
```

Pending approvals live in memory (a `Map` keyed by action id). If the process dies,
the Run dies with it — nothing to persist. `active_status_ts` exists so a boot
sweep can mark orphaned status messages (see Run lifecycle).

## Event model

Subscribe to `message.channels`, `message.groups`, `message.im` only. Do **not**
subscribe to `app_mention`: a mention in a member channel delivers as both
`app_mention` and `message.channels`, which would force cross-event dedupe. One
event family, one pipeline. Mention detection is local: message text contains
`<@BOT_USER_ID>` (bot user id fetched once at boot via `auth.test`).

Filter (in order):
1. Drop messages with `bot_id` or from self.
2. Drop all `subtype`s (edits, deletes, joins). Matches Claude Tag: editing a
   message never changes what the agent already received.

Thread key:
- channels/groups: `thread_ts ?? ts`
- DMs (`im`): `channel_id` — one rolling session per DM conversation (nobody
  threads in DMs; per-message sessions would amnesia every exchange). Bot replies
  top-level in DMs.

Routing:
- Tracked key → continue/steer the session (no mention needed).
- Untracked + mentions bot → new session. First mention landing mid-way into an
  existing thread: fetch prior context via `conversations.replies` (cap 50) and
  prepend to the first prompt.
- Untracked DM message → new session.
- Anything else → ignore.

`[alias]` model token is parsed on **any** inbound message for a thread (not just
the first), stripped before prompting, persisted on the thread row. Takes effect
on the Run it starts; if a Run is live, on the next Run. Unknown alias → reply
listing known aliases, do not run.

## Channel ↔ repo interface

```jsonc
// data/channels/C0XXXX/config.json — all fields optional
{
  "repos": ["~/Projects/foo", "~/Projects/bar"],  // → additionalDirectories, ~ expanded
  "model": "sonnet",                               // channel default alias
  "permissionMode": "default"                      // or "acceptEdits"
}
```

- `cwd` is always the channel's `workspace/` dir (scratch, generated files,
  MEMORY.md lives beside it). Repos attach via `additionalDirectories`. Uniform for
  0..N repos.
- `CHANNEL.md` (hand-written: channel purpose, repo descriptions, conventions) and
  `MEMORY.md` are injected every Run via
  `systemPrompt: { type: "preset", preset: "claude_code", append }`. The append is
  assembled in one place (`channels.ts`) and also carries: a header naming the
  Slack channel/thread, and "format replies as Slack mrkdwn" (agents emit standard
  markdown otherwise; Slack renders mrkdwn — bold/links would break).
- The SDK does not load `CLAUDE.md` from `additionalDirectories` (only from cwd);
  CHANNEL.md should tell the agent to read a repo's own CLAUDE.md when relevant.
- Unknown conversation id (e.g. a DM) → auto-create the channel dir with empty
  config. DMs work with zero setup, no repo access until configured.

## Model switching

```jsonc
// models.json
{
  "default": "sonnet",
  "aliases": {
    "sonnet": { "model": "sonnet" },   // SDK accepts CLI aliases; pin full ids only if needed
    "opus":   { "model": "opus" },
    "haiku":  { "model": "haiku" },
    "ds4":    { "model": "deepseek",   // EXPERIMENTAL — see note
                "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:8000" } }
  }
}
```

- Resolution (single definition, used everywhere): thread override → channel
  `model` → `default`.
- Mechanics: `model` and `env` are per-`query()` options. `env` replaces the
  subprocess environment — always spread `process.env` in. Mid-thread switches are
  safe: the resumed transcript is model-agnostic. (`setModel()` exists for live
  Runs — streaming-only — but next-Run application is sufficient; Runs are short.)
- `env` is the provider seam: any Anthropic-compatible `/v1/messages` endpoint is
  a config entry. **ds4 is experimental until a smoke test proves tool-calling
  fidelity through the Claude Code harness** — "config not code" holds for wiring,
  not for model capability. v1 ships Anthropic aliases.
- Curation runs always use `haiku`.

## Run lifecycle

Every Run uses **streaming input mode** (`prompt` as `AsyncIterable<SDKUserMessage>`).
Non-negotiable: mid-run steering, `interrupt()`, and `setModel()` are all
streaming-only per the SDK reference; a string prompt cannot absorb a second
message.

1. `dispatch(inbound)` appends the message to the thread's queue. Live Run →
   the input generator picks it up (steering). Idle → start a Run
   (`resume: session_id` when the row exists).
2. The input generator drains the queue. Close condition: a result message has
   arrived AND the queue is empty → close the iterable, Run ends. Messages
   arriving after close are serialized by the per-thread promise chain into the
   next Run.
3. Options per Run: `cwd`, `additionalDirectories`, `systemPrompt` preset+append,
   resolved `model` + `env`, `permissionMode`, `canUseTool`,
   `maxBudgetUsd` (global cap, default 5), `disallowedTools` backstop.
4. On the SDK init message (`subtype: "init"`): store `session_id` immediately
   (crash-safe — a mid-run death still leaves a resumable row) and set
   `active_status_ts` to the just-posted status message.
5. Progress: `chat.update` the status message with the current tool/todo line,
   throttled ≥1s. On result: post final text as a thread reply (>4000 chars →
   file snippet upload with `thread_ts`), delete-or-finalize the status message,
   clear `active_status_ts`.
6. Curation run if the main Run used any tool.
7. Errors (query throw, `is_error` result): post the error in-thread, clear
   `active_status_ts`. The row is otherwise untouched — resume remains valid from
   the last completed state.

Boot sweep: on startup, for every row with non-null `active_status_ts`, update
that message to "interrupted by restart — reply to resume" and clear the field.

Per-thread serialization: a promise chain per thread key — two events for one
thread never race. No global concurrency cap v1.

## Write safety

- `canUseTool` → Block Kit message in the thread: tool name, input preview
  (truncated), Approve / Deny buttons. Resolved by the button action; auto-deny
  after 10 minutes. The resolution message records who clicked. A click on an
  expired approval gets the message updated to "expired". Only fires when the SDK
  permission flow falls through to a prompt — reads and pre-approved rules never
  ping Slack.
- Per-channel dial: `permissionMode: "default"` = every write gated;
  `"acceptEdits"` = file edits flow, Bash still gated.
- Global backstop: `disallowedTools: ["Bash(rm -rf*)"]` — scoped deny rules hold
  in every mode.
- Repo writes hit live checkouts (operator decision, 2026-07-13): the approval
  gate plus thread visibility is the mitigation for concurrent operator edits.
  Upgrade path if clashes hurt: worktree-per-thread (~40 lines, not v1).

## Memory

- After any tool-using Run: one `query()` on `haiku`, `maxTurns: 2`, prompt
  "anything worth persisting to MEMORY.md for this channel?", with an in-process
  SDK MCP server (`createSdkMcpServer`) exposing:
  - `memory_append(text)` — append a dated entry
  - `memory_replace(old, new)` — edit/compact existing entries
- Curation run options: `allowedTools` lists exactly the two
  `mcp__memory__*` tools; no `canUseTool` — anything else falls through and is
  denied.
- Curation prompt instructs consolidation when MEMORY.md exceeds ~8KB.
- MEMORY.md is plain markdown in the channel dir — operator-editable, greppable,
  in git if desired.

## Slack app config

- Socket Mode on; app-level token with `connections:write`.
- **Interactivity toggled on** (required for button actions; payloads arrive over
  the socket, no Request URL).
- Bot scopes: `channels:history`, `groups:history`, `im:history`, `chat:write`,
  `files:write`. (`app_mentions:read` not needed — see Event model.)
- Events: `message.channels`, `message.groups`, `message.im`.
- Bot must be `/invite`d to a channel to receive its events.
- Dev workflow: never point a second process at the production app's tokens — two
  Socket Mode consumers split/duplicate event delivery. Use a separate dev Slack
  app.

## Observability

One JSON line to stdout per inbound event, Run start/end (with session_id, model,
cost), approval decision, and error. `pm2 logs slackbot` is the debugging
interface. No log files, no metrics stack.

## Cut list (explicit non-goals, with upgrade paths)

- Cron/heartbeat routines — later; same `query()` path, post only if non-SILENT.
- Cross-channel/workspace-shared memory.
- Session transcript viewer — SDK `listSessions()`/`getSessionMessages()` +
  html-home page whenever wanted.
- Message-edit handling (`message_changed`) — matches Claude Tag: no rewind.
- User allowlist, multi-workspace, attachment ingestion, reaction signals.
- Worktree isolation (see Write safety).
- File checkpointing (`enableFileCheckpointing`) — upgrade path if mid-run
  interruptions leaving partial edits becomes a real problem.

## Residual risks (accepted)

- pm2 restart mid-Run leaves partially applied repo edits; visible via `git diff`,
  recoverable by replying to the thread. Checkpointing is the upgrade path.
- Socket disconnect can drop events beyond Slack's redelivery window; the user
  re-pings. No event-replay machinery v1.
- SDK jsonl/session format is SDK-owned; a major upgrade may orphan old sessions
  (threads then start fresh). Acceptable.

## Acceptance criteria (v1)

1. One `@bot` mention in a configured channel produces exactly one thread row and
   one Run (no double processing); result posts in-thread.
2. A plain reply in that thread continues the same session (agent can reference
   the earlier exchange).
3. A reply sent while a Run is live is folded into the running work.
4. In a `default`-mode channel, a file write produces Approve/Deny buttons; Deny
   blocks the write; 10-minute silence denies.
5. `[opus]` on any message switches the thread's model (verify via the result
   message's `modelUsage` keys) and persists for subsequent Runs.
6. After a substantive task, MEMORY.md gains an entry; a new thread in the same
   channel demonstrably knows it.
7. A DM with no prior config gets an auto-created channel dir; a second top-level
   DM message continues the same session (rolling DM session).
8. `pm2 restart` while idle: replying to an old thread resumes its session.
   Restart mid-Run: the status message reads "interrupted by restart", and the
   next reply resumes from the last completed state.
