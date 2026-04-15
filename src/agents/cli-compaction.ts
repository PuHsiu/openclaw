import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import type { OpenClawConfig } from "../config/config.js";
import { sanitizeHostExecEnv } from "../infra/host-env-security.js";
import { resolveCliBackendConfig } from "./cli-backends.js";

const CLI_COMPACTION_THRESHOLD = 0.75;
const CLI_COMPACTION_SUMMARY_MAX_CHARS = 8000;
const CLI_COMPACTION_TRANSCRIPT_MAX_CHARS = 32000;

export async function estimateCliSessionFileTokens(sessionFile: string): Promise<number> {
  try {
    const stat = await fs.stat(sessionFile);
    // Rough estimate: 4 bytes per token.
    return Math.ceil(stat.size / 4);
  } catch {
    return 0;
  }
}

export async function shouldTriggerCliProactiveCompaction(params: {
  sessionFile: string;
  contextTokens: number;
}): Promise<boolean> {
  if (params.contextTokens <= 0) {
    return false;
  }
  const estimated = await estimateCliSessionFileTokens(params.sessionFile);
  return estimated >= Math.floor(params.contextTokens * CLI_COMPACTION_THRESHOLD);
}

async function buildConversationTranscript(sessionFile: string): Promise<string> {
  try {
    const raw = await fs.readFile(sessionFile, "utf-8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const parts: string[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as {
          type?: string;
          message?: { role?: string; content?: unknown };
        };
        if (entry.type !== "message" || !entry.message) {
          continue;
        }
        const { role, content } = entry.message;
        if (role !== "user" && role !== "assistant") {
          continue;
        }
        let text = "";
        if (typeof content === "string") {
          text = content;
        } else if (Array.isArray(content)) {
          text = (content as Array<{ type?: string; text?: string }>)
            .filter((b) => b?.type === "text" && typeof b.text === "string")
            .map((b) => b.text as string)
            .join("\n");
        }
        if (text.trim()) {
          parts.push(`${role.toUpperCase()}: ${text.trim()}`);
        }
      } catch {
        // Skip malformed lines.
      }
    }
    return parts.join("\n\n");
  } catch {
    return "";
  }
}

export async function generateCliCompactionSummary(params: {
  sessionFile: string;
  provider: string;
  config?: OpenClawConfig;
  signal?: AbortSignal;
}): Promise<string | null> {
  const transcript = await buildConversationTranscript(params.sessionFile);
  if (!transcript.trim()) {
    return null;
  }

  const backend = resolveCliBackendConfig(params.provider, params.config);
  if (!backend) {
    return null;
  }

  const command = backend.config.command;
  const truncated =
    transcript.length > CLI_COMPACTION_TRANSCRIPT_MAX_CHARS
      ? `[Earlier messages omitted]\n\n${transcript.slice(-CLI_COMPACTION_TRANSCRIPT_MAX_CHARS)}`
      : transcript;

  const prompt = [
    "Create a concise but complete summary of the following conversation for use as context in a continuation session.",
    "Capture: key topics discussed, decisions made, important facts or values established, any ongoing tasks or their current state.",
    "Be specific and factual. Aim for 200-500 words.",
    "",
    "CONVERSATION:",
    truncated,
  ].join("\n");

  return new Promise<string | null>((resolve) => {
    const env = sanitizeHostExecEnv({
      baseEnv: process.env,
      blockPathOverrides: true,
    });

    let child: ReturnType<typeof spawn>;
    try {
      // Spawn a fresh one-shot claude invocation with no session persistence.
      child = spawn(command, ["-p", "--output-format", "text"], {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      resolve(null);
      return;
    }

    if (params.signal) {
      const onAbort = (): void => {
        child.kill("SIGTERM");
      };
      params.signal.addEventListener("abort", onAbort, { once: true });
    }

    let stdout = "";
    // stdio is set to "pipe" so stdout/stdin are always defined.
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stdin?.write(prompt);
    child.stdin?.end();

    child.on("close", (code) => {
      if (code !== 0 || !stdout.trim()) {
        resolve(null);
        return;
      }
      resolve(stdout.trim().slice(0, CLI_COMPACTION_SUMMARY_MAX_CHARS));
    });

    child.on("error", () => resolve(null));
  });
}
