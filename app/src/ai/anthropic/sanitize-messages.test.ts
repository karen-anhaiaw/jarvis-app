import { describe, it, expect } from "vitest";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { sanitizeMessages } from "./sanitize-messages.js";

describe("sanitizeMessages", () => {
  it("returns clean history unchanged", () => {
    const messages: MessageParam[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
      { role: "user", content: "how are you?" },
    ];
    const result = sanitizeMessages(messages);
    expect(result).toEqual(messages);
    expect(result).not.toBe(messages);
  });

  it("returns valid tool_use + tool_result pairs unchanged", () => {
    const messages: MessageParam[] = [
      { role: "user", content: "run bash" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool_1", name: "bash", input: { command: "ls" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool_1", content: "file.txt" }],
      },
      { role: "assistant", content: "I see file.txt" },
    ];
    const result = sanitizeMessages(messages);
    expect(result).toEqual(messages);
  });

  it("replaces orphan tool_result (no preceding tool_use) with text summary", () => {
    const messages: MessageParam[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "sure, let me check" },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "orphan_1", content: "some output" }],
      },
      { role: "user", content: "new message" },
    ];
    const result = sanitizeMessages(messages);
    expect(result).toHaveLength(4);
    expect(result[2]).toEqual({
      role: "user",
      content: "[Capability was interrupted during previous session]",
    });
  });

  it("replaces orphan tool_use + tool_result pair with text summaries", () => {
    const messages: MessageParam[] = [
      { role: "user", content: "do something" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool_A", name: "bash", input: { command: "ls" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool_WRONG", content: "output" }],
      },
      { role: "user", content: "next prompt" },
    ];
    const result = sanitizeMessages(messages);
    expect(result).toHaveLength(4);
    expect(result[1]).toEqual({
      role: "assistant",
      content: "[Interrupted: was about to execute bash]",
    });
    expect(result[2]).toEqual({
      role: "user",
      content: "[Capability was interrupted during previous session]",
    });
  });

  it("handles multiple orphans in the same history", () => {
    const messages: MessageParam[] = [
      { role: "user", content: "first" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "/a" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
      },
      { role: "assistant", content: "got it" },
      { role: "user", content: "second" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t2", name: "bash", input: { command: "pwd" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t_orphan", content: "out" }],
      },
    ];
    const result = sanitizeMessages(messages);
    expect(result[0]).toEqual(messages[0]);
    expect(result[1]).toEqual(messages[1]);
    expect(result[2]).toEqual(messages[2]);
    expect(result[3]).toEqual(messages[3]);
    expect(result[4]).toEqual(messages[4]);
    expect(result[5]).toEqual({
      role: "assistant",
      content: "[Interrupted: was about to execute bash]",
    });
    expect(result[6]).toEqual({
      role: "user",
      content: "[Capability was interrupted during previous session]",
    });
  });

  it("handles tool_result with multiple tool_use_ids (parallel tools)", () => {
    const messages: MessageParam[] = [
      { role: "user", content: "do two things" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } },
          { type: "tool_use", id: "t2", name: "read_file", input: { path: "/a" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "files" },
          { type: "tool_result", tool_use_id: "t2", content: "content" },
        ],
      },
      { role: "assistant", content: "done" },
    ];
    const result = sanitizeMessages(messages);
    expect(result).toEqual(messages);
  });

  it("detects partial match in parallel tools as orphan", () => {
    const messages: MessageParam[] = [
      { role: "user", content: "do two things" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } },
          { type: "tool_use", id: "t2", name: "read_file", input: { path: "/a" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "files" },
          { type: "tool_result", tool_use_id: "t_WRONG", content: "content" },
        ],
      },
    ];
    const result = sanitizeMessages(messages);
    expect(result[1]).toEqual({
      role: "assistant",
      content: "[Interrupted: was about to execute bash, read_file]",
    });
    expect(result[2]).toEqual({
      role: "user",
      content: "[Capability was interrupted during previous session]",
    });
  });

  it("does not mutate the original array", () => {
    const messages: MessageParam[] = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t_orphan", content: "x" }],
      },
    ];
    const original = JSON.parse(JSON.stringify(messages));
    sanitizeMessages(messages);
    expect(messages).toEqual(original);
  });

  // ─── Orphan tool_use tests (the case that broke jarvis-brain) ──────────

  it("injects synthetic tool_result when next msg is a string user prompt", () => {
    // The bug from the field: assistant emits tool_use, but the very next
    // turn is a fresh string-content user message ("onde paramos?") with no
    // tool_result for the pending tool_use id.
    const messages: MessageParam[] = [
      { role: "user", content: "do something" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "let me check" },
          { type: "tool_use", id: "tool_X", name: "jarvis_eval", input: { code: "1+1" } },
        ],
      },
      { role: "user", content: "onde paramos?" },
    ];
    const result = sanitizeMessages(messages);
    expect(result).toHaveLength(4);
    // Original assistant tool_use kept intact
    expect(result[1]).toEqual(messages[1]);
    // Synthetic tool_result inserted between assistant and the new user prompt
    expect(result[2]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool_X",
          content: "[Interrupted — tool was cancelled before completing. Synthetic placeholder injected by sanitizer.]",
          is_error: true,
        },
      ],
    });
    expect(result[3]).toEqual(messages[2]);
  });

  it("injects synthetic tool_result when assistant tool_use is at the end of history", () => {
    // No next message at all — happens when persistence captured a session
    // mid-tool-call. Sanitizer must close the loop so the API accepts
    // the next user prompt that arrives after restart.
    const messages: MessageParam[] = [
      { role: "user", content: "list files" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t_end", name: "list_dir", input: { path: "/" } }],
      },
    ];
    const result = sanitizeMessages(messages);
    expect(result).toHaveLength(3);
    expect(result[2]).toEqual({
      role: "user",
      content: [
        expect.objectContaining({
          type: "tool_result",
          tool_use_id: "t_end",
          is_error: true,
        }),
      ],
    });
  });

  it("injects synthetic tool_result when next msg is another assistant turn", () => {
    // Edge case: history corrupted such that two assistant messages stack
    // without the user/tool_result between them.
    const messages: MessageParam[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t_skip", name: "bash", input: { command: "ls" } }],
      },
      { role: "assistant", content: "I think it worked" },
    ];
    const result = sanitizeMessages(messages);
    // Should be: original-user, original-assistant-with-tool_use, synthetic-user-tool_result, original-assistant-text
    expect(result).toHaveLength(4);
    expect(result[2]).toMatchObject({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t_skip", is_error: true }],
    });
    expect(result[3]).toEqual(messages[2]);
  });

  it("handles parallel tool_use where some ids are satisfied and some aren't", () => {
    const messages: MessageParam[] = [
      { role: "user", content: "two tasks" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tA", name: "bash", input: { command: "ls" } },
          { type: "tool_use", id: "tB", name: "read_file", input: { path: "/x" } },
        ],
      },
      // Only tA gets a result — tB is the orphan
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tA", content: "files" }],
      },
    ];
    const result = sanitizeMessages(messages);
    // Pass A: this message has a tool_result whose id matches tA in the prev
    // assistant message — `allMatched` is true (every result id has a use).
    // So Pass A leaves it alone. Pass B then sees the assistant with tB
    // unsatisfied and inserts a synthetic for tB before the partial-match user.
    expect(result).toHaveLength(4);
    expect(result[2]).toMatchObject({
      role: "user",
      content: [
        expect.objectContaining({ type: "tool_result", tool_use_id: "tB", is_error: true }),
      ],
    });
    // Original partial-match user message remains
    expect(result[3]).toEqual(messages[2]);
  });

  it("does not inject when tool_use is fully satisfied by next msg", () => {
    const messages: MessageParam[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tOK", name: "bash", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tOK", content: "ok" }],
      },
    ];
    const result = sanitizeMessages(messages);
    expect(result).toEqual(messages);
  });

  // ─── Duplicate tool_result dedup tests ───────────────────────────────
  // Anthropic rejects with:
  //   messages.N.content.M: each tool_use must have a single result.
  //   Found multiple 'tool_result' blocks with id: toolu_...
  // The sanitizer must collapse duplicates by keeping the first occurrence.

  it("dedupes two tool_result blocks for the same id inside one user message", () => {
    const messages: MessageParam[] = [
      { role: "user", content: "run X" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tDup", name: "bash", input: {} }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tDup", content: "first" },
          { type: "tool_result", tool_use_id: "tDup", content: "second (duplicate)" },
        ],
      },
    ];
    const result = sanitizeMessages(messages);
    expect(result).toHaveLength(3);
    expect(result[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tDup", content: "first" },
      ],
    });
  });

  it("dedupes tool_result blocks split across consecutive user messages (stale capability.result race)", () => {
    // Real-world scenario from production:
    //   1. cleanupAbortedTools injects a synthetic placeholder tool_result(X).
    //   2. Session moves on, hits waiting_tools for a different tool (Y).
    //   3. The original X tool finally completes and capability.result arrives.
    //   4. handleToolResult doesn't validate ids against pendingCalls, so a
    //      second tool_result(X) gets pushed.
    //   5. Next API call returns 400 "Found multiple 'tool_result' blocks
    //      with id: X".
    const messages: MessageParam[] = [
      { role: "user", content: "do X" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tX", name: "bash", input: {} }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tX",
            content: "[Tool execution was aborted by user]",
            is_error: true,
          },
        ],
      },
      // ... time passes, new turn pushes a stale duplicate result for tX
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tX", content: "late real result" },
        ],
      },
    ];
    const result = sanitizeMessages(messages);
    // The duplicate user message ends up empty after dedup → replaced with text turn.
    expect(result).toHaveLength(4);
    // First tool_result preserved as-is
    expect(result[2]).toEqual(messages[2]);
    // Second collapsed into text turn
    expect(result[3]).toEqual({
      role: "user",
      content: "[Duplicate tool_result blocks removed by sanitizer]",
    });
  });

  it("dedup preserves non-duplicate blocks in the same message", () => {
    const messages: MessageParam[] = [
      { role: "user", content: "two tasks" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tA", name: "bash", input: {} },
          { type: "tool_use", id: "tB", name: "read_file", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tA", content: "first A" },
          { type: "tool_result", tool_use_id: "tB", content: "first B" },
          { type: "tool_result", tool_use_id: "tA", content: "dup A (drop)" },
        ],
      },
    ];
    const result = sanitizeMessages(messages);
    expect(result).toHaveLength(3);
    expect(result[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tA", content: "first A" },
        { type: "tool_result", tool_use_id: "tB", content: "first B" },
      ],
    });
  });

  it("dedup is idempotent — already-clean history is unchanged", () => {
    const messages: MessageParam[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "bash", input: {} },
          { type: "tool_use", id: "t2", name: "read_file", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "x" },
          { type: "tool_result", tool_use_id: "t2", content: "y" },
        ],
      },
    ];
    const once = sanitizeMessages(messages);
    const twice = sanitizeMessages(once);
    expect(once).toEqual(messages);
    expect(twice).toEqual(once);
  });
});
