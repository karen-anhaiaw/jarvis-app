// One-off healer for conversation JSON files damaged by the sliding-window
// orphan bug (see docs/features/compaction.md, "Safe-split invariant").
//
// Run from `app/` with:
//   npx tsx scripts/heal-sessions.mts <path/to/session.json> [more.json ...]
//
// What it does (in order):
//   1. Reads the StoredConversation JSON.
//   2. Drops any leading orphan tool_result-only user message at messages[0]
//      (cannot be sanitized — no previous message to pair with).
//   3. Runs the project's own sanitizeMessages() — the same function used at
//      restore time — which handles orphan tool_result AND orphan tool_use
//      blocks by inserting synthetic placeholders.
//   4. Collapses consecutive same-role pairs by inserting a synthetic
//      counterpart between them (text-only, single-line marker).
//   5. Writes the file back, updating messageCount + savedAt. The
//      instanceId is preserved so the X-Claude-Code-Session-Id header
//      stays stable.
//
// Intended to run ONCE per damaged session. Idempotent — re-running on an
// already-clean file is a no-op.
import { readFileSync, writeFileSync } from "node:fs";
import { sanitizeMessages } from "../src/ai/anthropic/sanitize-messages.js";

interface Stored {
  sessionId: string;
  instanceId: string;
  provider: string;
  model: string;
  messages: any[];
  savedAt: string;
  messageCount: number;
}

function blocks(m: any): any[] {
  if (typeof m?.content === "string") return [];
  return Array.isArray(m?.content) ? m.content : [];
}

function startsWithToolResult(m: any): boolean {
  if (m?.role !== "user") return false;
  const bs = blocks(m);
  return bs.length > 0 && bs[0]?.type === "tool_result";
}

/**
 * True iff `m` is a user message whose content is exclusively `tool_result`
 * blocks (no interleaved text/image). These are the only ones safe to merge
 * across boundaries — a user message with text PLUS tool_result is a real
 * prompt that happens to carry results and must be preserved verbatim.
 */
function isToolResultOnly(m: any): boolean {
  if (m?.role !== "user") return false;
  const bs = blocks(m);
  if (bs.length === 0) return false;
  return bs.every((b) => b?.type === "tool_result");
}

/**
 * Merge runs of consecutive user-tool_result-only messages into a single
 * user message, deduplicating by `tool_use_id` (first occurrence wins).
 *
 * Failure mode this fixes: a tool was responded to twice in sequence, e.g.
 *   [144] assistant tool_use(X)
 *   [145] user tool_result(X)
 *   [146] user tool_result(X)   ← Anthropic rejects with "each tool_use must
 *                                  have a single result. Found multiple
 *                                  tool_result blocks with id: X"
 * After merge:
 *   [144] assistant tool_use(X)
 *   [145] user tool_result(X)   (the second is dropped — same id, kept first)
 *
 * Also resolves the alternation violation that two adjacent user messages
 * create. Runs BEFORE sanitizeMessages because sanitize's pass A only checks
 * for orphan tool_result, not duplicates within a run.
 */
function mergeAdjacentToolResults(msgs: any[]): { out: any[]; merged: number; deduped: number } {
  const out: any[] = [];
  let merged = 0;
  let deduped = 0;
  let i = 0;
  while (i < msgs.length) {
    if (!isToolResultOnly(msgs[i])) {
      out.push(msgs[i]);
      i++;
      continue;
    }
    const seen = new Map<string, any>();
    let runEnd = i;
    while (runEnd < msgs.length && isToolResultOnly(msgs[runEnd])) {
      for (const b of blocks(msgs[runEnd])) {
        if (!seen.has(b.tool_use_id)) seen.set(b.tool_use_id, b);
        else deduped++;
      }
      runEnd++;
    }
    if (runEnd - i > 1) merged += runEnd - i - 1;
    out.push({ role: "user", content: Array.from(seen.values()) });
    i = runEnd;
  }
  return { out, merged, deduped };
}

/**
 * Insert text-only synthetic turns between any two consecutive same-role
 * messages so the array strictly alternates user/assistant. The sanitizer
 * doesn't enforce alternation (it only fixes tool pair orphans), so we do it
 * here as a separate, conservative pass.
 */
function repairAlternation(msgs: any[]): any[] {
  const out: any[] = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) {
      const synthRole = m.role === "user" ? "assistant" : "user";
      out.push({
        role: synthRole,
        content: "[Synthetic turn inserted by heal-sessions to restore user/assistant alternation.]",
      });
    }
    out.push(m);
  }
  return out;
}

function heal(path: string): void {
  console.log(`\n=== ${path} ===`);
  const data: Stored = JSON.parse(readFileSync(path, "utf-8"));
  const before = data.messages.length;

  let msgs = data.messages;

  // 1. Merge runs of adjacent user-tool_result-only messages.
  //    Dedupes by tool_use_id (first wins). Fixes both the duplicate-result
  //    failure mode AND the alternation violation that adjacent user messages
  //    create. Done before sanitize because sanitize's pass A only catches
  //    orphan tool_results, not duplicates.
  const { out: mergedMsgs, merged: mergedCount, deduped: dedupedCount } = mergeAdjacentToolResults(msgs);
  msgs = mergedMsgs;

  // 2. Drop everything before the first VALID conversation start.
  //    A valid start is a user message that is NOT a `tool_result` continuation
  //    (i.e., a real user prompt). This collapses any leading orphan tool_result,
  //    any leading assistant message (and the tool_results that depended on it),
  //    and any other interleaving until we reach a fresh turn boundary.
  //
  //    Done in a single forward scan rather than alternating drop-tool_result /
  //    drop-non-user passes — alternating leaves new orphans after each drop
  //    and requires a re-sanitize. The forward scan converges in one pass.
  let droppedLeading = 0;
  while (msgs.length > 0) {
    const m = msgs[0];
    if (m.role === "user" && !startsWithToolResult(m)) break;
    msgs = msgs.slice(1);
    droppedLeading++;
  }

  // 3. sanitize: replace orphan tool_result with text placeholders, inject
  //    synthetic tool_result for orphan tool_use (incl. the case where the
  //    LAST message is an unanswered assistant tool_use).
  const sanitized = sanitizeMessages(msgs);

  // 4. Final alternation pass — sanitize doesn't enforce alternation, only
  //    tool-pair correctness. Inserts text-only synthetic turns between any
  //    two consecutive same-role messages.
  const repaired = repairAlternation(sanitized);

  data.messages = repaired;
  data.messageCount = repaired.length;
  data.savedAt = new Date().toISOString();

  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");

  console.log(`  messages: ${before} → ${repaired.length}`);
  console.log(`  merged adjacent tool_result runs: ${mergedCount}`);
  console.log(`  deduped tool_result blocks (same id): ${dedupedCount}`);
  console.log(`  dropped leading non-start messages: ${droppedLeading}`);
  if (repaired.length > 0) {
    const first = repaired[0];
    const firstType = typeof first.content === "string"
      ? `string("${first.content.slice(0, 60).replace(/\n/g, " ")}")`
      : Array.isArray(first.content)
        ? first.content.map((b: any) => b.type).join(",")
        : "?";
    console.log(`  new first message: ${first.role} → ${firstType}`);
  }
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("Usage: npx tsx scripts/heal-sessions.mts <file.json> [...]");
  process.exit(1);
}
for (const f of files) heal(f);
