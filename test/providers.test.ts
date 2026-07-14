import { describe, expect, test } from "bun:test";
import { resolveProviderProfile, validateProviderReferences } from "../src/providers.ts";
import type { ModelAlias, ProvidersConfig } from "../src/types.ts";

const providers: ProvidersConfig = {
  default: "subscription",
  profiles: {
    subscription: { mode: "claude-subscription" },
    api: { mode: "api-key" },
    proxy: {
      mode: "proxy",
      env: {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:8317",
        ANTHROPIC_AUTH_TOKEN: "dummy-not-used",
      },
    },
  },
};

function model(overrides: Partial<ModelAlias> = {}): ModelAlias {
  return { model: "sonnet", ...overrides };
}

describe("resolveProviderProfile", () => {
  test("defaults to Claude subscription and removes unrelated credentials and routes", () => {
    const resolved = resolveProviderProfile(providers, model(), {
      PATH: "/bin",
      ANTHROPIC_API_KEY: "paid-key",
      ANTHROPIC_BASE_URL: "http://ambient-proxy",
      ANTHROPIC_AUTH_TOKEN: "ambient-token",
      SLACK_BOT_TOKEN: "bot-secret",
      SLACK_APP_TOKEN: "app-secret",
    });

    expect(resolved.profileName).toBe("subscription");
    expect(resolved.mode).toBe("claude-subscription");
    expect(resolved.env.PATH).toBe("/bin");
    expect(resolved.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(resolved.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(resolved.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(resolved.env.SLACK_BOT_TOKEN).toBeUndefined();
    expect(resolved.env.SLACK_APP_TOKEN).toBeUndefined();
  });

  test("requires and preserves API keys without ambient proxy routing", () => {
    expect(() => resolveProviderProfile(providers, model({ providerProfile: "api" }), {}))
      .toThrow("requires ANTHROPIC_API_KEY");
    const resolved = resolveProviderProfile(providers, model({ providerProfile: "api" }), {
      ANTHROPIC_API_KEY: "paid-key",
      ANTHROPIC_BASE_URL: "http://ambient-proxy",
      ANTHROPIC_AUTH_TOKEN: "ambient-token",
    });

    expect(resolved.mode).toBe("api-key");
    expect(resolved.env.ANTHROPIC_API_KEY).toBe("paid-key");
    expect(resolved.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(resolved.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  test("model-level API key outranks profile and process keys", () => {
    const resolved = resolveProviderProfile(
      providers,
      model({ providerProfile: "api", env: { ANTHROPIC_API_KEY: "model-key" } }),
      { ANTHROPIC_API_KEY: "process-key" },
    );

    expect(resolved.env.ANTHROPIC_API_KEY).toBe("model-key");
  });

  test("applies proxy environment and lets model overrides win", () => {
    const resolved = resolveProviderProfile(
      providers,
      model({ providerProfile: "proxy", env: { ANTHROPIC_BASE_URL: "http://custom:9000" } }),
      { ANTHROPIC_API_KEY: "paid-key", HOME: "/Users/test" },
    );

    expect(resolved.mode).toBe("proxy");
    expect(resolved.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(resolved.env.ANTHROPIC_AUTH_TOKEN).toBe("dummy-not-used");
    expect(resolved.env.ANTHROPIC_BASE_URL).toBe("http://custom:9000");
    expect(resolved.env.HOME).toBe("/Users/test");
  });

  test("refuses unknown or incomplete proxy profiles", () => {
    expect(() => resolveProviderProfile(providers, model({ providerProfile: "missing" }), {}))
      .toThrow('unknown provider profile "missing"');
    expect(() => resolveProviderProfile(
      { default: "bad", profiles: { bad: { mode: "proxy" } } },
      model(),
      {},
    )).toThrow("requires ANTHROPIC_BASE_URL");
  });
});

describe("validateProviderReferences", () => {
  test("accepts default and explicit provider profiles", () => {
    expect(() => validateProviderReferences(providers, {
      sonnet: model(),
      terra: model({ providerProfile: "proxy" }),
    })).not.toThrow();
  });

  test("rejects a model that names a missing profile", () => {
    expect(() => validateProviderReferences(providers, {
      terra: model({ providerProfile: "missing" }),
    })).toThrow('model alias "terra" references unknown provider profile "missing"');
  });
});
