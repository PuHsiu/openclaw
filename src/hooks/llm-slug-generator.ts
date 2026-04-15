/**
 * LLM-based slug generator for session memory filenames
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  resolveDefaultAgentId,
  resolveAgentWorkspaceDir,
  resolveAgentDir,
  resolveAgentEffectiveModelPrimary,
} from "../agents/agent-scope.js";
import { runCliAgent } from "../agents/cli-runner.js";
import { DEFAULT_PROVIDER, DEFAULT_MODEL } from "../agents/defaults.js";
import { isCliProvider, parseModelRef } from "../agents/model-selection.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("llm-slug-generator");

/**
 * Generate a short 1-2 word filename slug from session content using LLM
 */
export async function generateSlugViaLLM(params: {
  sessionContent: string;
  cfg: OpenClawConfig;
}): Promise<string | null> {
  let tempSessionFile: string | null = null;

  try {
    const agentId = resolveDefaultAgentId(params.cfg);
    const workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId);
    const agentDir = resolveAgentDir(params.cfg, agentId);

    // Create a temporary session file for this one-off LLM call
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-slug-"));
    tempSessionFile = path.join(tempDir, "session.jsonl");

    const prompt = `Based on this conversation, generate a short 1-2 word filename slug (lowercase, hyphen-separated, no file extension).

Conversation summary:
${params.sessionContent.slice(0, 2000)}

Reply with ONLY the slug, nothing else. Examples: "vendor-pitch", "api-design", "bug-fix"`;

    // Resolve model from agent config instead of using hardcoded defaults
    const modelRef = resolveAgentEffectiveModelPrimary(params.cfg, agentId);
    const parsed = modelRef ? parseModelRef(modelRef, DEFAULT_PROVIDER) : null;
    const provider = parsed?.provider ?? DEFAULT_PROVIDER;
    const model = parsed?.model ?? DEFAULT_MODEL;

    const runId = `slug-gen-${Date.now()}`;
    let resultText: string | undefined;

    if (isCliProvider(provider, params.cfg)) {
      // CLI backends (e.g. claude-code) must go through runCliAgent, not the embedded
      // HTTP runner — the embedded runner would attempt an HTTP API call and fail with
      // a 401 because CLI providers use OAuth, not an ANTHROPIC_API_KEY.
      const result = await runCliAgent({
        sessionId: `slug-generator-${Date.now()}`,
        sessionKey: "temp:slug-generator",
        agentId,
        sessionFile: tempSessionFile,
        workspaceDir,
        config: params.cfg,
        prompt,
        provider,
        model,
        timeoutMs: 15_000,
        runId,
      });
      resultText = result.payloads?.[0]?.text;
    } else {
      const result = await runEmbeddedPiAgent({
        sessionId: `slug-generator-${Date.now()}`,
        sessionKey: "temp:slug-generator",
        agentId,
        sessionFile: tempSessionFile,
        workspaceDir,
        agentDir,
        config: params.cfg,
        prompt,
        provider,
        model,
        timeoutMs: 15_000,
        runId,
      });
      resultText = result.payloads?.[0]?.text;
    }

    if (resultText) {
      // Clean up the response - extract just the slug
      const slug = resultText
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 30); // Max 30 chars

      return slug || null;
    }

    return null;
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log.error(`Failed to generate slug: ${message}`);
    return null;
  } finally {
    // Clean up temporary session file
    if (tempSessionFile) {
      try {
        await fs.rm(path.dirname(tempSessionFile), { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}
