import { afterEach, describe, expect, test, vi } from "bun:test";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { createApprovalRegistry } from "../src/approvals.ts";
import type { ApprovalPort, SlackPort } from "../src/types.ts";

type Post = Parameters<SlackPort["postMessage"]>[0];
type Update = Parameters<SlackPort["updateMessage"]>[0];
type ToolOptions = Parameters<CanUseTool>[2];

type Button = { action_id: string; value: string };
type Block = {
  type: string;
  text?: { text: string };
  elements?: Button[];
};
afterEach(() => vi.useRealTimers());

function makeSlack() {
  const posts: Post[] = [];
  const updates: Update[] = [];
  const slack: SlackPort = {
    async postMessage(args) {
      posts.push(args);
      return { ts: `message-${posts.length}` };
    },
    async updateMessage(args) {
      updates.push(args);
    },
    async deleteMessage() {},
    async uploadTextFile() {},
    async fetchThreadReplies() {
      return [];
    },
    async fetchChannelName() {
      return undefined;
    },
  };
  return { slack, posts, updates };
}

function options(signal = new AbortController().signal, extra: Partial<ToolOptions> = {}): ToolOptions {
  return { signal, toolUseID: "tool-use-1", requestId: "request-1", ...extra };
}

function promptParts(post: Post) {
  const blocks = post.blocks as Block[];
  const section = blocks.find((block) => block.type === "section");
  const actions = blocks.find((block) => block.type === "actions");
  if (!section?.text || !actions?.elements) throw new Error("approval prompt blocks missing");
  return { text: section.text.text, buttons: actions.elements };
}

function pendingId(post: Post): string {
  const { buttons } = promptParts(post);
  const approve = buttons.find((button) => button.action_id === "approve");
  const deny = buttons.find((button) => button.action_id === "deny");
  expect(approve?.value).toBe(deny?.value);
  if (!approve) throw new Error("approve button missing");
  return approve.value;
}

async function expectAlreadyResolved(
  approvals: ApprovalPort,
  id: string,
  posts: Post[],
  updates: Update[],
): Promise<void> {
  const postCount = posts.length;
  const updateCount = updates.length;
  await approvals.handleAction(id, "deny", "U-late", "message-1");
  expect(posts).toHaveLength(postCount);
  expect(updates).toHaveLength(updateCount + 1);
  expect(updates.at(-1)).toMatchObject({ ts: "message-1", text: "This approval was already resolved or expired." });
}

