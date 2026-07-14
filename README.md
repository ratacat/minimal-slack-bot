# Minimal Slack Bot

Minimal Slack Bot is a small, self-hosted AI agent for Slack, built on the Claude Agent SDK. It runs as one Bun process on your own machine and connects to Slack over Socket Mode, so there is no server to deploy and no public URL to expose. Each joined channel gets a rolling Claude session, and each Slack thread gets its own session. Point a channel at your repositories and the agent can read code, run commands, and edit files, with approval buttons in Slack for anything outside its standing grants.

See the [design specification](docs/superpowers/specs/2026-07-13-slackbot-design.md) for architecture and accepted risks.

## Slack app setup

1. Enable **Socket Mode** and create an app-level token with `connections:write`.
2. Turn **Interactivity** on. Socket Mode receives button clicks, so no Request URL is needed.
3. Enable **App Home > Messages Tab** so users can DM the bot.
4. Add bot scopes: `channels:history`, `groups:history`, `im:history`, `chat:write`, `files:write`, `channels:read`, `groups:read`, and `im:read`.
5. Subscribe to `message.channels`, `message.groups`, and `message.im` events.
6. Reinstall the app in the workspace after any scope change, then `/invite` the bot to each channel it should serve.
7. Keep the app internal to one workspace. Never enable distribution or add it to Slack Connect channels.
8. Use a separate Slack app for development. A second process using production tokens splits Socket Mode event delivery.

## Local setup

```bash
bun install
cp .env.example .env
pm2 start ecosystem.config.cjs
```

Set the two Slack tokens in `.env`. `ANTHROPIC_API_KEY` is optional: only the `anthropic-api` provider profile uses it. The default `claude-subscription` profile uses the local Claude Code login (`claude auth status` should report `loggedIn: true`). pm2 runs exactly one instance because Socket Mode distributes events across connections.

## Per-channel configuration

Configure a channel in `data/channels/<id>/config.json`:

```json
{
  "repos": ["/absolute/path/to/repo"],
  "model": "sonnet",
  "permissionMode": "default"
}
```

`repos` lists the repositories the channel can reach. `allowedCommands` adds auto-approved Bash prefixes. `model` selects the channel default. `permissionMode` is `default` or `acceptEdits`. Put a `CHANNEL.md` beside `config.json` to describe the channel's purpose, working conventions, and relevant repositories for the agent.

## Server-wide permissions

`permissions.json` at the repo root grants directories and Bash command prefixes to **every** channel, for both interactive Runs and cron jobs:

```json
{
  "directories": ["~/Projects"],
  "commandPrefixes": ["pm2", "git status"]
}
```

Server grants merge with each channel's own `repos` and `allowedCommands`. Channel entries stay the place for channel-specific additions. A missing file grants nothing. An invalid file or a nonexistent directory refuses Runs until fixed.

## Slack behavior

- Every non-empty human message posted at the top level of a joined channel starts or steers that channel's rolling session. No @-mention is required.
- Status and final output for top-level messages appear as new channel messages, not thread replies.
- An explicit Slack thread is a separate session. Mention the bot to start one; later human replies in that tracked thread steer it without another mention.
- Messages from other bots, workflows, Slack's built-in Slackbot, and the agent itself are ignored.

## Models and providers

- Send `[models]` to list available aliases.
- Prefix work with an alias, such as `[opus] investigate the failing test`, to switch the current channel or thread session's model.
- Send a bare alias token, such as `[terra]`, to switch that session and confirm without running work.

`models.json` maps Slack aliases to SDK model names, optional reasoning `effort`, and an optional `providerProfile` from `providers.json`. `providers.json` defines provider profiles:

- `claude-subscription`: local Claude Code login. Removes Anthropic API and routing credentials inherited from the daemon.
- `anthropic-api`: requires `ANTHROPIC_API_KEY` for normal Anthropic API billing.
- `vibeproxy`: sets an Anthropic-compatible base URL and a local proxy auth token, for routing aliases through a local proxy.

Resolution starts from `process.env`, strips Slack secrets and ambient Anthropic credentials and routes, then applies the selected profile and per-model `env` overrides. Main and curation Runs use the same resolver.

This is a single-operator local tool. Anthropic's Agent SDK documentation says third-party products generally should use API authentication unless separately approved. Do not distribute the bot as a Claude subscription gateway.

## Cron jobs

Send `[cron]` in a channel for the command list. Jobs use standard 5-field cron expressions, run unattended with only that channel's allowed commands, and post their reports to the channel. A job that has nothing to report stays quiet.

## Operations

Use `pm2 logs minimal-slack-bot` as the debugging interface. The service emits JSON lines to stdout and does not write log files. `pm2 restart` while a Run is active marks its status message `interrupted by restart`; the next message in that channel or thread resumes from the last completed state. The pm2 `kill_timeout` leaves time for SIGINT cleanup before forced termination.

Completed status messages show only `✅ done` or `⛔ stopped`. Model selection and cost stay in `pm2 logs minimal-slack-bot`, not in Slack.

## Why a minimal Slack AI agent

Most Slack AI bots are either hosted services you cannot inspect or large multi-platform gateways with many moving parts. Minimal Slack Bot takes the opposite approach:

- **Small enough to read.** About 1,900 lines of TypeScript across ten files, plus a test suite covering routing, runs, cron, approvals, permissions, and memory. You can audit the entire bot in an afternoon.
- **One process, no cloud.** A single pm2-managed Bun process. Socket Mode means no webhook endpoint, no tunnel, no load balancer, and nothing to deploy.
- **Real repository access.** Channels map to repositories on the machine it runs on. The agent works in real checkouts, behind a permission gate, a Bash safety hook, and Slack approval buttons.
- **Your credentials, your bill.** Use a local Claude Code login, a plain Anthropic API key, or any Anthropic-compatible proxy. Switch models per channel or per thread with a `[alias]` token.
- **Durable sessions.** Sessions, cron jobs, and channel memory live in SQLite and plain files. Reply in a thread after a restart and the conversation resumes where it stopped.

## Alternatives

Different tools fit different needs. If you are choosing a Slack AI bot or a self-hosted AI agent, here is the honest landscape:

- **[OpenClaw](https://github.com/openclaw/openclaw)**: the popular self-hosted gateway that connects Slack, WhatsApp, Telegram, Discord, and many other messaging platforms to AI agents. Great when you want one assistant across all your chat apps. It is a much larger system with a much larger surface area; Minimal Slack Bot is the small, Slack-only alternative you can read end to end.
- **[Hermes Agent](https://github.com/nousresearch/hermes-agent)** (Nous Research): an open-source, provider-agnostic agent framework with a Slack gateway and a self-improving skill loop. A strong choice if you want one agent identity across terminal and messaging apps. Minimal Slack Bot trades that breadth for a tiny, channel-centric codebase built directly on the Claude Agent SDK.
- **Claude Tag** (Anthropic): the hosted AI teammate for Slack. Official and zero-maintenance, but closed, cloud-only, and not connected to your local repositories. Minimal Slack Bot borrows its state model (channel and thread sessions) and drops the infrastructure: no sandboxes, no service accounts, your filesystem.
- **Hosted Slack AI apps** (Slack AI, GPT bot builders, no-code assistants): the fastest install, but they cannot touch your local filesystem, run your commands, or work inside your repositories.

Pick this project if you want a minimal self-hosted Slack AI agent, a Claude coding agent that lives in Slack, or a ChatOps-style AI teammate for a single operator or a small team, with every line under your control.
