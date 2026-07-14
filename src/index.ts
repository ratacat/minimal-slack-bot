import { App } from "@slack/bolt";
import type { BlockAction, ButtonAction, SlackEventMiddlewareArgs } from "@slack/bolt";
import { getSessionInfo, query } from "@anthropic-ai/claude-agent-sdk";
import { createApprovalRegistry } from "./approvals";
import { createChannelContextLoader, DATA_DIR, loadModels, loadProviders, parseLeadingToken } from "./channels";
import { createCronManager, openCronStore } from "./cron";
import { log } from "./log";
import { createCurator } from "./memory";
import { validateProviderReferences } from "./providers";
import { createRunManager } from "./runs";
import { openThreadStore } from "./store";
import type { ChannelType, InboundMessage, SlackPort } from "./types";

type MessageEvent = {
  type: "message";
  channel: string;
  channel_type: ChannelType | "mpim" | "app_home";
  user?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  files?: Array<{ name?: string | null }>;
};

export function createDeduper(cap = 1000): (id: string) => boolean {
  const ids = new Map<string, true>();
  return (id) => {
    if (ids.has(id)) return true;
    ids.set(id, true);
    if (ids.size > cap) ids.delete(ids.keys().next().value!);
    return false;
  };
}

export function classifyEvent(evt: MessageEvent, botUserId: string): InboundMessage | null {
  if (evt.bot_id || evt.user === botUserId || evt.user === "USLACKBOT") return null;
  if (evt.subtype !== undefined && evt.subtype !== "file_share" && evt.subtype !== "thread_broadcast") return null;
  if (evt.channel_type === "mpim" || evt.channel_type === "app_home" || !evt.user) return null;

  const mention = `<@${botUserId}>`;
  const mentionsBot = (evt.text ?? "").includes(mention);
  const text = (evt.text ?? "").split(mention).join("").trim();
  if (!text) return null;

  const message: InboundMessage = {
    channelId: evt.channel,
    channelType: evt.channel_type,
    threadKey: evt.channel_type === "im" || !evt.thread_ts ? evt.channel : evt.thread_ts,
    ts: evt.ts,
    userId: evt.user,
    text,
    mentionsBot,
  };
  if (evt.thread_ts) message.threadTs = evt.thread_ts;
  if (evt.subtype === "file_share") {
    const files = evt.files ?? [];
    const names = files.map((file) => (file.name ?? "unnamed").replace(/\s+/g, " ")).join(", ");
    message.fileNote = `user attached ${files.length} file${files.length === 1 ? "" : "s"}${names ? `: ${names}` : ""} — contents not ingested; caption below`;
  }
  return message;
}

export interface RuntimeConfig {
  slackBotToken: string;
  slackAppToken: string;
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  const slackBotToken = env.SLACK_BOT_TOKEN;
  const slackAppToken = env.SLACK_APP_TOKEN;
  const missing = [
    !slackBotToken && "SLACK_BOT_TOKEN",
    !slackAppToken && "SLACK_APP_TOKEN",
  ].filter((name): name is string => Boolean(name));
  if (missing.length) throw new Error(`${missing.join(", ")} required`);
  return { slackBotToken: slackBotToken!, slackAppToken: slackAppToken! };
}

async function main(): Promise<void> {
  const { slackBotToken, slackAppToken } = loadRuntimeConfig(process.env);
  const models = loadModels();
  const providers = loadProviders();
  validateProviderReferences(providers, models.aliases);
  const app = new App({ token: slackBotToken, appToken: slackAppToken, socketMode: true });
  const auth = await app.client.auth.test();
  if (!auth.user_id) throw new Error("auth.test did not return bot user id");
  const botUserId = auth.user_id;
  const slack: SlackPort = {
    async postMessage({ channel, threadTs, text, blocks }) {
      const result = await app.client.chat.postMessage({ channel, thread_ts: threadTs, text, blocks: blocks as never });
      if (!result.ts) throw new Error("chat.postMessage did not return ts");
      return { ts: result.ts };
    },
    async updateMessage({ channel, ts, text, blocks }) {
      await app.client.chat.update({ channel, ts, text, blocks: blocks as never });
    },
    async deleteMessage({ channel, ts }) {
      await app.client.chat.delete({ channel, ts });
    },
    async uploadTextFile({ channel, threadTs, filename, content }) {
      if (threadTs) await app.client.files.uploadV2({ channel_id: channel, thread_ts: threadTs, filename, content });
      else await app.client.files.uploadV2({ channel_id: channel, filename, content });
    },
    async fetchThreadReplies(channel, threadTs, limit) {
      const result = await app.client.conversations.replies({ channel, ts: threadTs, limit });
      return (result.messages ?? []).map((message) => ({ ts: message.ts ?? "", userId: message.user ?? "", text: message.text ?? "" }));
    },
    async fetchChannelName(channelId) {
      const result = await app.client.conversations.info({ channel: channelId });
      return result.channel?.name;
    },
  };

  const store = openThreadStore(`${DATA_DIR}bot.sqlite`);
  const approvals = createApprovalRegistry(slack);
  const runManager = createRunManager({
    slack,
    store,
    approvals,
    loadChannelContext: createChannelContextLoader(slack),
    loadModels,
    queryFn: query,
    getSessionInfoFn: getSessionInfo,
    runCuration: createCurator(query, loadProviders),
    loadProviders,
  });
  const cronStore = openCronStore(`${DATA_DIR}bot.sqlite`);
  const cron = createCronManager({
    slack,
    store: cronStore,
    loadChannelContext: createChannelContextLoader(slack),
    loadModels,
    loadProviders,
    queryFn: query,
  });
  const seen = createDeduper();

  app.message(async ({ message, body }: SlackEventMiddlewareArgs<"message">) => {
    if (seen(body.event_id)) return;
    const inbound = classifyEvent(message as MessageEvent, botUserId);
    if (!inbound) return;
    log("inbound", { eventId: body.event_id, channelId: inbound.channelId, threadKey: inbound.threadKey, userId: inbound.userId });
    const { token, rest } = parseLeadingToken(inbound.text);
    if (token === "cron") {
      void cron.handleCommand(inbound, rest);
      return;
    }
    runManager.dispatch(inbound);
  });
  for (const decision of ["approve", "deny"] as const) {
    app.action<BlockAction<ButtonAction>>(decision, async ({ ack, action, body }) => {
      await ack();
      if (action.value) await approvals.handleAction(action.value, decision, body.user.id, body.message?.ts);
    });
  }
  app.action<BlockAction<ButtonAction>>("stop", async ({ ack, action }) => {
    await ack();
    if (!action.value) return;
    const { channelId, threadKey } = JSON.parse(action.value) as { channelId: string; threadKey: string };
    await runManager.stop(channelId, threadKey);
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await app.stop().catch((error) => log("shutdown_error", { stage: "slack", error: String(error) }));
    cron.stop();
    await runManager.shutdown();
    store.close();
    cronStore.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await runManager.bootSweep();
  cron.start();
  await app.start();
  log("boot", { botUserId });
}

if (import.meta.main) await main();
