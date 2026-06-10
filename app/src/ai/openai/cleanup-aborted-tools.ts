// src/ai/openai/cleanup-aborted-tools.ts
// Port of the tested Anthropic cleanup semantics (anthropic/cleanup-aborted-tools.ts)
// to the OpenAI chat message format.
//
// WHY (decision record, mission jarvis-fix F2.4):
//   The previous in-session loop POPPED trailing `role:"tool"` messages
//   unconditionally — destroying valid completed sequences and orphaning
//   their assistant tool_calls (OpenAI rejects histories where an assistant
//   tool_call has no matching tool message → API 400).
//
//   The Anthropic module proved the right approach is ADDITIVE, never
//   destructive: scan for gaps and append synthetic pieces until the
//   invariant holds — EVERY tool_call id has a matching tool message.
//
// Format mapping (Anthropic → OpenAI):
//   tool_use block            → assistant message with tool_calls[]
//   tool_result block         → role:"tool" message with tool_call_id
import type OpenAI from "openai";
import type { CapabilityCall } from "../types.js";
import { log } from "../../logger/index.js";

type Message = OpenAI.Chat.ChatCompletionMessageParam;

const ABORT_NOTICE = "[Tool execution was aborted by user]";

export function cleanupAbortedToolMessages(
  messages: Message[],
  pendingCalls: CapabilityCall[],
): Message[] {
  if (pendingCalls.length === 0) return messages;

  const result = [...messages];
  const pendingIds = new Set(pendingCalls.map(c => c.id));

  log.info(
    { pendingCount: pendingCalls.length, pendingIds: [...pendingIds] },
    "OpenAI cleanupAbortedTools: processing abort cleanup",
  );

  // --- Step 1: discover which ids already exist in history ---
  const existingToolCallIds = new Set<string>();
  const existingToolResultIds = new Set<string>();
  for (const msg of result) {
    if (msg.role === "assistant" && Array.isArray((msg as any).tool_calls)) {
      for (const tc of (msg as any).tool_calls) existingToolCallIds.add(tc.id);
    }
    if (msg.role === "tool") {
      existingToolResultIds.add((msg as any).tool_call_id);
    }
  }

  // --- Step 2: gap analysis for the pending calls ---
  const needsToolCall = pendingCalls.filter(tc => !existingToolCallIds.has(tc.id));
  const needsToolResult = pendingCalls.filter(tc => !existingToolResultIds.has(tc.id));

  // --- Step 3: add the missing assistant tool_calls message ---
  if (needsToolCall.length > 0) {
    result.push({
      role: "assistant",
      tool_calls: needsToolCall.map(tc => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.input ?? {}) },
      })),
    });
  }

  // --- Step 4: add missing synthetic tool results ---
  for (const tc of needsToolResult) {
    result.push({ role: "tool", tool_call_id: tc.id, content: ABORT_NOTICE });
  }

  // --- Step 5: final invariant — NO tool_call id without a tool message.
  // Covers orphans beyond the pending set (e.g. partial manual edits).
  const finalResultIds = new Set<string>();
  for (const msg of result) {
    if (msg.role === "tool") finalResultIds.add((msg as any).tool_call_id);
  }
  for (const msg of result) {
    if (msg.role === "assistant" && Array.isArray((msg as any).tool_calls)) {
      for (const tc of (msg as any).tool_calls) {
        if (!finalResultIds.has(tc.id)) {
          log.warn({ orphanId: tc.id }, "OpenAI cleanupAbortedTools: orphan tool_call — adding emergency result");
          result.push({ role: "tool", tool_call_id: tc.id, content: ABORT_NOTICE });
          finalResultIds.add(tc.id);
        }
      }
    }
  }

  log.info(
    { messageCount: result.length, originalCount: messages.length },
    "OpenAI cleanupAbortedTools: cleanup complete",
  );
  return result;
}
