/** canUseTool ↔ Block Kit promise bridge. Spec §Write safety. */
import type { ApprovalPort, SlackPort } from "./types.ts";

export const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

export function createApprovalRegistry(
  slack: SlackPort,
  opts: { timeoutMs?: number } = {},
): ApprovalPort {
  throw new Error("stub: not implemented");
}
