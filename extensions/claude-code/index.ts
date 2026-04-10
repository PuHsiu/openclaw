import { execFileSync } from "node:child_process";
import {
  CLI_FRESH_WATCHDOG_DEFAULTS,
  CLI_RESUME_WATCHDOG_DEFAULTS,
} from "openclaw/plugin-sdk/cli-backend";
import {
  definePluginEntry,
  type OpenClawPluginApi,
  type ProviderAuthContext,
  type ProviderAuthMethodNonInteractiveContext,
  type ProviderAuthResult,
  type ProviderCatalogResult,
  type ProviderResolveDynamicModelContext,
  type ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { readClaudeCliCredentialsCached } from "openclaw/plugin-sdk/provider-auth";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";

const PROVIDER_ID = "claude-code";
const BACKEND_ID = "claude-code";
const DEFAULT_MODEL = "claude-code/sonnet";

/**
 * Model aliases: keys are the model IDs accepted from OpenClaw's catalog
 * (the part after "claude-code/"), values are the argument the `claude` CLI
 * accepts for `--model`.
 */
const CLAUDE_CODE_MODEL_ALIASES: Record<string, string> = {
  // Short aliases the CLI accepts directly
  sonnet: "sonnet",
  opus: "opus",
  haiku: "haiku",
  // Canonical model IDs mapped to their CLI short alias
  "claude-sonnet-4-6": "sonnet",
  "sonnet-4.6": "sonnet",
  "claude-sonnet-4-5": "sonnet",
  "sonnet-4.5": "sonnet",
  "claude-sonnet-4-1": "sonnet",
  "claude-sonnet-4-0": "sonnet",
  "claude-opus-4-6": "opus",
  "opus-4.6": "opus",
  "claude-opus-4-5": "opus",
  "opus-4.5": "opus",
  "claude-haiku-4-5": "haiku",
  "haiku-4.5": "haiku",
  "claude-haiku-3-5": "haiku",
  "haiku-3.5": "haiku",
};

const CLAUDE_CODE_SESSION_ID_FIELDS = [
  "session_id",
  "sessionId",
  "conversation_id",
  "conversationId",
] as const;

const ANTHROPIC_REPLAY_HOOKS = buildProviderReplayFamilyHooks({ family: "anthropic-by-model" });

/**
 * Returns true if the `claude` CLI is available and responds on this host.
 *
 * Checks in order:
 * 1. Standard OAuth credential file / keychain (fast, cached).
 * 2. Binary probe via `claude --version` — covers Max/Pro plans that store
 *    auth differently (no .credentials.json on disk).
 */
function isClaudeCodeAvailable(): boolean {
  if (readClaudeCliCredentialsCached()) return true;
  try {
    execFileSync("claude", ["--version"], { timeout: 5_000, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

export default definePluginEntry({
  id: "claude-code",
  name: "Claude Code CLI Provider",
  description:
    "Routes inference through the host `claude -p` CLI — no API key required, uses the local Claude Code login.",
  register(api: OpenClawPluginApi) {
    // ── 1. CLI Backend ──────────────────────────────────────────────────────
    // Registers the subprocess definition.  When OpenClaw resolves a model
    // whose provider prefix matches this backend ID ("claude-code"), it routes
    // inference here instead of making an HTTP call.
    api.registerCliBackend({
      id: BACKEND_ID,
      // Forward active MCP servers to the subprocess so tools work end-to-end.
      bundleMcp: true,
      config: {
        command: "claude",
        args: [
          "-p",
          "--output-format",
          "stream-json",
          "--include-partial-messages",
          "--verbose",
          "--permission-mode",
          "bypassPermissions",
        ],
        resumeArgs: [
          "-p",
          "--output-format",
          "stream-json",
          "--include-partial-messages",
          "--verbose",
          "--permission-mode",
          "bypassPermissions",
          "--resume",
          "{sessionId}",
        ],
        output: "jsonl",
        input: "stdin",
        modelArg: "--model",
        modelAliases: CLAUDE_CODE_MODEL_ALIASES,
        sessionArg: "--session-id",
        sessionMode: "always",
        sessionIdFields: [...CLAUDE_CODE_SESSION_ID_FIELDS],
        systemPromptArg: "--append-system-prompt",
        systemPromptMode: "append",
        // Send system prompt only on the first turn so the CLI session keeps
        // it for the remainder of the conversation.
        systemPromptWhen: "first",
        // Clear the parent process's Anthropic API key so the claude subprocess
        // uses its own OAuth credentials (from ~/.claude/.credentials.json or
        // CLAUDE_CODE_OAUTH_TOKEN) rather than falling back to direct-API
        // billing via the forwarded ANTHROPIC_API_KEY.
        clearEnv: ["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY_OLD"],
        reliability: {
          watchdog: {
            fresh: { ...CLI_FRESH_WATCHDOG_DEFAULTS },
            resume: { ...CLI_RESUME_WATCHDOG_DEFAULTS },
          },
        },
        // Serialize concurrent calls so the CLI subprocess queue stays stable.
        serialize: true,
      },
    });

    // ── 2. Provider ─────────────────────────────────────────────────────────
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Claude Code CLI",
      docsPath: "/providers/models",

      auth: [
        {
          id: "cli",
          label: "Claude Code CLI",
          hint: "Use the local Claude Code CLI login — no API key required",
          kind: "custom",
          wizard: {
            choiceId: "claude-code-cli",
            choiceLabel: "Claude Code CLI",
            choiceHint: "Use a local Claude Code CLI login on this host (no API key needed)",
            groupId: "claude-code",
            groupLabel: "Claude Code",
            groupHint: "Host Claude Code CLI",
            methodId: "cli",
            modelAllowlist: {
              allowedKeys: [`${PROVIDER_ID}/sonnet`, `${PROVIDER_ID}/opus`, `${PROVIDER_ID}/haiku`],
              initialSelections: [`${PROVIDER_ID}/sonnet`],
              message: "Claude Code CLI models",
            },
          },

          run: async (_ctx: ProviderAuthContext): Promise<ProviderAuthResult> => {
            if (!isClaudeCodeAvailable()) {
              throw new Error(
                [
                  "Claude Code CLI is not authenticated on this host.",
                  "Run `claude auth login` first, then re-run this setup.",
                ].join("\n"),
              );
            }
            return {
              // No stored credential — the CLI manages its own OAuth token.
              profiles: [],
              defaultModel: DEFAULT_MODEL,
              configPatch: {
                agents: {
                  defaults: {
                    model: { primary: DEFAULT_MODEL },
                    models: { [DEFAULT_MODEL]: {} },
                  },
                },
              },
              notes: [
                "Claude Code CLI auth detected; inference will use the local `claude` subprocess.",
                "No API key is stored — the CLI manages its own credentials.",
              ],
            };
          },

          runNonInteractive: async (
            ctx: ProviderAuthMethodNonInteractiveContext,
          ): Promise<typeof ctx.config | null> => {
            if (!isClaudeCodeAvailable()) {
              ctx.runtime.error(
                [
                  'Auth choice "claude-code-cli" requires Claude Code CLI auth on this host.',
                  "Run `claude auth login` first.",
                ].join("\n"),
              );
              ctx.runtime.exit(1);
              return null;
            }
            const currentDefaults = ctx.config.agents?.defaults;
            const currentModel = currentDefaults?.model;
            const currentFallbacks =
              currentModel && typeof currentModel === "object" && "fallbacks" in currentModel
                ? (currentModel as Record<string, unknown>).fallbacks
                : undefined;
            return {
              ...ctx.config,
              agents: {
                ...ctx.config.agents,
                defaults: {
                  ...currentDefaults,
                  model: {
                    ...(Array.isArray(currentFallbacks) ? { fallbacks: currentFallbacks } : {}),
                    primary: DEFAULT_MODEL,
                  },
                  models: {
                    ...(currentDefaults?.models as Record<string, unknown> | undefined),
                    [DEFAULT_MODEL]: {},
                  },
                },
              },
            };
          },
        },
      ],

      // ── Model catalog ──────────────────────────────────────────────────────
      // Returns the static list of models exposed through the `claude` CLI.
      // Actual inference never uses the `api`/`baseUrl` here — it goes through
      // the CliBackend subprocess registered above.
      catalog: {
        order: "simple",
        run: async (_ctx): Promise<ProviderCatalogResult> => {
          if (!isClaudeCodeAvailable()) {
            return null;
          }
          return {
            provider: {
              // The `api` field tags the transport family for display / compat
              // hints only; the CliBackend takes over for real inference.
              api: "anthropic-messages" as const,
              // Placeholder — inference never uses this URL; the CliBackend
              // subprocess takes over before any HTTP call is made.
              baseUrl: "",
              models: [
                {
                  id: "sonnet",
                  name: "Claude Sonnet (latest, via claude CLI)",
                  reasoning: false,
                  input: ["text"] as Array<"text" | "image">,
                  contextWindow: 200_000,
                  maxTokens: 64_000,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
                {
                  id: "opus",
                  name: "Claude Opus (latest, via claude CLI)",
                  reasoning: false,
                  input: ["text"] as Array<"text" | "image">,
                  contextWindow: 200_000,
                  maxTokens: 32_000,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
                {
                  id: "haiku",
                  name: "Claude Haiku (latest, via claude CLI)",
                  reasoning: false,
                  input: ["text"] as Array<"text" | "image">,
                  contextWindow: 200_000,
                  maxTokens: 8_096,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          };
        },
      },

      // Dynamic model fallback: called when model resolution fails against the
      // pi ModelRegistry (which doesn't know about CLI-backed providers).
      // Returns a synthetic model so the CliBackend can forward it to `claude --model`.
      resolveDynamicModel: (
        ctx: ProviderResolveDynamicModelContext,
      ): ProviderRuntimeModel | null => {
        // Accept any id that maps to a known CLI alias, or the alias itself.
        const isKnownAlias =
          ctx.modelId in CLAUDE_CODE_MODEL_ALIASES ||
          Object.values(CLAUDE_CODE_MODEL_ALIASES).includes(ctx.modelId);
        if (!isKnownAlias) {
          return null;
        }
        const alias = CLAUDE_CODE_MODEL_ALIASES[ctx.modelId] ?? ctx.modelId;
        const isOpus = alias === "opus";
        const isHaiku = alias === "haiku";
        return {
          id: ctx.modelId,
          name: `Claude ${isOpus ? "Opus" : isHaiku ? "Haiku" : "Sonnet"} (via claude CLI)`,
          api: "anthropic-messages" as const,
          // Placeholder — inference never uses this URL; the CliBackend
          // subprocess takes over before any HTTP call is made.
          baseUrl: "",
          provider: PROVIDER_ID,
          reasoning: false,
          input: ["text"] as ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200_000,
          maxTokens: isOpus ? 32_000 : isHaiku ? 8_096 : 64_000,
        };
      },

      // Replay policy: strip thinking blocks and apply Anthropic-style
      // sanitization so resumed conversations stay well-formed.
      ...ANTHROPIC_REPLAY_HOOKS,
    });
  },
});
