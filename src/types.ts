/**
 * Shared contracts between modules. Pure types only — no runtime code.
 * Spec: docs/superpowers/specs/2026-07-13-slackbot-design.md
 */
import type { CanUseTool, Options, Query, getSessionInfo, query } from "@anthropic-ai/claude-agent-sdk";

export type ChannelType = "channel" | "group" | "im";

/** One inbound Slack message after index.ts filtering. Bot mention already stripped from text. */
export interface InboundMessage {
  channelId: string;
  channelType: ChannelType;
  /** channels/groups: thread_ts ?? ts. DMs: channelId (rolling session). */
  threadKey: string;
  /** This message's ts. */
  ts: string;
  /** Set when the message is a reply inside a Slack thread. */
  threadTs?: string;
  userId: string;
  /** Bot mention stripped, trimmed. May still carry a leading [alias] token. */
  text: string;
  mentionsBot: boolean;
  /** Synthesized note when subtype=file_share: files were attached but not ingested. */
  fileNote?: string;
}

/** data/channels/<id>/config.json after validation + ~ expansion. */
export interface ChannelConfig {
  /** Absolute repo paths (validated to exist) → additionalDirectories. */
  repos: string[];
  /** Channel default model alias. */
  model?: string;
  permissionMode: "default" | "acceptEdits";
}

export interface ModelAlias {
  model: string;
  env?: Record<string, string>;
}

export interface ModelsConfig {
  default: string;
  aliases: Record<string, ModelAlias>;
}

export interface ThreadRow {
  channelId: string;
  threadKey: string;
  /** null = no session yet (e.g. bare [alias] message created the row before any Run). */
  sessionId: string | null;
  /** Thread model override alias; null = channel/global resolution. */
  model: string | null;
  /** ts of the live status message; null when idle. */
  activeStatusTs: string | null;
  updatedAt: number;
}

/** SQLite-backed thread map. All setters upsert (row created with null fields as needed). */
export interface ThreadStore {
  get(channelId: string, threadKey: string): ThreadRow | undefined;
  setSession(channelId: string, threadKey: string, sessionId: string): void;
  clearSession(channelId: string, threadKey: string): void;
  setModel(channelId: string, threadKey: string, alias: string | null): void;
  setActiveStatus(channelId: string, threadKey: string, statusTs: string | null): void;
  /** Rows with a non-null active status message (boot sweep). */
  listActiveStatuses(): Array<{ channelId: string; threadKey: string; activeStatusTs: string }>;
  close(): void;
}

/** Thin seam over Slack Web API so runs/approvals/memory are testable without Bolt. */
export interface SlackPort {
  postMessage(args: {
    channel: string;
    threadTs?: string;
    text: string;
    blocks?: unknown[];
  }): Promise<{ ts: string }>;
  updateMessage(args: { channel: string; ts: string; text: string; blocks?: unknown[] }): Promise<void>;
  /** files.uploadV2 snippet into a thread (results >4000 chars). */
  uploadTextFile(args: {
    channel: string;
    threadTs?: string;
    filename: string;
    content: string;
  }): Promise<void>;
  /** conversations.replies, oldest-first, uncached. */
  fetchThreadReplies(
    channel: string,
    threadTs: string,
    limit: number,
  ): Promise<Array<{ userId: string; text: string }>>;
  /** conversations.info name, uncached (channels.ts caches). undefined for DMs/unnamed. */
  fetchChannelName(channelId: string): Promise<string | undefined>;
}

/** Everything channels.ts derives for one Run. */
export interface ChannelContext {
  /** Absolute path of data/channels/<id>/. */
  channelDir: string;
  /** Absolute path of the channel workspace (Run cwd). Created if missing. */
  workspaceDir: string;
  config: ChannelConfig;
  /** systemPrompt append: channel/thread header, repo paths, mrkdwn rule, CHANNEL.md, MEMORY.md. */
  systemPromptAppend: string;
  /** Non-fatal validation notes (unknown config keys, truncated MEMORY.md). */
  warnings: string[];
}

export interface ResolvedModel {
  alias: string;
  model: string;
  env?: Record<string, string>;
  /** Set when a persisted thread alias no longer exists in models.json (warn once). */
  staleThreadAlias?: string;
}

/** Pending-approval registry shared by all Runs; index.ts routes block actions here. */
export interface ApprovalPort {
  /** CanUseTool bound to one thread's Slack location. */
  canUseToolFor(channel: string, threadTs: string | undefined): CanUseTool;
  /** Approve/Deny button click. value = pending approval id from the block action. */
  handleAction(value: string, decision: "approve" | "deny", userId: string): Promise<void>;
}

export interface CurationArgs {
  sessionId: string;
  /** Serialization key + MEMORY.md location. */
  channelDir: string;
}

export interface RunDeps {
  slack: SlackPort;
  store: ThreadStore;
  approvals: ApprovalPort;
  /** Throws Error on fatal config problems (message is posted in-thread; Run refused). */
  loadChannelContext(channelId: string, threadKey: string): Promise<ChannelContext>;
  loadModels(): ModelsConfig;
  /** Injected SDK entry points (mocked in tests). */
  queryFn: typeof query;
  getSessionInfoFn: typeof getSessionInfo;
  runCuration(args: CurationArgs): Promise<void>;
}

export interface RunManager {
  /** Enqueue an inbound message; enqueue/close race resolved synchronously. Never throws. */
  dispatch(msg: InboundMessage): void;
  /** Stop button: first click interrupt(), second click abort(). */
  stop(channelId: string, threadKey: string): Promise<"interrupted" | "aborted" | "idle">;
  /** Mark orphaned status messages from a previous process. */
  bootSweep(): Promise<void>;
  /** Abort live Runs + mark their status messages (SIGINT/SIGTERM). */
  shutdown(): Promise<void>;
}

export type { CanUseTool, Options, Query };