describe("createApprovalRegistry", () => {
  test("renders SDK prompt fields and resolves approval with the actor", async () => {
    const { slack, posts, updates } = makeSlack();
    const approvals = createApprovalRegistry(slack);
    const resultPromise = approvals.canUseToolFor("C1", "T1")(
      "Edit",
      { raw: "must not be reconstructed" },
      options(undefined, {
        title: "Claude wants to edit config.json",
        displayName: "Edit file",
        description: "This changes the production configuration.",
        decisionReason: "The file is outside the current allow rule.",
        blockedPath: "/srv/config.json",
      }),
    );

    expect(posts).toHaveLength(1);
    expect(posts[0]?.channel).toBe("C1");
    expect(posts[0]?.threadTs).toBe("T1");
    const prompt = promptParts(posts[0]!);
    expect(prompt.text).toContain("Claude wants to edit config.json");
    expect(prompt.text).toContain("This changes the production configuration.");
    expect(prompt.text).toContain("The file is outside the current allow rule.");
    expect(prompt.text).toContain("/srv/config.json");
    expect(prompt.text).not.toContain("must not be reconstructed");
    expect(prompt.buttons.map((button) => button.action_id)).toEqual(["approve", "deny"]);

    const id = pendingId(posts[0]!);
    await approvals.handleAction(id, "approve", "U123");

    expect(await resultPromise).toEqual({ behavior: "allow", updatedInput: { raw: "must not be reconstructed" } });
    expect(updates.at(-1)?.text).toContain("Approved by <@U123>");
    await expectAlreadyResolved(approvals, id, posts, updates);
  });

  test("concurrent pending approvals resolve independently by id", async () => {
    const { slack, posts } = makeSlack();
    const approvals = createApprovalRegistry(slack);
    const canUseTool = approvals.canUseToolFor("C1", "T1");
    const firstPromise = canUseTool("Bash", { command: "pm2 restart" }, options());
    const secondPromise = canUseTool("Edit", { file_path: "/repo/a.ts" }, options());
    const firstId = pendingId(posts[0]!);
    const secondId = pendingId(posts[1]!);
    expect(firstId).not.toBe(secondId);

    await approvals.handleAction(secondId, "deny", "U2");
    await approvals.handleAction(firstId, "approve", "U1");

    expect(await firstPromise).toEqual({ behavior: "allow", updatedInput: { command: "pm2 restart" } });
    const second = await secondPromise;
    expect(second?.behavior).toBe("deny");
  });

  test("denies with the actor in the SDK result and Slack update", async () => {
    const { slack, posts, updates } = makeSlack();
    const approvals = createApprovalRegistry(slack);
    const resultPromise = approvals.canUseToolFor("C1", "T1")("Bash", { command: "touch x" }, options());
    const id = pendingId(posts[0]!);

    await approvals.handleAction(id, "deny", "U456");

    const result = await resultPromise;
    expect(result?.behavior).toBe("deny");
    if (result?.behavior !== "deny") throw new Error("expected denial");
    expect(result.message).toContain("<@U456>");
    expect(updates.at(-1)?.text).toContain("Denied by <@U456>");
    await expectAlreadyResolved(approvals, id, posts, updates);
  });

  test("auto-denies timed-out approvals and removes them", async () => {
    const { slack, posts, updates } = makeSlack();
    const approvals = createApprovalRegistry(slack, { timeoutMs: 30 });
    const resultPromise = approvals.canUseToolFor("C1", "T1")("Write", { path: "x" }, options());
    const id = pendingId(posts[0]!);

    const result = await resultPromise;

    expect(result?.behavior).toBe("deny");
    if (result?.behavior !== "deny") throw new Error("expected denial");
    expect(result.message.toLowerCase()).toContain("timed out");
    expect(updates.at(-1)?.text.toLowerCase()).toContain("timed out");
    await expectAlreadyResolved(approvals, id, posts, updates);
  });

  test("timeout resolves permission even when the Slack update is still pending", async () => {
    vi.useFakeTimers();
    const { slack, posts } = makeSlack();
    slack.updateMessage = () => new Promise<void>(() => {});
    const approvals = createApprovalRegistry(slack, { timeoutMs: 30 });
    const resultPromise = approvals.canUseToolFor("C1", "T1")("Write", { path: "x" }, options());
    expect(posts).toHaveLength(1);

    vi.advanceTimersByTime(30);

    await expect(resultPromise).resolves.toMatchObject({ behavior: "deny" });
  });

  test("first click wins and its timer cannot overwrite the outcome", async () => {
    vi.useFakeTimers();
    const { slack, posts, updates } = makeSlack();
    const approvals = createApprovalRegistry(slack, { timeoutMs: 30 });
    const resultPromise = approvals.canUseToolFor("C1", "T1")("Edit", {}, options());
    const id = pendingId(posts[0]!);

    await approvals.handleAction(id, "approve", "U-first");
    await approvals.handleAction(id, "deny", "U-second", "message-1");
    expect(await resultPromise).toEqual({ behavior: "allow", updatedInput: {} });
    vi.advanceTimersByTime(50);

    expect(updates).toHaveLength(2);
    expect(updates[0]?.text).toContain("U-first");
    expect(updates[1]).toMatchObject({ ts: "message-1", text: "This approval was already resolved or expired." });
  });

  test("an aborted run resolves deny and updates the prompt", async () => {
    const { slack, posts, updates } = makeSlack();
    const approvals = createApprovalRegistry(slack, { timeoutMs: 100 });
    const controller = new AbortController();
    const resultPromise = approvals.canUseToolFor("C1", "T1")("Edit", {}, options(controller.signal));
    const id = pendingId(posts[0]!);

    controller.abort();
    const result = await resultPromise;
    for (let i = 0; i < 10 && updates.length === 0; i++) await Promise.resolve();
    expect(updates.at(-1)?.text.toLowerCase()).toContain("run stopped");

    expect(result?.behavior).toBe("deny");
    if (result?.behavior !== "deny") throw new Error("expected denial");
    expect(result.message.toLowerCase()).toContain("run stopped");
    await expectAlreadyResolved(approvals, id, posts, updates);
  });

  test("falls back to a safe preview when tool input cannot be serialized", async () => {
    const { slack, posts } = makeSlack();
    const approvals = createApprovalRegistry(slack);
    const input: Record<string, unknown> = {};
    input.self = input; // circular: JSON.stringify throws
    const resultPromise = approvals.canUseToolFor("C1", "T1")("CustomTool", input, options());

    const { text } = promptParts(posts[0]!);
    expect(text).toContain("*CustomTool* requires approval.");
    expect(text).toContain("[input could not be serialized]");

    await approvals.handleAction(pendingId(posts[0]!), "deny", "U1");
    const result = await resultPromise;
    expect(result?.behavior).toBe("deny");
  });

  test("keeps fallback input previews within Block Kit limits", async () => {
    const { slack, posts } = makeSlack();
    const approvals = createApprovalRegistry(slack);
    const resultPromise = approvals.canUseToolFor("C1", undefined)(
      "CustomTool",
      { payload: "x".repeat(5000) },
      options(),
    );
    const { text } = promptParts(posts[0]!);
    const preview = text.match(/```([\s\S]*)```/)?.[1];

    expect(text.length).toBeLessThanOrEqual(3000);
    expect(preview).toBeDefined();
    expect(preview!.length).toBeLessThanOrEqual(2900);

    await approvals.handleAction(pendingId(posts[0]!), "approve", "U1");
    await resultPromise;
  });

  test("still resolves permission when Slack rejects the resolution update", async () => {
    const { slack, posts } = makeSlack();
    slack.updateMessage = async () => {
      throw new Error("Slack unavailable");
    };
    const approvals = createApprovalRegistry(slack);
    const resultPromise = approvals.canUseToolFor("C1", "T1")("Edit", {}, options());
    const id = pendingId(posts[0]!);

    await approvals.handleAction(id, "approve", "U1");

    expect(await resultPromise).toEqual({ behavior: "allow", updatedInput: {} });
  });

  test("fails closed when Slack throws before returning a post promise", async () => {
    const { slack } = makeSlack();
    slack.postMessage = (() => {
      throw new Error("Slack unavailable");
    }) as SlackPort["postMessage"];
    const approvals = createApprovalRegistry(slack);

    const result = await approvals.canUseToolFor("C1", "T1")("Edit", {}, options());

    expect(result?.behavior).toBe("deny");
    if (result?.behavior !== "deny") throw new Error("expected denial");
    expect(result.message).toContain("Slack");
  });

  test("does not throw when the expired-action update fails", async () => {
    const { slack, posts } = makeSlack();
    const approvals = createApprovalRegistry(slack);
    const resultPromise = approvals.canUseToolFor("C1", "T1")("Edit", {}, options());
    const id = pendingId(posts[0]!);
    await approvals.handleAction(id, "approve", "U1");
    await resultPromise;
    slack.updateMessage = async () => {
      throw new Error("Slack unavailable");
    };

    await expect(approvals.handleAction(id, "deny", "U2", "message-1")).resolves.toBeUndefined();
  });

  test("fails closed if Slack cannot post the approval prompt", async () => {
    const { slack } = makeSlack();
    slack.postMessage = async () => {
      throw new Error("Slack unavailable");
    };
    const approvals = createApprovalRegistry(slack, { timeoutMs: 100 });

    const result = await approvals.canUseToolFor("C1", "T1")("Edit", {}, options());

    expect(result?.behavior).toBe("deny");
    if (result?.behavior !== "deny") throw new Error("expected denial");
    expect(result.message).toContain("Slack");
  });
});
