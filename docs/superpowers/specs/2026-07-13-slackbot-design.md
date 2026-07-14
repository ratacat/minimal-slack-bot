# Slackbot — channel-scoped Claude agent on ultra

Design spec, 2026-07-13. Status: awaiting review. Rev 3 (conjecture-cascade pass:
300 probes against SDK 0.3.201 types + Slack API docs; all confirmed gaps folded in).

## Goal

A minimal Slack-resident AI teammate running locally on ultra (Mac Studio), built on
the Claude Agent SDK (TS, Bun, pm2). Each Slack channel maps to one or more repos on
this machine; its top-level messages share one rolling Session, while each explicit
Slack thread owns a separate Session. Model is switchable per channel session and thread.

Prior art: Anthropic's Claude Tag (claude.com/docs/claude-tag). We steal its state
model and drop its infrastructure — no sandboxes (real filesystem), no service
accounts (one bot, operator's creds).

## Vocabulary

- **Message** — one inbound Slack message (event).
- **Conversation** — a channel's rolling top-level conversation, an explicit Slack thread, or one rolling DM conversation; owns exactly one Session. Key: `(channel_id, conversation_key)`.
- **Session** — the SDK conversation transcript, persisted as jsonl by the SDK,
  addressed by `session_id`.
- **Run** — one `query()` invocation. A run may absorb several Messages via
  streaming input (steering). A Conversation has at most one live Run. A Run spans one
  or more SDK *turns*; each completed turn emits a `result` message.
- **Curation run** — the post-run memory sweep on haiku.

## Constraints

- Single operator, personal Slack workspace. No allowlist v1. Corollary: **never
  invite the bot to Slack Connect / externally shared channels** — external users
  would have full command of it.
- Runs as a pm2 daemon; must survive restarts with no session loss (same SDK
  version — major SDK upgrades may orphan old sessions, accepted below).
- Socket Mode only — no inbound ports on ultra.
- SDK version pinned in package.json; streaming-input semantics re-verified on bump.
- **SDK isolation**: every `query()` (main and curation) pins
  `settingSources: []`, `skills: []`, `strictMcpConfig: true`. Without this the
  SDK's default is to load **all** settings sources — permission rules, hooks,
  plugins, skills, MCP servers, and CLAUDE.md files could silently join every
  Run and bypass the approval gate. Authentication remains an explicit provider
  choice: local Claude subscription, Anthropic API key, or VibeProxy.
- YAGNI throughout: the SDK owns the agent loop, tools, permissions plumbing,
  session persistence, context compaction. We own the glue (~700 lines).

## State model (from Claude Tag)

| Decision | Implementation |
|---|---|
| Conversation = session; conversations share nothing | `threads` table maps conversation key → `session_id` |
| Conversation durable, execution ephemeral | SDK persists sessions as jsonl under `~/.claude/projects/`; a Run resumes, works, exits. No long-lived agent processes between Runs. |
| Access follows the channel | `data/channels/<id>/config.json`: repos, permissionMode, model |
| Top-level channel messages need no mention; tracked threads need no re-mention | Every top-level human channel message and every human reply in a tracked thread feeds its session |
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
  index.ts      Bolt wiring: message events → filter/dedupe → route; button
                actions; boot sweep; shutdown handler                          ~130
  runs.ts       Run owner: per-thread serialization, streaming input queue,
                options assembly, SDK stream → status/result posting,
                stall watchdog, resume pre-check                               ~200
  store.ts      SQLite thread rows (bun:sqlite, WAL)                            ~40
  channels.ts   channel context: config load+validate, CHANNEL.md/MEMORY.md,
                system-prompt append assembly, model alias resolution,
                channel-name cache (conversations.info)                        ~80
  approvals.ts  canUseTool ↔ Block Kit promise bridge                          ~90
  memory.ts     curation run + memory_append/memory_replace tools              ~60
data/
  channels/<channel_id>/{config.json, CHANNEL.md, MEMORY.md, workspace/}
  bot.sqlite
models.json      Slack alias → model + optional provider profile
providers.json   provider profiles: subscription, API key, local proxy
.env             SLACK_BOT_TOKEN, SLACK_APP_TOKEN; optional ANTHROPIC_API_KEY
```

All paths resolved from the module dir, never `process.cwd()` (pm2 cwd varies).

Module boundaries (deletion-test checked): `runs.ts` is the single owner of run
lifecycle — `index.ts` only parses/filters Slack events and calls
`dispatch(inbound)`. Model alias resolution lives with channel config in
`channels.ts` (a separate `models.ts` failed the deletion test: its interface was
its implementation). `approvals.ts` and `memory.ts` stay separate: each hides a
real mechanism (promise bridge; curation protocol) behind a one-call interface.

Dependencies: `@slack/bolt`, `@anthropic-ai/claude-agent-sdk` (pinned), `bun:sqlite`.

### SQLite schema

```sql
PRAGMA journal_mode = WAL;
CREATE TABLE threads (
  channel_id       TEXT NOT NULL,
  thread_key       TEXT NOT NULL,  -- channel_id for top-level channels/DMs; thread_ts for Slack threads
  session_id       TEXT,           -- null until first SDK init (e.g. bare [alias] creates the row)
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

Group DMs (`message.mpim`) are **not** subscribed: the bot is deaf in group DMs
(explicit non-goal, see cut list).

Filter (in order):
1. **Dedupe**: Socket Mode is at-least-once (unacked envelopes are redelivered,
   reconnects can replay). LRU set (~1k) on `event_id`; seen → drop. This is what
   makes acceptance #1 ("exactly one Run") enforceable, not aspirational.
2. Drop messages with `bot_id`, from self, or from `USLACKBOT` (Slackbot
   reminders have a plain `user`, no `bot_id`). Intentional side effect: other
   bots/workflows can never steer a session — only humans.
3. Subtype allow-list: process only `undefined`, `file_share`, and
   `thread_broadcast`. A message with an attached file + caption arrives as
   subtype `file_share` — the caption is a real prompt (files themselves are not
   ingested v1; the agent is told a file was attached and skipped). A thread
   reply with "also send to #channel" arrives as `thread_broadcast` — it is real
   steering. Blanket subtype-drop would silently eat both. Everything else
   (edits, deletes, joins) drops — matches Claude Tag: editing a message never
   changes what the agent already received.
4. Drop empty-text messages (blocks-only edge cases) unless they carry a model token.

Conversation key:
- Top-level channels/groups: `channel_id` — one rolling session per channel. The
  bot posts status and results as new channel messages.
- Explicit Slack threads: `thread_ts` — one isolated session per thread. The bot
  posts status and results inside that thread.
- DMs (`im`): `channel_id` — one rolling session per DM conversation. Slack DMs
  *do* support threads; a threaded DM reply still folds into the rolling session
  and the bot replies top-level. Per-message sessions would amnesia every exchange.

Routing:
- Every top-level human message in a joined channel/group starts or steers that
  channel's rolling session. No mention is required. This intentionally makes
  the bot an active channel participant; every message can incur model cost.
- Tracked explicit thread → continue/steer the thread session without a mention.
- Untracked explicit thread + bot mention → start a thread session. A first mention
  landing mid-thread fetches prior context via `conversations.replies` (cap 50)
  and prepends it to the first prompt. (The 2025 non-Marketplace clamp applies
  only to distributed apps; never enable distribution for this app.)
- Untracked explicit thread without a mention → ignore.
- Any DM message → start or steer the rolling DM session.

### Model token

- Parsed on **any** inbound message for a thread: a *leading* `[alias]` token,
  case-insensitive.
- Known alias → strip before prompting, persist on the thread row. Takes effect
  on the Run it starts; if a Run is live, on the next Run.
- **Unknown token → treat as plain text and run normally.** (Rev 2 blocked the
  Run and nagged; that false-positives on ordinary prefixes like "[WIP] fix the
  tests". Typos are silently literal — accepted; discoverability below.)
- Reserved token `[models]` → reply with known aliases + current resolution for
  this conversation; no Run.
- Bare alias-only message (`[opus]` and nothing else) → persist, reply
  "switched to opus", **no Run** (empty prompt).
- Persisted alias later removed from models.json → resolve to default, warn once
  in-thread.

## Channel ↔ repo interface

```jsonc
// data/channels/C0XXXX/config.json — all fields optional
{
  "repos": ["~/Projects/foo", "~/Projects/bar"],  // → additionalDirectories, ~ expanded to absolute
  "model": "sonnet",                               // channel default alias
  "permissionMode": "default"                      // or "acceptEdits" — nothing else accepted
}
```

```jsonc
// <repo root>/permissions.json — server-wide standing grants, all fields optional
{
  "directories": ["~/Projects"],        // merged into every channel's repos
  "commandPrefixes": ["pm2", "git status"] // merged into every channel's allowedCommands
}
```

- Server layer (operator decision, 2026-07-14): `permissions.json` grants merge
  into **every** channel's effective `repos`/`allowedCommands` at context load
  (channel entries first, deduped). Missing file = no server grants; unparseable
  or invalid file, or a nonexistent directory → refuse the Run like a bad channel
  config. Unknown keys warn. Relative `directories` resolve against the file's
  own directory; `~` expands. Because cron builds `allowedTools` from the same
  effective config, server `commandPrefixes` apply to unattended fires in every
  channel.

- Channel config is validated at Run start: unparseable JSON, unknown
  `permissionMode` value, or a nonexistent repo path → **refuse the Run** and
  post the error in-thread (explicit beats silently running without repo
  access). Unknown keys → warn in logs, continue.
- `cwd` is always the channel's `workspace/` dir (scratch, generated files,
  MEMORY.md lives beside it). Repos attach via `additionalDirectories` (absolute
  paths after `~` expansion). Uniform for 0..N repos. Note: `workspace/` is
  shared by all threads in the channel — concurrent Runs can collide on scratch
  files (accepted, same class as repo-write races).
- `CHANNEL.md` (hand-written: channel purpose, repo descriptions, conventions) and
  `MEMORY.md` are injected every Run via
  `systemPrompt: { type: "preset", preset: "claude_code", append }`. The append is
  assembled in one place (`channels.ts`) and carries:
  - a header naming the Slack channel (via `conversations.info`, cached at Run
    start; needs the `*:read` scopes below) and thread,
  - the **resolved repo paths** from config (CHANNEL.md may omit or drift; the
    agent must always know what it can touch),
  - "format replies as Slack mrkdwn" (agents emit standard markdown otherwise;
    Slack renders mrkdwn — bold/links would break),
  - MEMORY.md, tail-truncated at 16KB with a warning line (an unbounded file
    must not eat the context window).
- CLAUDE.md: with `settingSources: []` the SDK loads **no** CLAUDE.md at all
  (loading requires the `project` source — sdk.d.ts). Repo conventions reach the
  agent the explicit way: CHANNEL.md tells it to `Read` the repo's own CLAUDE.md
  when relevant.
- Inbound user messages are prefixed `<@U…>: ` before feeding the session — the
  agent can attribute multi-user steering without `users:read`.
- Unknown conversation id (e.g. a DM) → auto-create the channel dir with empty
  config. DMs work with zero setup, no repo access until configured.

## Model and provider switching

```jsonc
// providers.json — re-read every Run
{
  "default": "claude-subscription",
  "profiles": {
    "claude-subscription": { "mode": "claude-subscription" },
    "anthropic-api":       { "mode": "api-key" },
    "vibeproxy": {
      "mode": "proxy",
      "env": {
        "ANTHROPIC_BASE_URL": "http://127.0.0.1:8317",
        "ANTHROPIC_AUTH_TOKEN": "dummy-not-used"
      }
    }
  }
}

// models.json — re-read every Run
{
  "default": "fable-low",
  "aliases": {
    "fable-low": { "model": "claude-fable-5", "effort": "low", "providerProfile": "vibeproxy" },
    "sonnet": { "model": "sonnet" },
    "opus":   { "model": "opus" },
    "haiku":  { "model": "haiku" },
    "sol":    { "model": "gpt-5.6-sol",   "providerProfile": "vibeproxy" },
    "terra":  { "model": "gpt-5.6-terra", "providerProfile": "vibeproxy" },
    "luna":   { "model": "gpt-5.6-luna",  "providerProfile": "vibeproxy" }
  }
}
```

- Boot validation: both files must parse, both defaults must exist, every model's
  `providerProfile` must name a known profile; otherwise fail fast.
- Model resolution remains thread override → channel `model` → model default.
- Provider-profile resolution is model `providerProfile` → provider default.
  Main and curation Runs use the same resolver; curation runs only when the
  `haiku` alias exists.
- Provider profiles own access/routing mechanics; model aliases own model choice
  and optional SDK reasoning `effort`. Options receive the resolved `model`,
  `effort`, `env`, and optional executable.
- SDK `env` replaces the subprocess environment. Resolution starts from
  `process.env`, strips Slack secrets and ambient Anthropic credentials/routes,
  then applies profile env and per-model env. API-key profiles require a key;
  proxy profiles require an explicit base URL.
- `claude-subscription` uses the local Claude Code login and works with
  `settingSources: []`: settings/MCP isolation is separate from authentication.
  `anthropic-api` requires `ANTHROPIC_API_KEY`. `vibeproxy` targets its
  Anthropic-compatible `/v1/messages` endpoint and can route GPT/Codex models.
- VibeProxy/alternative models require a Read + Edit scratch-repo smoke before
  production use; protocol compatibility is broader than text-only success.
- This remains a single-operator local tool. Anthropic's Agent SDK docs say
  third-party products generally should use API auth unless separately approved;
  never distribute this bot as a subscription gateway.
- Mid-thread switches remain safe: the resumed transcript is model/provider
  agnostic. Changes apply on the next Run.

## Run lifecycle

Every Run uses **streaming input mode** (`prompt` as `AsyncIterable<SDKUserMessage>`).
Non-negotiable: mid-run steering, `interrupt()`, and `setModel()` are all
streaming-only per the SDK reference; a string prompt cannot absorb a second
message.

1. `dispatch(inbound)` appends the message to the thread's queue. Live Run →
   the input generator picks it up (steering; also works while a Run is blocked
   on an approval). Idle → start a Run. The Bolt listener never awaits Run
   completion — ack fast, work async.
2. **Resume pre-check**: row exists → `getSessionInfo(session_id)` first. Missing
   (deleted jsonl, SDK format break) → clear the row's session, start fresh, and
   prefix the prompt with "(previous session lost; starting fresh)". Without
   this, one orphaned session bricks its thread forever — every reply would
   re-error.
3. The input generator drains the queue. Close condition: the latest `result`
   message has arrived AND the queue is empty → close the iterable, Run ends.
   The check-and-close must be atomic with `dispatch` (same tick) — a message
   landing in the gap must either join this Run or start the next, never sit in
   a dead queue. Messages arriving after close are serialized by the per-thread
   promise chain into the next Run.
4. Options per Run: `cwd`, `additionalDirectories`, `systemPrompt` preset+append,
   resolved model/provider `model` + `env` + optional executable,
   `permissionMode`, `canUseTool`, `maxBudgetUsd` (global cap, default 5),
   `disallowedTools`, `settingSources: []`, `skills: []`,
   `strictMcpConfig: true`, `abortController`.
5. On the SDK init message (`subtype: "init"`): store `session_id` immediately
   (crash-safe — a mid-run death still leaves a resumable row; the id is stored
   whether fresh or resumed), set `active_status_ts` to the just-posted status
   message, log the provider profile and SDK `apiKeySource`; provider selection
   is authoritative, while the SDK field is observability evidence.
6. Progress: `chat.update` the status message with the current tool/todo line
   (from complete assistant messages' `tool_use` blocks — no
   `includePartialMessages` needed), throttled ≥1s. The status message carries a
   **Stop button** → `interrupt()`; a second click aborts the controller. Without
   it there is no way to halt a runaway Run short of pm2 restart.
7. **Stall watchdog**: no SDK stream message for 30 min → `abort()` → error path.
   A hung tool/endpoint must not wedge the thread forever (`maxBudgetUsd` bounds
   spend, not time).
8. On result:
   - `success` → post final text as a thread reply (>4000 chars →
     `files.uploadV2` snippet with `thread_ts`; empty text → "(no text output)").
   - `error_max_turns` / `error_max_budget_usd` / `error_during_execution` →
     these carry `errors: string[]` and **no** `result` text; post the errors
     plus "reply to continue from the last completed state" (resume stays valid).
   - Success: delete the transient status message after posting the result.
   - Error: finalize it as `⛔ stopped`, clear `active_status_ts`, and log the
     model, `total_cost_usd`, `modelUsage`, and `permission_denials`. Slack does not expose model or cost.
9. Curation run if the main Run used any tool.
10. Errors (query throw): post the error in-thread, clear `active_status_ts`.
    The row is otherwise untouched — resume remains valid from the last
    completed state.

Boot sweep: on startup, for every row with non-null `active_status_ts`, update
that message to "interrupted by restart — reply to resume" and clear the field.
(A crash in the gap between final post and row update marks a *completed* Run
interrupted — cosmetic, accepted.) On SIGINT/SIGTERM: abort live Runs and run the
same marking before exit.

Per-thread serialization: a promise chain per thread key — two events for one
thread never race. No global concurrency cap v1 (512GB machine; accepted).

Known gap (accepted): a crash *before* the first Run's init message leaves no
row — the thread is untracked and follow-up replies are silently ignored until
someone re-mentions the bot.

## Write safety

- `canUseTool` → Block Kit message in the thread: prefer the SDK-provided
  `title` / `displayName` / `description` / `decisionReason` / `blockedPath`
  fields (sdk.d.ts CanUseTool options) over reconstructing from raw
  toolName+input; fall back to a truncated input preview (≤2900 chars —
  Block Kit section text caps at 3000). Approve / Deny buttons; resolved by the
  button action; auto-deny after 10 minutes with message "timed out". First
  click wins; the resolution message records who clicked. A click on an
  expired/resolved approval gets the message updated to say so. Only fires when
  the SDK permission flow falls through to a prompt — reads and pre-approved
  rules never ping Slack.
- **Fail-closed invariant**: `canUseTool` must always resolve to a
  `PermissionResult` (deny requires a `message`). Returning `null` (or never
  resolving) blocks the tool *indefinitely* — permission prompts have no park
  deadline in the SDK. The 10-minute timer is load-bearing, not a nicety.
- Per-channel dial: `permissionMode: "default"` = every write gated (note: Bash
  gets gated even for read-only commands — approval fatigue is the cost of
  default mode; `acceptEdits` is the dial);
  `"acceptEdits"` = file edits within cwd+repos flow, Bash still gated,
  out-of-scope paths still prompt (surfaced via `blockedPath`).
- Operator override (2026-07-14): all Runs receive `/Users/jaredsmith/Projects`
  in `additionalDirectories` and `allowedTools: ["Bash(*)"]`; Bash therefore
  bypasses Slack approval prompts globally. Non-Bash gated tools still use the
  approval bridge. Approved `allow` responses echo the original tool input as
  `updatedInput` because SDK 0.3.201 runtime validation requires it despite the
  declaration marking it optional.
- Bash safety boundary: an explicit SDK `PreToolUse` hook invokes
  `/Users/jaredsmith/.local/bin/dcg` for every Bash tool call. DCG's deny result
  blocks destructive variants such as `git reset --hard`, `git clean -f`, and
  dangerous `rm -rf` targets even though Bash otherwise bypasses Slack approval.
  The hook is injected programmatically while `settingSources: []` remains in
  force, so unrelated user hooks/plugins/settings do not join Slack Runs.
- Defense in depth: `disallowedTools: ["Bash(rm -rf:*)"]` remains as a narrow
  SDK-native speed bump; DCG is the broader Bash guard.
- Repo writes hit live checkouts (operator decision, 2026-07-13): the approval
  gate plus thread visibility is the mitigation for concurrent edits — by the
  operator, by *other threads* of this bot, or by other local agents on ultra
  (all the same race). Upgrade path if clashes hurt: worktree-per-thread
  (~40 lines, not v1).

## Memory

- After any tool-using Run (includes TodoWrite-only runs — noise accepted for a
  simple trigger): one `query()` with:
  - `resume: session_id, forkSession: true, persistSession: false` — **this is
    how the curator sees the conversation**; rev 2 never said, and a fresh query
    would have no context at all. The fork+no-persist combo (read transcript,
    write nothing) needs a build-time smoke test.
  - the configured `haiku` model alias and its resolved provider profile;
    curation is skipped and logged if `haiku` is absent. Options include
    `maxTurns: 4`, plain-string `systemPrompt`, `settingSources: []`, and the
    same provider environment isolation.
  - `tools: []` + `mcpServers: {memory}` + `allowedTools` naming exactly the two
    `mcp__memory__*` tools + `permissionMode: "dontAsk"`. (Rev 2 relied on
    `allowedTools` alone "denying everything else" — wrong: `allowedTools` only
    auto-*approves*; permission-free tools like Read/Grep would still run. The
    `tools: []` option is what removes built-ins; `dontAsk` is the belt.)
- SDK MCP server (`createSdkMcpServer`) exposing:
  - `memory_append(text)` — append an ISO-dated entry
  - `memory_replace(old, new)` — edit/compact existing entries
- Prompt: persist only what survives this conversation — durable facts, decisions,
  operator preferences, repo gotchas; not task minutiae. Current MEMORY.md size
  is injected; instruct consolidation when it exceeds ~8KB.
- Curation runs are serialized **per channel** (two threads finishing together
  would race append/replace on the same file).
- Curation failure: log and move on — never blocks or posts to the thread.
- MEMORY.md is plain markdown in the channel dir — operator-editable, greppable,
  in git if desired.

## Slack app config

- Socket Mode on; app-level token with `connections:write`.
- **Interactivity toggled on** (required for button actions; payloads arrive over
  the socket, no Request URL).
- **App Home → Messages Tab enabled** — without it users cannot DM the bot at all
  ("Sending messages to this app has been turned off").
- Bot scopes: `channels:history`, `groups:history`, `im:history`, `chat:write`,
  `files:write`, plus `channels:read`, `groups:read`, `im:read` (for
  `conversations.info` channel naming in the system-prompt header).
  (`app_mentions:read` not needed — see Event model.) Reinstall to the workspace
  after any scope change.
- Events: `message.channels`, `message.groups`, `message.im`.
- Bot must be `/invite`d to a channel to receive its events.
- Keep the app **single-workspace internal** — never enable distribution (rate
  limits, see Event model) and never add it to Slack Connect channels (no
  allowlist, see Constraints).
- Dev workflow: never point a second process at the production app's tokens —
  Slack fans envelopes across up to 10 Socket Mode connections, so a second
  consumer *splits* event delivery (and pm2 must run exactly one instance).
  Use a separate dev Slack app.

## Observability

One JSON line to stdout per inbound event, Run start/end (with session_id, model,
cost, `apiKeySource`, `permission_denials` count), approval decision, curation
outcome, and error; SDK `stderr` callback piped to the same stream. `pm2 logs
slackbot` is the debugging interface. No log files, no metrics stack.

## Cut list (explicit non-goals, with upgrade paths)

- Cron/heartbeat routines — later; same `query()` path, post only if non-SILENT.
- Cross-channel/workspace-shared memory.
- Session transcript viewer — SDK `listSessions()`/`getSessionMessages()` +
  html-home page whenever wanted.
- Message-edit handling (`message_changed`) — matches Claude Tag: no rewind. A
  user who edits-to-add a mention gets nothing; send a new message.
- Group DMs (`message.mpim`) — bot is deaf there; add the event + `mpim:history`
  + channel-keyed sessions if ever wanted.
- File/attachment ingestion — `file_share` captions are processed (see Event
  model), file contents are not.
- User allowlist, multi-workspace, `users:read` display-name resolution,
  reaction signals.
- "Always allow" buttons (SDK supports via `suggestions`/`updatedPermissions` on
  the canUseTool bridge — natural v2).
- Worktree isolation (see Write safety).
- File checkpointing (`enableFileCheckpointing`) — upgrade path if mid-run
  interruptions leaving partial edits becomes a real problem.
- `fallbackModel` for provider outages.

## Residual risks (accepted)

- **Bolt + Bun + Socket Mode is unverified** — acceptance #0 exists to kill this
  risk first, before any other line is written.
- pm2 restart mid-Run leaves partially applied repo edits; visible via `git diff`,
  recoverable by replying to the thread. Checkpointing is the upgrade path.
  `pm2 kill` (SIGKILL) may additionally orphan a claude CLI child briefly — set
  a `kill_timeout` so SIGINT-based cleanup gets to run.
- Socket disconnect can drop events beyond Slack's redelivery window; the user
  re-pings. No event-replay machinery v1.
- SDK jsonl/session format is SDK-owned; a major upgrade may orphan old sessions.
  The resume pre-check turns that into "conversation starts fresh with a notice",
  not a bricked conversation.
- mrkdwn fidelity is prompt-enforced only; agent output is posted unescaped, so
  literal `<`, `>`, `&` sequences can render oddly and an emitted `<!channel>`
  would ping (personal workspace — accepted).
- Every top-level human channel message and every human reply in a tracked thread
  is a paid model turn. Ordinary channel chatter therefore costs money; cost logs remain visible.

## Acceptance criteria (v1)

0. **Pre-flight**: Bolt on Bun connects via Socket Mode, receives a message
   event, posts a reply (kills the only unverified platform assumption).
1. One non-empty top-level human message in a configured channel produces exactly
   one channel-session row and one Run; a synthetically re-delivered duplicate
   event (same `event_id`) does not produce a second Run; status and result post
   as top-level channel messages.
2. A second top-level channel message continues the same session (the agent can
   reference the earlier exchange) without requiring an `@bot` mention.
3. A message sent while the channel Run is live folds into the running work.
4. An `@bot` mention in an untracked explicit Slack thread creates a separate
   thread session; later plain replies continue it and results remain in-thread.
5. In a `default`-mode channel, a file write produces Approve/Deny buttons; Deny
   blocks the write; 10-minute silence denies.
6. `[opus]` on any message switches that conversation's model (verify via the
   result message's `modelUsage` keys) and persists for subsequent Runs. A bare
   `[opus]`-only message switches, confirms, and runs nothing. `[WIP] fix tests`
   runs normally with the token left as text.
7. After a substantive task, MEMORY.md gains an entry that demonstrably
   references facts from the conversation (proves the curation fork sees the
   transcript); a new conversation in the same channel demonstrably knows it.
8. A DM with no prior config gets an auto-created channel dir; a second top-level
   DM message continues the same session.
9. `pm2 restart` while idle: the next message in an old conversation resumes its
   session. Restart mid-Run: the status message reads "interrupted by restart",
   and the next message resumes from the last completed state.
10. A message with an attached image + text caption steers the session
    (`file_share` not dropped); a "also send to channel" reply steers
    (`thread_broadcast` not dropped).
11. Delete a conversation's session jsonl; the next message starts a fresh session
    with a "(previous session lost)" notice — the conversation is not bricked.
12. Stop button on a live Run interrupts it within seconds; the conversation
    resumes on the next message.
