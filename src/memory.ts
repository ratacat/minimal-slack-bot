/** Curation run + memory_append/memory_replace tools. Spec §Memory. */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import { log } from "./log.ts";
import { resolveProviderProfile } from "./providers.ts";
import type { CurationArgs, ModelAlias, ProvidersConfig } from "./types.ts";
import type { query } from "@anthropic-ai/claude-agent-sdk";

const chains = new Map<string, Promise<void>>();

export type Curator = (args: CurationArgs, model: ModelAlias) => Promise<void>;

/** Curation runs serialize per channelDir; failures log and never throw. */
export function createCurator(queryFn: typeof query, loadProviders: () => ProvidersConfig): Curator {
  return ({ sessionId, channelDir }, model) => {
    const previous = chains.get(channelDir) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      try {
        const path = join(channelDir, "MEMORY.md");
        let memory = "";
        try {
          memory = await readFile(path, "utf8");
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
        }
        const memoryServer = createSdkMcpServer({
          name: "memory",
          tools: [
            tool("memory_append", "Append a durable memory entry.", { text: z.string() }, async ({ text }) => {
              try {
                await mkdir(channelDir, { recursive: true });
                let content = "";
                try {
                  content = await readFile(path, "utf8");
                } catch (error) {
                  if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
                }
                await appendFile(path, `${content.endsWith("\n") || content.length === 0 ? "" : "\n"}- [${new Date().toISOString()}] ${text}\n`);
                return { content: [{ type: "text", text: "Memory entry appended." }] };
              } catch (error) {
                log("curation_error", { channelDir, error: String(error instanceof Error ? error.message : error) });
                return { content: [{ type: "text", text: "Unable to append memory." }], isError: true };
              }
            }),
            tool("memory_replace", "Replace exact text in channel memory.", { old: z.string(), new: z.string() }, async ({ old, new: replacement }) => {
              try {
                let content = "";
                try {
                  content = await readFile(path, "utf8");
                } catch (error) {
                  if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
                }
                if (!content.includes(old)) {
                  return { content: [{ type: "text", text: "The requested memory text was not found." }], isError: true };
                }
                await writeFile(path, content.replace(old, replacement));
                return { content: [{ type: "text", text: "Memory updated." }] };
              } catch (error) {
                log("curation_error", { channelDir, error: String(error instanceof Error ? error.message : error) });
                return { content: [{ type: "text", text: "Unable to replace memory." }], isError: true };
              }
            }),
          ],
        });
        const provider = resolveProviderProfile(loadProviders(), model, process.env);
        for await (const _message of queryFn({
          prompt: `Persist only what survives this conversation: durable facts, decisions, operator preferences, and repo gotchas; not task minutiae. MEMORY.md is currently ${Buffer.byteLength(memory)} bytes. Consolidate with memory_replace when it exceeds 8KB.`,
          options: {
            // Sessions are stored per-cwd project dir: resume must run from the
            // same workspace as the main Run or the fork finds no transcript.
            cwd: join(channelDir, "workspace"),
            resume: sessionId,
            forkSession: true,
            persistSession: false,
            model: model.model,
            maxTurns: 4,
            systemPrompt: "Persist only durable facts, decisions, operator preferences, and repo gotchas; never task minutiae. Use memory_append for new durable entries. When MEMORY.md exceeds 8192 bytes, consolidate it with memory_replace.",
            settingSources: [],
            skills: [],
            tools: [],
            mcpServers: { memory: memoryServer },
            allowedTools: ["mcp__memory__memory_append", "mcp__memory__memory_replace"],
            permissionMode: "dontAsk",
            strictMcpConfig: true,
            env: provider.env,
            ...(provider.pathToClaudeCodeExecutable
              ? { pathToClaudeCodeExecutable: provider.pathToClaudeCodeExecutable }
              : {}),
          },
        })) {
          // Completion of the curation stream is the synchronization point.
        }
        log("curation_complete", { channelDir, sessionId });
      } catch (error) {
        log("curation_error", { channelDir, sessionId, error: String(error instanceof Error ? error.message : error) });
      }
    });
    chains.set(channelDir, current);
    void current.finally(() => {
      if (chains.get(channelDir) === current) chains.delete(channelDir);
    });
    return current;
  };
}
