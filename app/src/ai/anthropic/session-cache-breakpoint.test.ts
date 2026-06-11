import { describe, it, expect } from "vitest";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { AnthropicSession } from "./session.js";

/**
 * Regression tests for cache_control placement on assistant messages.
 *
 * Bug: placeMessageCacheBreakpoint() was unconditionally placing cache_control
 * on the LAST content block of the last assistant message. When claude-fable-5
 * (adaptive thinking always on) left a `thinking` block as the last block,
 * Anthropic returned HTTP 400:
 *   "messages.N.content.0.thinking.cache_control: Extra inputs are not permitted"
 *
 * Fix: skip non-cacheable block types (`thinking`, `redacted_thinking`) when
 * scanning for the anchor block, falling back to the last cacheable block.
 */

// ---------------------------------------------------------------------------
// Minimal AnthropicSession construction helper
// ---------------------------------------------------------------------------

function buildSession(): AnthropicSession {
  // Constructor takes a single options object (see session.ts:106). The tests
  // below exercise placeMessageCacheBreakpoint() via reflection and inject
  // messages directly, so a minimal valid construction is all we need.
  return new AnthropicSession({
    model: "claude-fable-5",
    systemPrompt: "test system prompt",
    getTools: () => [],
    label: "test-label",
  });
}

// ---------------------------------------------------------------------------
// Direct unit test for placeMessageCacheBreakpoint via observable side-effects
// ---------------------------------------------------------------------------

/**
 * Inject messages into the session's internal history, then call
 * `placeMessageCacheBreakpoint` via `stripAllMessageCacheControl` +
 * the private method chain. Since these are private, we exercise them
 * indirectly by calling the internal helper through casting.
 *
 * Alternatively, we can test the observable contract: after calling
 * the (private) method via reflection, the correct block carries
 * cache_control and no thinking block has one.
 */
function callPlaceCacheBreakpoint(session: AnthropicSession): void {
  (session as any).placeMessageCacheBreakpoint();
}

function getMessages(session: AnthropicSession): MessageParam[] {
  return (session as any).messages as MessageParam[];
}

function injectMessages(session: AnthropicSession, messages: MessageParam[]): void {
  (session as any).messages = messages;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("placeMessageCacheBreakpoint — thinking block safety", () => {
  it("places cache_control on a text block, not the preceding thinking block", () => {
    const session = buildSession();

    injectMessages(session, [
      { role: "user", content: "Hello" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Let me reason…" } as any,
          { type: "text", text: "Answer here." },
        ],
      },
    ]);

    callPlaceCacheBreakpoint(session);

    const messages = getMessages(session);
    const assistantMsg = messages[1];
    const content = assistantMsg.content as any[];

    // The text block (index 1) must have cache_control
    expect(content[1].cache_control).toEqual({ type: "ephemeral" });
    // The thinking block (index 0) must NOT have cache_control
    expect(content[0].cache_control).toBeUndefined();
  });

  it("skips placing cache_control if the only block is a thinking block", () => {
    const session = buildSession();

    injectMessages(session, [
      { role: "user", content: "Hello" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Reasoning only, no text." } as any,
        ],
      },
    ]);

    callPlaceCacheBreakpoint(session);

    const messages = getMessages(session);
    const content = messages[1].content as any[];

    // No cache_control anywhere — all blocks are non-cacheable
    expect(content[0].cache_control).toBeUndefined();
  });

  it("places cache_control on the last non-thinking block when multiple thinking blocks precede text", () => {
    const session = buildSession();

    injectMessages(session, [
      { role: "user", content: "Question" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Step 1" } as any,
          { type: "thinking", thinking: "Step 2" } as any,
          { type: "text", text: "Final answer." },
        ],
      },
    ]);

    callPlaceCacheBreakpoint(session);

    const content = (getMessages(session)[1].content) as any[];
    expect(content[2].cache_control).toEqual({ type: "ephemeral" });
    expect(content[0].cache_control).toBeUndefined();
    expect(content[1].cache_control).toBeUndefined();
  });

  it("handles redacted_thinking blocks the same way", () => {
    const session = buildSession();

    injectMessages(session, [
      { role: "user", content: "Sensitive question" },
      {
        role: "assistant",
        content: [
          { type: "redacted_thinking", data: "REDACTED" } as any,
          { type: "text", text: "Safe answer." },
        ],
      },
    ]);

    callPlaceCacheBreakpoint(session);

    const content = (getMessages(session)[1].content) as any[];
    expect(content[1].cache_control).toEqual({ type: "ephemeral" });
    expect(content[0].cache_control).toBeUndefined();
  });

  it("still works for normal text-only responses (no regression)", () => {
    const session = buildSession();

    injectMessages(session, [
      { role: "user", content: "Hello" },
      {
        role: "assistant",
        content: [{ type: "text", text: "Hi there!" }],
      },
    ]);

    callPlaceCacheBreakpoint(session);

    const content = (getMessages(session)[1].content) as any[];
    expect(content[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("still works for tool_use-only responses (no regression)", () => {
    const session = buildSession();

    injectMessages(session, [
      { role: "user", content: "Do something" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }],
      },
    ]);

    callPlaceCacheBreakpoint(session);

    const content = (getMessages(session)[1].content) as any[];
    expect(content[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("thinking block before tool_use — cache_control goes on tool_use", () => {
    const session = buildSession();

    injectMessages(session, [
      { role: "user", content: "Do something smart" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Should I call a tool?" } as any,
          { type: "tool_use", id: "t2", name: "read_file", input: { path: "/foo" } },
        ],
      },
    ]);

    callPlaceCacheBreakpoint(session);

    const content = (getMessages(session)[1].content) as any[];
    expect(content[1].cache_control).toEqual({ type: "ephemeral" });
    expect(content[0].cache_control).toBeUndefined();
  });
});
