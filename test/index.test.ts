import { describe, expect, test } from "bun:test";
import { classifyEvent, createDeduper, loadRuntimeConfig } from "../src/index";

type Event = Parameters<typeof classifyEvent>[0];

function event(overrides: Partial<Event> = {}): Event {
  return {
    type: "message",
    channel: "C123",
    channel_type: "channel",
    user: "U123",
    text: "hello",
    ts: "100.001",
    ...overrides,
  };
}

describe("loadRuntimeConfig", () => {
  test("requires the two Slack credentials", () => {
    expect(() => loadRuntimeConfig({})).toThrow("SLACK_BOT_TOKEN, SLACK_APP_TOKEN required");
  });

  test("does not require an Anthropic API key", () => {
    expect(loadRuntimeConfig({
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_APP_TOKEN: "xapp-test",
    })).toEqual({
      slackBotToken: "xoxb-test",
      slackAppToken: "xapp-test",
    });
  });
});

describe("classifyEvent", () => {
  test("drops bot-authored, self-authored, and Slackbot messages", () => {
    expect(classifyEvent(event({ bot_id: "B1" }), "UBOT")).toBeNull();
    expect(classifyEvent(event({ user: "UBOT" }), "UBOT")).toBeNull();
    expect(classifyEvent(event({ user: "USLACKBOT" }), "UBOT")).toBeNull();
  });

  test("allows only ordinary, file-share, and thread-broadcast subtypes", () => {
    expect(classifyEvent(event(), "UBOT")?.text).toBe("hello");
    expect(classifyEvent(event({ subtype: "thread_broadcast" }), "UBOT")?.text).toBe("hello");
    expect(classifyEvent(event({ subtype: "message_changed" }), "UBOT")).toBeNull();
    expect(classifyEvent(event({ subtype: "channel_join" }), "UBOT")).toBeNull();
  });

  test("applies author filtering before reading subtype payload fields", () => {
    const malformedBotEvent = {
      get bot_id() {
        return "B1";
      },
      get subtype(): string {
        throw new Error("subtype should not be read");
      },
    } as Event;
    expect(classifyEvent(malformedBotEvent, "UBOT")).toBeNull();
  });

  test("drops group-DM, App Home, and user-less events", () => {
    expect(classifyEvent(event({ channel_type: "mpim" }), "UBOT")).toBeNull();
    expect(classifyEvent(event({ channel_type: "app_home" }), "UBOT")).toBeNull();
    expect(classifyEvent(event({ user: undefined }), "UBOT")).toBeNull();
  });

  test("maps top-level channels to a rolling channel session and explicit threads by thread_ts", () => {
    expect(classifyEvent(event(), "UBOT")).toMatchObject({
      channelId: "C123",
      channelType: "channel",
      threadKey: "C123",
      ts: "100.001",
      userId: "U123",
    });
    expect(
      classifyEvent(
        event({ channel: "G123", channel_type: "group", ts: "101.001", thread_ts: "99.001" }),
        "UBOT",
      ),
    ).toMatchObject({ channelId: "G123", channelType: "group", threadKey: "99.001", threadTs: "99.001" });
  });

  test("keys DMs by channel even when Slack supplies a thread", () => {
    expect(
      classifyEvent(
        event({ channel: "D123", channel_type: "im", ts: "101.001", thread_ts: "99.001" }),
        "UBOT",
      ),
    ).toMatchObject({ channelId: "D123", channelType: "im", threadKey: "D123", threadTs: "99.001" });
  });

  test("detects and strips every bot mention, including mid-text mentions", () => {
    expect(classifyEvent(event({ text: "<@UBOT> hello <@UBOT> middle <@UBOT>" }), "UBOT")).toMatchObject({
      text: "hello  middle",
      mentionsBot: true,
    });
    expect(classifyEvent(event({ text: "hello <@UBOT> world" }), "UBOT")).toMatchObject({
      text: "hello  world",
      mentionsBot: true,
    });
    expect(classifyEvent(event(), "UBOT")?.mentionsBot).toBeFalse();
  });

  test("drops empty text after mention stripping but preserves a leading model token", () => {
    expect(classifyEvent(event({ text: "  <@UBOT> <@UBOT>  " }), "UBOT")).toBeNull();
    expect(classifyEvent(event({ text: "   " }), "UBOT")).toBeNull();
    expect(classifyEvent(event({ text: " [opus] " }), "UBOT")?.text).toBe("[opus]");
  });

  test("describes skipped file contents while preserving the caption", () => {
    expect(
      classifyEvent(
        event({
          subtype: "file_share",
          text: "review these",
          files: [{ name: "diagram.png" }, { name: "notes.txt" }],
        }),
        "UBOT",
      ),
    ).toMatchObject({
      text: "review these",
      fileNote: "user attached 2 files: diagram.png, notes.txt — contents not ingested; caption below",
    });
  });

  test("describes one unnamed attachment with correct singular grammar", () => {
    expect(
      classifyEvent(event({ subtype: "file_share", text: "caption", files: [{ name: null }] }), "UBOT")?.fileNote,
    ).toBe("user attached 1 file: unnamed — contents not ingested; caption below");
  });

  test("keeps synthesized file notes on one line", () => {
    const result = classifyEvent(
      event({ subtype: "file_share", text: "caption", files: [{ name: "two\nlines.txt" }] }),
      "UBOT",
    );
    expect(result?.fileNote).toBe("user attached 1 file: two lines.txt — contents not ingested; caption below");
  });
});

describe("createDeduper", () => {
  test("reports repeated ids as seen while distinct ids pass", () => {
    const seen = createDeduper();
    expect(seen("E1")).toBeFalse();
    expect(seen("E1")).toBeTrue();
    expect(seen("E2")).toBeFalse();
  });

  test("retains no ids at zero capacity", () => {
    const seen = createDeduper(0);
    expect(seen("E1")).toBeFalse();
    expect(seen("E1")).toBeFalse();
  });

  test("evicts the oldest inserted id beyond capacity", () => {
    const seen = createDeduper(2);
    expect(seen("E1")).toBeFalse();
    expect(seen("E2")).toBeFalse();
    expect(seen("E1")).toBeTrue();
    expect(seen("E3")).toBeFalse();
    expect(seen("E1")).toBeFalse();
  });
});
