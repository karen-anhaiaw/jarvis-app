// src/ai/anthropic/session-inspector.ts
// Registers tools that expose full session introspection to the AI:
// - session_info: metadata (id, state, messageCount, model, tokens)
// - session_get_messages: raw message history (with offset/limit)
// - session_get_system: full system prompt blocks as sent to Anthropic
// - session_get_tools: all registered tool definitions

import type { CapabilityRegistry } from "../../capabilities/registry.js";
import type { SessionManager } from "../../core/session-manager.js";
import type { AnthropicSessionFactory } from "./factory.js";
import { config } from "../../config/index.js";
import { log } from "../../logger/index.js";

export function registerSessionInspectorTools(
  registry: CapabilityRegistry,
  sessions: SessionManager,
  factory: AnthropicSessionFactory,
): void {
  // ── session_info ──────────────────────────────────────────────────────────
  registry.register({
    name: "session_info",
    description:
      "Get metadata about the current AI session: session ID, state, message count, provider, model, and token breakdown estimate.",
    input_schema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Session ID to inspect (default: 'main')",
        },
      },
      required: [],
    },
    handler: async (input) => {
      const sessionId = (input.session_id as string | undefined) ?? (input.__sessionId as string | undefined) ?? "main";
      // peek() — NEVER get(): get() lazily creates a session for any unknown
      // id (phantom with the full default prompt). Inspection must be read-only.
      // See docs/features/bdd/phantom-sessions.feature (G1).
      const managed = sessions.peek(sessionId);
      if (!managed) {
        return { error: `Session not found: ${sessionId}`, available: sessions.listActive() };
      }
      const messages = managed.session.getMessages() as unknown[];
      const breakdown = factory.getTokenBreakdown();

      log.debug({ sessionId }, "session_info: called");
      return {
        sessionId,
        state: sessions.getState(sessionId),
        messageCount: messages.length,
        provider: "anthropic",
        model: config.model,
        systemTokensEstimate: breakdown.systemTokens,
        toolsTokensEstimate: breakdown.toolsTokens,
        createdAt: managed.createdAt,
      };
    },
  });

  // ── session_get_messages ──────────────────────────────────────────────────
  registry.register({
    name: "session_get_messages",
    description:
      "Get the raw Anthropic message history for a session. Supports offset and limit for pagination. Each message has role (user/assistant) and content blocks.",
    input_schema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Session ID to inspect (default: 'main')",
        },
        offset: {
          type: "number",
          description: "Start index (default: 0)",
        },
        limit: {
          type: "number",
          description: "Max messages to return (default: 20)",
        },
      },
      required: [],
    },
    handler: async (input) => {
      const sessionId = (input.session_id as string | undefined) ?? (input.__sessionId as string | undefined) ?? "main";
      const offset = (input.offset as number | undefined) ?? 0;
      const limit = (input.limit as number | undefined) ?? 20;

      // peek() — NEVER get(): inspection must not create phantom sessions.
      const managed = sessions.peek(sessionId);
      if (!managed) {
        return { error: `Session not found: ${sessionId}`, available: sessions.listActive() };
      }
      const messages = managed.session.getMessages() as unknown[];
      const slice = messages.slice(offset, offset + limit);

      log.debug({ sessionId, offset, limit, total: messages.length }, "session_get_messages: called");
      return {
        sessionId,
        total: messages.length,
        offset,
        limit,
        messages: slice,
      };
    },
  });

  // ── session_get_system ────────────────────────────────────────────────────
  registry.register({
    name: "session_get_system",
    description:
      "Get the full system prompt as currently built — all blocks (base prompt, core context, instructions, plugin context). Shows exactly what is sent to Anthropic on every request.",
    input_schema: {
      type: "object",
      properties: {
        raw: {
          type: "boolean",
          description:
            "If true, return full text of each block. If false (default), return block summaries with char counts.",
        },
      },
      required: [],
    },
    handler: async (input) => {
      const raw = (input.raw as boolean | undefined) ?? false;
      const sessionId = (input.__sessionId as string | undefined) ?? "main";
      const blocks = factory.buildSystemBlocks(sessionId);

      log.debug({ blockCount: blocks.length, raw }, "session_get_system: called");

      if (raw) {
        return {
          blockCount: blocks.length,
          blocks: blocks.map((b, i) => ({
            index: i,
            cached: !!(b as any).cache_control,
            charCount: b.text.length,
            text: b.text,
          })),
        };
      }

      return {
        blockCount: blocks.length,
        blocks: blocks.map((b, i) => ({
          index: i,
          cached: !!(b as any).cache_control,
          charCount: b.text.length,
          preview: b.text.slice(0, 200) + (b.text.length > 200 ? "…" : ""),
        })),
      };
    },
  });

  // ── session_get_tools ─────────────────────────────────────────────────────
  registry.register({
    name: "session_get_tools",
    description:
      "List all tool definitions currently registered and sent to Anthropic. Returns name, description, and input schema for each tool.",
    input_schema: {
      type: "object",
      properties: {
        filter: {
          type: "string",
          description: "Optional substring filter on tool name",
        },
        include_schema: {
          type: "boolean",
          description: "Include full input_schema in output (default: false — names + descriptions only)",
        },
      },
      required: [],
    },
    handler: async (input) => {
      const filter = (input.filter as string | undefined) ?? "";
      const includeSchema = (input.include_schema as boolean | undefined) ?? false;

      let tools = factory.getToolDefinitions();
      if (filter) {
        tools = tools.filter((t) => t.name.includes(filter));
      }

      log.debug({ total: tools.length, filter, includeSchema }, "session_get_tools: called");
      return {
        total: tools.length,
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          ...(includeSchema ? { input_schema: t.input_schema } : {}),
        })),
      };
    },
  });

  log.info("SessionInspector: 4 tools registered (session_info, session_get_messages, session_get_system, session_get_tools)");
}
