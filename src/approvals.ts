/** canUseTool ↔ Block Kit promise bridge. Spec §Write safety. */
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { log } from "./log.ts";
import type { ApprovalPort, SlackPort } from "./types.ts";

export const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

type Resolution = "approved" | "denied" | "timed out" | "run stopped" | "slack error";
type ToolOptions = Parameters<CanUseTool>[2];

interface PendingApproval {
  channel: string;
  threadTs?: string;
  messageTs: string;
  timer: Timer;
  signal: AbortSignal;
  onAbort: () => void;
  posted: Promise<void>;
  input: Record<string, unknown>;
  resolve: (result: PermissionResult) => void;
}

function promptText(toolName: string, input: Record<string, unknown>, options: ToolOptions): string {
  const details = [options.title, options.displayName, options.description, options.decisionReason]
    .filter((part): part is string => Boolean(part));
  if (options.blockedPath) details.push(`Blocked path: ${options.blockedPath}`);
  if (details.length) return details.join("\n\n").slice(0, 3000);

  let serialized: string;
  try {
    serialized = JSON.stringify(input, null, 2);
  } catch {
    serialized = "[input could not be serialized]";
  }
  const prefix = `*${toolName}* requires approval.\n\n`;
  const preview = serialized.slice(0, Math.min(2900, 3000 - prefix.length - 6));
  return `${prefix}\`\`\`${preview}\`\`\``;
}

function resolvedText(reason: Resolution, userId?: string): string {
  if (reason === "approved") return `Approved by <@${userId}>.`;
  if (reason === "denied") return `Denied by <@${userId}>.`;
  if (reason === "timed out") return "Denied: approval timed out.";
  if (reason === "run stopped") return "Denied: run stopped.";
  return "Denied: Slack could not post the approval prompt.";
}

function actionId(channel: string, threadTs: string | undefined): string {
  return `${crypto.randomUUID()}.${Buffer.from(JSON.stringify([channel, threadTs])).toString("base64url")}`;
}

function actionLocation(id: string): { channel: string; threadTs?: string } | undefined {
  try {
    const encoded = id.slice(id.indexOf(".") + 1);
    const parsed: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString());
    if (!Array.isArray(parsed) || typeof parsed[0] !== "string") return undefined;
    if (parsed[1] !== undefined && typeof parsed[1] !== "string") return undefined;
    return { channel: parsed[0], threadTs: parsed[1] };
  } catch {
    return undefined;
  }
}

export function createApprovalRegistry(
  slack: SlackPort,
  opts: { timeoutMs?: number } = {},
): ApprovalPort {
  const timeoutMs = opts.timeoutMs ?? APPROVAL_TIMEOUT_MS;
  const pending = new Map<string, PendingApproval>();

  const settle = (
    id: string,
    result: PermissionResult,
    reason: Resolution,
    userId?: string,
  ): Promise<void> | undefined => {
    const approval = pending.get(id);
    if (!approval) return undefined;
    pending.delete(id);
    clearTimeout(approval.timer);
    approval.signal.removeEventListener("abort", approval.onAbort);
    const updated = reason === "slack error"
      ? Promise.resolve()
      : approval.posted.then(() => slack.updateMessage({
          channel: approval.channel,
          ts: approval.messageTs,
          text: resolvedText(reason, userId),
        })).catch(() => {});
    // Permission resolution must never wait on Slack I/O: chat.update can retry
    // or hang while the SDK tool call remains parked (fail-closed invariant).
    approval.resolve(result);
    log("approval_decision", { channel: approval.channel, decision: reason, userId });
    return updated;
  };

  return {
    canUseToolFor(channel, threadTs) {
      return (toolName, input, options) => {
        const id = actionId(channel, threadTs);
        const text = promptText(toolName, input, options);
        let resolveResult!: (result: PermissionResult) => void;
        const resultPromise = new Promise<PermissionResult>((resolve) => {
          resolveResult = resolve;
        });
        const onAbort = () => {
          settle(id, { behavior: "deny", message: "Approval denied because the run stopped." }, "run stopped");
        };
        const timer = setTimeout(() => {
          settle(id, { behavior: "deny", message: "Approval timed out." }, "timed out");
        }, timeoutMs);
        const approval: PendingApproval = {
          channel,
          threadTs,
          messageTs: "",
          timer,
          input,
          signal: options.signal,
          onAbort,
          posted: Promise.resolve(),
          resolve: resolveResult,
        };
        pending.set(id, approval);
        try {
          approval.posted = Promise.resolve(slack.postMessage({
            channel,
            threadTs,
            text,
            blocks: [
              { type: "section", text: { type: "mrkdwn", text } },
              {
                type: "actions",
                elements: [
                  { type: "button", text: { type: "plain_text", text: "Approve" }, style: "primary", action_id: "approve", value: id },
                  { type: "button", text: { type: "plain_text", text: "Deny" }, style: "danger", action_id: "deny", value: id },
                ],
              },
            ],
          })).then(({ ts }) => {
            approval.messageTs = ts;
          }).catch(() => {
            settle(id, { behavior: "deny", message: "Approval denied because Slack could not post the prompt." }, "slack error");
          });
        } catch {
          settle(id, { behavior: "deny", message: "Approval denied because Slack could not post the prompt." }, "slack error");
        }
        if (options.signal.aborted) onAbort();
        else options.signal.addEventListener("abort", onAbort, { once: true });
        return resultPromise;
      };
    },

    async handleAction(value, decision, userId, messageTs) {
      const approval = pending.get(value);
      const result: PermissionResult = decision === "approve"
        ? { behavior: "allow", updatedInput: approval?.input ?? {} }
        : { behavior: "deny", message: `Approval denied by <@${userId}>.` };
      const updated = settle(value, result, decision === "approve" ? "approved" : "denied", userId);
      if (updated) {
        await updated;
        return;
      }

      const location = actionLocation(value);
      if (!location || !messageTs) return;
      try {
        await slack.updateMessage({
          channel: location.channel,
          ts: messageTs,
          text: "This approval was already resolved or expired.",
        });
      } catch {}
    },
  };
}
