import type {
  ModelAlias,
  ProviderMode,
  ProvidersConfig,
} from "./types.ts";

const PROVIDER_ENV_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"] as const;

export interface ResolvedProviderProfile {
  profileName: string;
  mode: ProviderMode;
  env: Record<string, string | undefined>;
  pathToClaudeCodeExecutable?: string;
}

export function resolveProviderProfile(
  providers: ProvidersConfig,
  model: ModelAlias,
  processEnv: NodeJS.ProcessEnv,
): ResolvedProviderProfile {
  const profileName = model.providerProfile ?? providers.default;
  const profile = providers.profiles[profileName];
  if (!profile) throw new Error(`unknown provider profile "${profileName}"`);
  if (profile.mode === "proxy" && !profile.env?.ANTHROPIC_BASE_URL) {
    throw new Error(`proxy provider profile "${profileName}" requires ANTHROPIC_BASE_URL`);
  }

  const selectedApiKey = model.env?.ANTHROPIC_API_KEY
    ?? profile.env?.ANTHROPIC_API_KEY
    ?? processEnv.ANTHROPIC_API_KEY;
  const env: Record<string, string | undefined> = { ...processEnv };
  delete env.SLACK_BOT_TOKEN;
  delete env.SLACK_APP_TOKEN;
  for (const key of PROVIDER_ENV_KEYS) delete env[key];
  Object.assign(env, profile.env, model.env);
  if (profile.mode === "api-key") {
    if (!selectedApiKey) throw new Error(`API-key provider profile "${profileName}" requires ANTHROPIC_API_KEY`);
    env.ANTHROPIC_API_KEY = selectedApiKey;
  } else {
    delete env.ANTHROPIC_API_KEY;
  }

  return {
    profileName,
    mode: profile.mode,
    env,
    ...(profile.pathToClaudeCodeExecutable
      ? { pathToClaudeCodeExecutable: profile.pathToClaudeCodeExecutable }
      : {}),
  };
}

export function validateProviderReferences(providers: ProvidersConfig, models: Record<string, ModelAlias>): void {
  for (const [alias, model] of Object.entries(models)) {
    const profileName = model.providerProfile ?? providers.default;
    if (!providers.profiles[profileName]) {
      throw new Error(`model alias "${alias}" references unknown provider profile "${profileName}"`);
    }
  }
}
