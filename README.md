# Slackbot

Slackbot is a channel-scoped Claude agent that runs in Slack through Socket Mode. Each joined channel has one rolling top-level Claude session, and each explicit Slack thread has its own session. Channel configuration remains isolated while one pm2 daemon serves the workspace.

See the [design specification](docs/superpowers/specs/2026-07-13-slackbot-design.md) for architecture and accepted risks.

## Slack app setup

1. Enable **Socket Mode** and create an app-level token with `connections:write`.
2. Turn **Interactivity** on; Socket Mode receives button-action payloads, so no Request URL is needed.
3. Enable **App Home → Messages Tab** so users can DM the bot.
4. Add bot scopes: `channels:history`, `groups:history`, `im:history`, `chat:write`, `files:write`, `channels:read`, `groups:read`, and `im:read`.
5. Subscribe to `message.channels`, `message.groups`, and `message.im` events.
6. Reinstall the app in the workspace after any scope change, then `/invite` the bot to each channel it should serve.
7. Keep the app internal to one workspace: never enable distribution or add it to Slack Connect channels.
8. Use a separate Slack app for development. A second process using production tokens splits Socket Mode event delivery.

## Local setup

```bash
bun install
cp .env.example .env
pm2 start ecosystem.config.cjs
```

Set the two Slack tokens in `.env`. `ANTHROPIC_API_KEY` is optional: it is used only by the `anthropic-api` provider profile. The default `claude-subscription` profile uses the local Claude Code login (`claude auth status` should report `loggedIn: true`). pm2 runs exactly one instance because Socket Mode distributes envelopes across connections.

## Per-channel configuration

Configure a channel in `data/channels/<id>/config.json`:

```json
{
  "repos": ["/absolute/path/to/repo"],
  "model": "sonnet",
  "permissionMode": "default"
}
```

`repos` lists accessible repositories (`allowedCommands` adds auto-approved Bash prefixes). `model` selects the channel default; `permissionMode` is `default` or `acceptEdits`. Put a `CHANNEL.md` beside `config.json` to describe the channel's purpose, working conventions, and relevant repositories for the agent.

## Server-wide permissions

`permissions.json` at the repo root grants directories and Bash command prefixes to **every** channel (interactive Runs and cron jobs alike):

```json
{
  "directories": ["~/Projects"],
  "commandPrefixes": ["pm2", "git status"]
}
```

Server grants merge with each channel's own `repos`/`allowedCommands`; channel entries stay the place for channel-specific additions. A missing file grants nothing; an invalid file or nonexistent directory refuses Runs until fixed.

## Slack behavior

- Every non-empty human message posted at the top level of a joined channel starts or steers that channel's rolling session. No `@Skör` mention is required.
- Status and final output for top-level messages appear as new channel messages, not thread replies.
- An explicit Slack thread remains a separate session. Mention Skör to start an untracked thread; later human replies in that tracked thread steer it without another mention.
- Messages from bots, workflows, Slackbot, and Skör itself are ignored.

## Models and providers

- Send `[models]` to list available aliases.
- Prefix work with an alias, such as `[opus] investigate the failing test`, to switch the current channel or thread session's model.
- Send a bare alias token, such as `[terra]`, to switch that session and confirm without running work.
- Use `[fable-low]` to select Fable 5 with low reasoning effort through VibeProxy.

`models.json` maps Slack aliases to SDK model names, optional reasoning `effort`, and an optional `providerProfile` from `providers.json`. `fable-low` maps to VibeProxy's `claude-fable-5` with low effort. The Claude aliases (`sonnet`, `opus`, `haiku`) use the local Claude subscription. `sol`, `terra`, and `luna` use VibeProxy at `http://127.0.0.1:8317`.

`providers.json` defines provider profiles:

- `claude-subscription`: local Claude Code login; removes Anthropic API and routing credentials inherited from the daemon.
- `anthropic-api`: requires `ANTHROPIC_API_KEY` for normal Anthropic API billing.
- `vibeproxy`: sets the Anthropic-compatible base URL and local proxy auth token.

Resolution starts from `process.env`, strips Slack secrets and ambient Anthropic credentials/routes, then applies the selected profile and per-model `env` overrides. Main and curation Runs use the same provider-profile resolver. VibeProxy must be running and the relevant provider must show connected in its menu-bar settings.

This is a single-operator local tool. Anthropic's Agent SDK documentation says third-party products generally should use API authentication unless separately approved; do not distribute the bot as a Claude subscription gateway.

## Operations

Use `pm2 logs slackbot` as the debugging interface; the service emits JSON lines to stdout and does not write log files. `pm2 restart` while a Run is active marks its status message `interrupted by restart`; the next message in that channel or thread resumes from the last completed state. The pm2 `kill_timeout` leaves time for SIGINT cleanup before forced termination.

Completed status messages show only `✅ done` or `⛔ stopped`. Model selection and cost remain available in `pm2 logs slackbot`, not in Slack.
