# Slackbot — channel-scoped Claude agent on ultra

Design spec, 2026-07-13. Status: awaiting review.

## Goal

A minimal Slack-resident AI teammate running locally on ultra (Mac Studio), built on
the Claude Agent SDK (TS, Bun, pm2). Each Slack channel maps to one or more repos on
this machine; each thread is a persistent working session anyone in the channel can
steer. Model is switchable per channel and per thread.

Prior art: Anthropic's Claude Tag (claude.com/docs/claude-tag). We steal its state
model and drop its infrastructure — no sandboxes (real filesystem), no service
accounts (one bot, operator's creds).

## Constraints

- Single operator, personal Slack workspace. No allowlist v1.
- Runs as a pm2 daemon; must survive restarts with zero session loss.
- Socket Mode only — no inbound ports on ultra.
- YAGNI throughout: the SDK owns the agent loop, tools, permissions plumbing,
  session persistence, context compaction. We own ~470 lines of glue.

## State model (from Claude Tag)

| Decision | Implementation |
|---|---|
| Thread = session; threads share nothing | `threads(channel_id, thread_ts) → session_id` in SQLite |
| Thread durable, execution ephemeral | SDK persists sessions as jsonl under `~/.claude/projects/`; each turn = `query({ resume })` → run → exit. No long-lived agent processes. |
| Access follows the channel | `data/channels/<id>/config.json`: repos, permissionMode, model |
| Anyone in thread steers, no re-mention | Every human reply in a tracked thread feeds the session |
| Progress = one message edited in place | `chat.update` a status message from the SDK stream, throttled ≥1s |
| Memory scoped by place | Per-channel `MEMORY.md`, curated post-task. No cross-channel sharing. |

Simplification vs Claude Tag: channel config is re-read every turn (they lock at
thread start). Single operator; changes apply on the next turn.

## Architecture

```
Slack ⇄ (Socket Mode) ⇄ Bolt app (pm2, Bun)
                            ├─ bot.sqlite         thread → session map
                            ├─ query() per turn   Agent SDK
                            │    ├─ cwd = data/channels/<id>/workspace/
                            │    ├─ additionalDirectories = config.repos
                            │    └─ canUseTool ⇄ Block Kit approve/deny
                            └─ data/channels/<id>/{config.json, CHANNEL.md, MEMORY.md}
```

### Files

```
src/
  index.ts      Bolt wiring: app_mention, message events, button actions   ~120
  turn.ts       options assembly, query() run, stream→Slack                ~120
  sessions.ts   SQLite map + per-thread serialization                       ~50
  channels.ts   config/CHANNEL.md/MEMORY.md loader; auto-create for DMs     ~40
  approvals.ts  canUseTool ↔ Block Kit promise bridge                       ~70
  memory.ts     curation turn + memory_append/memory_replace tools          ~50
  models.ts     alias registry + resolution                                 ~20
data/
  channels/<channel_id>/{config.json, CHANNEL.md, MEMORY.md, workspace/}
  bot.sqlite
models.json
.env            SLACK_BOT_TOKEN, SLACK_APP_TOKEN, ANTHROPIC_API_KEY
```

Dependencies: `@slack/bolt`, `@anthropic-ai/claude-agent-sdk`, `bun:sqlite` (builtin).

### SQLite schema

```sql
CREATE TABLE threads (
  channel_id TEXT NOT NULL,
  thread_ts  TEXT NOT NULL,
  session_id TEXT NOT NULL,
  model      TEXT,            -- thread override, null = channel/global default
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (channel_id, thread_ts)
);
```

Pending approvals live in memory (a `Map` keyed by action id). If the process dies,
the query dies with it — nothing to persist.

## Channel ↔ repo interface

```jsonc
// data/channels/C0XXXX/config.json — all fields optional
{
  "repos": ["~/Projects/foo", "~/Projects/bar"],  // → additionalDirectories
  "model": "sonnet",                               // channel default alias
  "permissionMode": "default"                      // or "acceptEdits"
}
```

- `cwd` is always the channel's `workspace/` dir (scratch, generated files,
  MEMORY.md lives beside it). Repos attach via `additionalDirectories`. Uniform for
  0..N repos.
- `CHANNEL.md` (hand-written: channel purpose, repo descriptions, conventions) and
  `MEMORY.md` are injected every turn via
  `systemPrompt: { type: "preset", preset: "claude_code", append }`.
  The SDK does not load `CLAUDE.md` from `additionalDirectories` (only from cwd);
  CHANNEL.md should tell the agent to read a repo's own CLAUDE.md when relevant.
- Unknown conversation id (e.g. a DM) → auto-create the channel dir with empty
  config. DMs work with zero setup, no repo access until configured.

## Model switching

```jsonc
// models.json
{
  "default": "sonnet",
  "aliases": {
    "sonnet": { "model": "claude-sonnet-4-5" },
    "opus":   { "model": "claude-opus-4-6" },
    "haiku":  { "model": "claude-haiku-4-5" },
    "ds4":    { "model": "deepseek",
                "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:8000",
                         "ANTHROPIC_AUTH_TOKEN": "x" } }
  }
}
```

