import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { log } from "../../logger/index.js";

/**
 * Sanitize Anthropic message history before sending it to the API.
 *
 * Three failure modes the API rejects with `invalid_request_error`:
 *
 *   1. ORPHAN tool_result — a `user` message contains tool_result blocks
 *      whose tool_use_id has no matching tool_use in the immediately
 *      previous assistant message.
 *
 *   2. ORPHAN tool_use — an `assistant` message ends with tool_use blocks
 *      and the FOLLOWING message does NOT carry the corresponding
 *      tool_result blocks. Triggered when a tool call was interrupted
 *      (process restart, abort that didn't run cleanupAbortedTools, crash
 *      mid-execution) and a new user prompt arrived afterward.
 *
 *   3. DUPLICATE tool_result — the same `tool_use_id` appears in more than
 *      one tool_result block (either inside the same message or split across
 *      consecutive user messages). Anthropic rejects with
 *      `each tool_use must have a single result. Found multiple
 *       'tool_result' blocks with id: ...`.
 *      Triggered when a stale capability.result for an aborted/old tool
 *      lands while the session is back in waiting_tools, or when
 *      cleanupAbortedTools inserts a synthetic placeholder and the real
 *      result later races in.
 *
 * Strategy: replace orphan pairs with synthetic text turns and drop
 * duplicate tool_result blocks so the API sees a coherent conversation.
 * The model loses some tool execution context but the session keeps
 * working instead of being permanently bricked.
 *
 * Three-pass design (order matters — dedup MUST run first):
 *   - Pass A (dedupeToolResults) dedupes tool_result blocks by tool_use_id,
 *     keeping the FIRST occurrence (which is the one Anthropic already
 *     considered "the result" on its previous turn). Runs first so the
 *     orphan passes see a clean tool_use ↔ tool_result mapping. If a user
 *     message ends up with no blocks after dedup, it is replaced with a
 *     short text turn so we don't ship `{role: "user", content: []}`.
 *   - Pass B (sanitizeOrphanToolResults) replaces tool_result-bearing
 *     messages whose ids have no matching tool_use in the previous
 *     assistant turn.
 *   - Pass C (sanitizeOrphanToolUses) walks the resulting list and inserts
 *     a synthetic tool_result after any assistant message whose tool_use
 *     blocks aren't satisfied by the next message.
 */
export function sanitizeMessages(messages: MessageParam[]): MessageParam[] {
  return sanitizeOrphanToolUses(
    sanitizeOrphanToolResults(dedupeToolResults(messages)),
  );
}

/** Pass A: orphan tool_result without matching tool_use. */
function sanitizeOrphanToolResults(messages: MessageParam[]): MessageParam[] {
  const result: MessageParam[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (!hasToolResultBlocks(msg)) {
      result.push(msg);
      continue;
    }

    const toolResultIds = getToolResultIds(msg);
    const prev = result[result.length - 1];
    const prevToolUseIds = prev ? getToolUseIds(prev) : new Set<string>();
    const allMatched = toolResultIds.every((id) => prevToolUseIds.has(id));

    if (allMatched) {
      result.push(msg);
      continue;
    }

    const toolNames = prev ? getToolUseNames(prev) : [];
    const namesStr = toolNames.length > 0 ? toolNames.join(", ") : "unknown";

    log.warn(
      { index: i, orphanIds: toolResultIds.filter((id) => !prevToolUseIds.has(id)), toolNames },
      "sanitizeMessages: replacing orphan tool pair with text summary",
    );

    if (prev && hasToolUseBlocks(prev)) {
      result[result.length - 1] = {
        role: "assistant",
        content: `[Interrupted: was about to execute ${namesStr}]`,
      };
    }

    result.push({
      role: "user",
      content: "[Capability was interrupted during previous session]",
    });
  }

  return result;
}

/**
 * Pass B: orphan tool_use without matching tool_result.
 *
 * For each assistant message containing tool_use blocks, ensure the IMMEDIATE
 * NEXT message carries tool_result blocks for ALL of those ids. If not,
 * inject a synthetic user turn with placeholder tool_results before the next
 * message. The Anthropic API allows two consecutive user messages, so we
 * always insert a standalone synthetic turn rather than trying to merge it
 * into an existing structured user message — keeps the function pure (no
 * input mutation) and easier to reason about.
 *
 * Design choice: synthesize a tool_result rather than rewriting the
 * tool_use into a text turn. Preserves the tool name + input in history
 * (useful debugging context) and matches the shape that cleanupAbortedTools
 * produces, keeping behaviour consistent.
 */