- Resolution: thread override → channel `model` → `default`.
- Thread override: `[alias]` as the first token after the @mention
  (`@bot [opus] refactor the parser`). Stripped before prompting; persisted on the
  thread row. Unknown alias → reply listing known aliases, do not run.
- Mechanics: `model` and `env` are per-`query()` options. `env` replaces the
  subprocess environment — always spread `process.env` in. Mid-thread switches are
  safe: the resumed transcript is model-agnostic.
- `env` is the provider seam: any Anthropic-compatible `/v1/messages` endpoint
  (e.g. local ds4-server) is a config entry, not code. v1 ships Anthropic aliases.
- Curation turns always use `haiku`.

## Turn lifecycle

1. Event: `app_mention` (no thread row → new session) or human reply in a tracked
   thread (row exists → continue). Bot/self messages ignored.
2. First mention landing mid-way into a pre-existing thread: fetch prior context
   via `conversations.replies` (cap 50 messages) and prepend to the first prompt.
3. If a run is live for the thread, push the message into the running query's
   `AsyncIterable<SDKUserMessage>` input (streaming-input mode) — mid-task steering,
   not queueing. If idle, start `query({ prompt, options })` with `resume` when a
   session exists.
4. Options per turn: `cwd`, `additionalDirectories`, `systemPrompt` preset+append
   (CHANNEL.md + MEMORY.md + a short header naming the Slack channel/thread),
   resolved `model` + `env`, `permissionMode`, `canUseTool`,
   `maxBudgetUsd` (global cap, default 5), `includePartialMessages: false`.
5. Progress: post one status message on turn start; `chat.update` it with the
   current tool/todo line, throttled to ≥1s. Final text replaces the status update;
   results >4000 chars upload as a file snippet instead.
6. Store `session_id` from the SDK init message; bump `updated_at`.
7. Curation turn (see Memory) if the main turn used any tool.
8. Errors (query throw, `is_error` result): post the error in-thread. The thread
   row is untouched — resume remains valid from the last good state.

Per-thread serialization: a promise chain per `(channel_id, thread_ts)` so two
events for one thread never race. No global concurrency cap v1.

## Write safety

- `canUseTool` → Block Kit message in the thread: tool name, input preview
  (truncated), Approve / Deny buttons. Resolved by the button action; auto-deny
  after 10 minutes. Only fires when the SDK permission flow falls through to a
  prompt — reads and pre-approved rules never ping Slack.
- Per-channel dial: `permissionMode: "default"` = every write gated;
  `"acceptEdits"` = file edits flow, Bash still gated.
- Global backstop: `disallowedTools: ["Bash(rm -rf*)"]` — scoped deny rules hold
  in every mode.
- Repo writes hit live checkouts (operator decision, 2026-07-13): the approval
  gate plus thread visibility is the mitigation for concurrent operator edits.
  Upgrade path if clashes hurt: worktree-per-thread (~40 lines, not v1).

## Memory

- After any tool-using turn: one `query()` on `haiku`, `maxTurns: 2`, prompt
  "anything worth persisting to MEMORY.md for this channel?", tools limited to an
  in-process SDK MCP server (`createSdkMcpServer`) exposing:
  - `memory_append(text)` — append a dated entry
  - `memory_replace(old, new)` — edit/compact existing entries
- Curation prompt instructs consolidation when MEMORY.md exceeds ~8KB.
- MEMORY.md is plain markdown in the channel dir — operator-editable, greppable,
  in git if desired.

## Slack app config

- Socket Mode on; app-level token with `connections:write`.
- Bot scopes: `app_mentions:read`, `channels:history`, `groups:history`,
  `im:history`, `chat:write`, `files:write`.
- Events: `app_mention`, `message.channels`, `message.groups`, `message.im`.

## Cut list (explicit non-goals, with upgrade paths)

- Cron/heartbeat routines — later; same `query()` path, post only if non-SILENT.
- Cross-channel/workspace-shared memory.
- Session transcript viewer — SDK `listSessions()`/`getSessionMessages()` +
  html-home page whenever wanted.
- User allowlist, multi-workspace, attachment ingestion, reaction signals.
- Worktree isolation (see Write safety).

## Acceptance criteria (v1)

1. `@bot` in a configured channel starts a thread session; result posts in-thread.
2. A plain reply in that thread continues the same session (agent can reference the
   earlier turn).
3. A reply sent while a turn is running is folded into the running work.
4. In a `default`-mode channel, a file write produces Approve/Deny buttons; Deny
   blocks the write; 10-minute silence denies.
5. `[opus]` prefix switches the thread's model (verify via the SDK result
   message's model field) and persists for subsequent turns.
6. After a substantive task, MEMORY.md gains an entry; a new thread in the same
   channel demonstrably knows it.
7. A DM with no prior config gets an auto-created channel dir and answers
   (no repo access).
8. `pm2 restart` while idle: replying to an old thread resumes its session.