function sanitizeOrphanToolUses(messages: MessageParam[]): MessageParam[] {
  const result: MessageParam[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    result.push(msg);

    if (!hasToolUseBlocks(msg)) continue;

    const toolUseIds = Array.from(getToolUseIds(msg));
    if (toolUseIds.length === 0) continue;

    const next = messages[i + 1];
    const nextResultIds = next ? new Set(getToolResultIds(next)) : new Set<string>();
    const orphanIds = toolUseIds.filter((id) => !nextResultIds.has(id));

    if (orphanIds.length === 0) continue;

    log.warn(
      { index: i, orphanIds, toolNames: getToolUseNames(msg) },
      "sanitizeMessages: injecting synthetic tool_result for orphan tool_use",
    );

    result.push({
      role: "user",
      content: orphanIds.map((id) => ({
        type: "tool_result" as const,
        tool_use_id: id,
        content: "[Interrupted — tool was cancelled before completing. Synthetic placeholder injected by sanitizer.]",
        is_error: true,
      })),
    });
  }

  return result;
}

/**
 * Pass C: dedupe tool_result blocks by tool_use_id across the entire history.
 *
 * Two shapes produce the API's "Found multiple 'tool_result' blocks with id"
 * error and both are handled here:
 *
 *   (a) Two tool_result blocks for the same id inside one user message
 *       content array. Happens if `addToolResults` ever receives a
 *       `results` array with duplicate `tool_use_id` entries (e.g. an
 *       executor retried internally).
 *   (b) Two user messages, each carrying a tool_result for the same id.
 *       Happens when `cleanupAbortedTools` injects a synthetic placeholder
 *       and a stale real result later races back in via handleToolResult.
 *
 * Strategy: keep the FIRST tool_result encountered for any given id and
 * drop later duplicates. The first one is what the model already saw in
 * its previous turn (its reasoning was conditioned on that value), so
 * keeping it preserves the conversation semantics.
 *
 * If a user message has ALL its blocks dropped, replace the message with
 * a short text turn — `{role: "user", content: []}` is also rejected by
 * the API.
 */
function dedupeToolResults(messages: MessageParam[]): MessageParam[] {
  const seen = new Set<string>();
  const result: MessageParam[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (typeof msg.content === "string" || !Array.isArray(msg.content)) {
      result.push(msg);
      continue;
    }

    const dropped: string[] = [];
    const kept: any[] = [];
    for (const block of msg.content as any[]) {
      if (block?.type !== "tool_result") {
        kept.push(block);
        continue;
      }
      const id = block.tool_use_id;
      if (typeof id !== "string") {
        kept.push(block);
        continue;
      }
      if (seen.has(id)) {
        dropped.push(id);
        continue;
      }
      seen.add(id);
      kept.push(block);
    }

    if (dropped.length === 0) {
      result.push(msg);
      continue;
    }

    log.warn(
      { index: i, droppedToolResultIds: dropped },
      "sanitizeMessages: dropped duplicate tool_result blocks (same tool_use_id seen earlier in history)",
    );

    if (kept.length === 0) {
      result.push({
        role: msg.role,
        content: "[Duplicate tool_result blocks removed by sanitizer]",
      });
    } else {
      result.push({ ...msg, content: kept });
    }
  }

  return result;
}

function hasToolResultBlocks(msg: MessageParam): boolean {
  if (typeof msg.content === "string") return false;
  if (!Array.isArray(msg.content)) return false;
  return msg.content.some((b: any) => b.type === "tool_result");
}

function hasToolUseBlocks(msg: MessageParam): boolean {
  if (typeof msg.content === "string") return false;
  if (!Array.isArray(msg.content)) return false;
  return msg.content.some((b: any) => b.type === "tool_use");
}

function getToolResultIds(msg: MessageParam): string[] {
  if (typeof msg.content === "string" || !Array.isArray(msg.content)) return [];
  return msg.content
    .filter((b: any) => b.type === "tool_result")
    .map((b: any) => b.tool_use_id);
}

function getToolUseIds(msg: MessageParam): Set<string> {
  if (typeof msg.content === "string" || !Array.isArray(msg.content)) return new Set();
  return new Set(
    msg.content.filter((b: any) => b.type === "tool_use").map((b: any) => b.id),
  );
}

function getToolUseNames(msg: MessageParam): string[] {
  if (typeof msg.content === "string" || !Array.isArray(msg.content)) return [];
  return msg.content
    .filter((b: any) => b.type === "tool_use")
    .map((b: any) => b.name);
}
