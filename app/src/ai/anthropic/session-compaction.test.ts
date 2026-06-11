import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { AnthropicSession } from "./session.js";
import { archivePreCompactBackup } from "../../core/conversation-store.js";

// Intercept usage.log writes — the real logUsage appends to a module-level
// path resolved at import time, which would pollute the developer's actual
// ~/.jarvis/logs/usage.log during test runs.
vi.mock("./usage-log.js", () => ({
  logUsage: vi.fn(),
  USAGE_LOG_PATH: "/dev/null",
}));
import { logUsage } from "./usage-log.js";

/**
 * BDD: docs/features/bdd/compaction.feature — "Failure semantics" section.
 *
 * Pins the contract added after the 2026-06-10 incident: a forced compaction
 * on a 734k-token session received an empty summarizer response
 * (summaryLength: 0) and replaced the entire history with it, unrecoverably.
 * doCompact must either produce a usable summary or change NOTHING.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSession(): AnthropicSession {
  return new AnthropicSession({
    model: "claude-fable-5",
    systemPrompt: "test system prompt",
    getTools: () => [],
    label: "test-compact",
  });
}

function getMessages(session: AnthropicSession): MessageParam[] {
  return (session as any).messages as MessageParam[];
}

function injectMessages(session: AnthropicSession, messages: MessageParam[]): void {
  (session as any).messages = messages;
}

/** Install a fake Anthropic client whose messages.create resolves the given responses in order. */
function mockClient(session: AnthropicSession, responses: Array<any | Error>): ReturnType<typeof vi.fn> {
  let call = 0;
  const create = vi.fn().mockImplementation(() => {
    const r = responses[Math.min(call, responses.length - 1)];
    call++;
    if (r instanceof Error) return Promise.reject(r);
    return Promise.resolve(r);
  });
  (session as any).client = { messages: { create } };
  return create;
}

function textResponse(text: string, stopReason = "end_turn", usage?: any): any {
  return {
    content: [{ type: "text", text }],
    stop_reason: stopReason,
    usage: usage ?? { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  };
}

async function drainCompact(session: AnthropicSession, tokensBefore: number): Promise<any[]> {
  const events: any[] = [];
  for await (const e of (session as any).doCompact(tokensBefore, "forced")) {
    events.push(e);
  }
  return events;
}

const SAMPLE_HISTORY: MessageParam[] = [
  { role: "user", content: "first question" },
  { role: "assistant", content: "first answer" },
  { role: "user", content: "second question" },
  { role: "assistant", content: "second answer" },
];

// Genuinely clears the proportional short-summary floor at EVERY context size
// (F-compact-2.4: >200k → 800 chars, >50k → 300, >10k → 50). The previous
// 78-char inline fixture predated the proportional floor: it passed at ≤50k
// but silently tripped the guard at ≥100k, failing every success-path test.
// Starts with the exact phrase "long enough summary" — assertions match on it.
const LONG_SUMMARY =
  "A long enough summary that passes the minimum floor for large contexts easily. " +
  "It preserves the conversation's key decisions, open questions, and pending work items in detail. ".repeat(9);

// Each test gets an isolated JARVIS_HOME so archivePreCompactBackup (lazy
// path resolution) writes to a throwaway temp dir, never the real ~/.jarvis.
let tmpHome: string;
let prevJarvisHome: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "jarvis-compact-test-"));
  prevJarvisHome = process.env.JARVIS_HOME;
  process.env.JARVIS_HOME = tmpHome;
  vi.mocked(logUsage).mockClear();
});

afterEach(() => {
  if (prevJarvisHome === undefined) delete process.env.JARVIS_HOME;
  else process.env.JARVIS_HOME = prevJarvisHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Empty / short summary guard
// ---------------------------------------------------------------------------

describe("doCompact — empty-summary guard", () => {
  it("empty summary (zero text blocks) aborts compaction and preserves history", async () => {
    const session = buildSession();
    injectMessages(session, [...SAMPLE_HISTORY]);
    mockClient(session, [{ content: [], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 0 } }]);

    const events = await drainCompact(session, 734_164);

    expect(getMessages(session)).toHaveLength(SAMPLE_HISTORY.length); // history intact
    expect(getMessages(session)[0].content).toBe("first question");
    const failed = events.find((e) => e.type === "compaction_failed");
    expect(failed).toBeDefined();
    expect(failed.compactionFailed.reason).toContain("empty");
    expect(failed.compactionFailed.tokensBefore).toBe(734_164);
    expect(events.find((e) => e.type === "compaction")).toBeUndefined();
  });

  it("whitespace-only summary is treated as empty", async () => {
    const session = buildSession();
    injectMessages(session, [...SAMPLE_HISTORY]);
    mockClient(session, [textResponse("   \n\t  ")]);

    const events = await drainCompact(session, 50_000);

    expect(getMessages(session)).toHaveLength(SAMPLE_HISTORY.length);
    expect(events.find((e) => e.type === "compaction_failed")).toBeDefined();
  });

  it("suspiciously short summary for a large context aborts compaction", async () => {
    const session = buildSession();
    injectMessages(session, [...SAMPLE_HISTORY]);
    mockClient(session, [textResponse("<summary>tiny.</summary>")]); // 5 chars << 50 floor

    const events = await drainCompact(session, 700_000); // > 10k activation threshold

    expect(getMessages(session)).toHaveLength(SAMPLE_HISTORY.length);
    const failed = events.find((e) => e.type === "compaction_failed");
    expect(failed).toBeDefined();
    expect(failed.compactionFailed.reason).toContain("short");
  });

  it("short summary for a SMALL context is accepted", async () => {
    const session = buildSession();
    injectMessages(session, [...SAMPLE_HISTORY]);
    mockClient(session, [textResponse("<summary>short ok.</summary>")]);

    const events = await drainCompact(session, 800); // below 10k activation threshold

    const done = events.find((e) => e.type === "compaction");
    expect(done).toBeDefined();
    expect(done.compaction.summary).toBe("short ok.");
    expect(getMessages(session)).toHaveLength(2); // replaced with summary pair
    expect(getMessages(session)[0].content).toContain("short ok.");
  });
});

// ---------------------------------------------------------------------------
// max_tokens thinking-exhaustion retry
// ---------------------------------------------------------------------------

describe("doCompact — max_tokens retry", () => {
  it("retries exactly once with a 4x budget and succeeds with the retry's summary", async () => {
    const session = buildSession();
    injectMessages(session, [...SAMPLE_HISTORY]);
    const create = mockClient(session, [
      { content: [{ type: "thinking", thinking: "..." }], stop_reason: "max_tokens", usage: { input_tokens: 9, output_tokens: 8192 } },
      textResponse(`<summary>${LONG_SUMMARY}</summary>`),
    ]);

    const events = await drainCompact(session, 100_000);

    expect(create).toHaveBeenCalledTimes(2);
    // base 8192 → retry min(8192*4, getMaxOutput(fable)=128000) = 32768
    expect(create.mock.calls[0][0].max_tokens).toBe(8192);
    expect(create.mock.calls[1][0].max_tokens).toBe(32_768);
    const done = events.find((e) => e.type === "compaction");
    expect(done).toBeDefined();
    expect(done.compaction.summary).toContain("long enough summary");
    expect(getMessages(session)).toHaveLength(2);
  });

  it("retry also empty — fails after exactly two calls without touching history", async () => {
    const session = buildSession();
    injectMessages(session, [...SAMPLE_HISTORY]);
    const create = mockClient(session, [
      { content: [{ type: "thinking", thinking: "..." }], stop_reason: "max_tokens", usage: { input_tokens: 9, output_tokens: 8192 } },
      { content: [{ type: "thinking", thinking: "..." }], stop_reason: "max_tokens", usage: { input_tokens: 9, output_tokens: 32768 } },
    ]);

    const events = await drainCompact(session, 100_000);

    expect(create).toHaveBeenCalledTimes(2); // no infinite retry
    expect(getMessages(session)).toHaveLength(SAMPLE_HISTORY.length);
    expect(events.find((e) => e.type === "compaction_failed")).toBeDefined();
  });

  it("does NOT retry when summary is empty but stop_reason is not max_tokens", async () => {
    const session = buildSession();
    injectMessages(session, [...SAMPLE_HISTORY]);
    const create = mockClient(session, [{ content: [], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 0 } }]);

    await drainCompact(session, 100_000);

    expect(create).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// API error path
// ---------------------------------------------------------------------------

describe("doCompact — API error", () => {
  it("summarizer rejection emits compaction_failed with the error message, history intact", async () => {
    const session = buildSession();
    injectMessages(session, [...SAMPLE_HISTORY]);
    mockClient(session, [new Error("400 tool_use ids were found without tool_result blocks")]);

    const events = await drainCompact(session, 200_000);

    expect(getMessages(session)).toHaveLength(SAMPLE_HISTORY.length);
    const failed = events.find((e) => e.type === "compaction_failed");
    expect(failed).toBeDefined();
    expect(failed.compactionFailed.reason).toContain("tool_use ids were found");
  });
});

// ---------------------------------------------------------------------------
// Sanitization before the summarizer call
// ---------------------------------------------------------------------------

describe("doCompact — sanitizes history before summarizer call", () => {
  it("orphan tool_use gets a synthetic tool_result in the messages sent to the API", async () => {
    const session = buildSession();
    const orphanHistory: MessageParam[] = [
      { role: "user", content: "run something" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "running" },
          { type: "tool_use", id: "toolu_orphan_1", name: "bash", input: {} },
        ] as any,
      },
      // next message is a plain user prompt — toolu_orphan_1 has NO tool_result
      { role: "user", content: "never mind, do something else" },
      { role: "assistant", content: "ok" },
    ];
    injectMessages(session, orphanHistory);
    const create = mockClient(session, [
      textResponse(`<summary>${LONG_SUMMARY}</summary>`),
    ]);

    await drainCompact(session, 50_000);

    const sentMessages = create.mock.calls[0][0].messages as MessageParam[];
    const hasSyntheticResult = sentMessages.some(
      (m) =>
        m.role === "user" &&
        Array.isArray(m.content) &&
        (m.content as any[]).some((b) => b.type === "tool_result" && b.tool_use_id === "toolu_orphan_1"),
    );
    expect(hasSyntheticResult).toBe(true);
  });

  it("does not mutate the in-memory history when sanitizing the copy", async () => {
    const session = buildSession();
    const orphanHistory: MessageParam[] = [
      { role: "user", content: "run something" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_orphan_2", name: "bash", input: {} }] as any,
      },
      { role: "user", content: "moving on" },
    ];
    injectMessages(session, orphanHistory);
    // Empty response → compaction fails → history must be EXACTLY as injected
    mockClient(session, [{ content: [], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 0 } }]);

    await drainCompact(session, 50_000);

    const after = getMessages(session);
    expect(after).toHaveLength(3);
    expect(after[1].role).toBe("assistant");
    expect((after[1].content as any[])[0].id).toBe("toolu_orphan_2");
  });
});

// ---------------------------------------------------------------------------
// Pre-compact backup
// ---------------------------------------------------------------------------

describe("doCompact — pre-compact backup", () => {
  it("writes the FULL untrimmed history to sessions/archive before replacing", async () => {
    const session = buildSession();
    injectMessages(session, [...SAMPLE_HISTORY]);
    mockClient(session, [
      textResponse(`<summary>${LONG_SUMMARY}</summary>`),
    ]);

    const events = await drainCompact(session, 100_000);

    expect(events.find((e) => e.type === "compaction")).toBeDefined();
    const archiveDir = join(tmpHome, "sessions", "archive");
    const backups = readdirSync(archiveDir).filter((f) => f.startsWith("test-compact_precompact_"));
    expect(backups).toHaveLength(1);
    const data = JSON.parse(readFileSync(join(archiveDir, backups[0]), "utf-8"));
    expect(data.messageCount).toBe(SAMPLE_HISTORY.length);
    expect(data.messages).toHaveLength(SAMPLE_HISTORY.length);
    expect(data.messages[0].content).toBe("first question");
    // history replaced only after backup
    expect(getMessages(session)).toHaveLength(2);
  });

  it("backup write failure aborts compaction and preserves history", async () => {
    const session = buildSession();
    injectMessages(session, [...SAMPLE_HISTORY]);
    mockClient(session, [
      textResponse(`<summary>${LONG_SUMMARY}</summary>`),
    ]);
    // Sabotage: create sessions/archive as a FILE so the backup write fails
    mkdirSync(join(tmpHome, "sessions"), { recursive: true });
    writeFileSync(join(tmpHome, "sessions", "archive"), "not a directory", "utf-8");

    const events = await drainCompact(session, 100_000);

    expect(getMessages(session)).toHaveLength(SAMPLE_HISTORY.length); // intact
    const failed = events.find((e) => e.type === "compaction_failed");
    expect(failed).toBeDefined();
    expect(failed.compactionFailed.reason).toContain("backup");
    expect(events.find((e) => e.type === "compaction")).toBeUndefined();
  });
});

describe("archivePreCompactBackup — pruning", () => {
  it("keeps only the newest 5 backups per label", async () => {
    const archiveDir = join(tmpHome, "sessions", "archive");
    for (let i = 0; i < 7; i++) {
      const ok = archivePreCompactBackup("prune-label", [{ role: "user", content: `msg ${i}` }]);
      expect(ok).toBe(true);
      // ISO timestamps have ms granularity — space the writes so filenames differ
      await new Promise((r) => setTimeout(r, 3));
    }
    const backups = readdirSync(archiveDir).filter((f) => f.startsWith("prune-label_precompact_"));
    expect(backups).toHaveLength(5);
  });

  it("returns true and writes a readable JSON envelope", () => {
    const ok = archivePreCompactBackup("env-label", [{ role: "user", content: "hello" }]);
    expect(ok).toBe(true);
    const archiveDir = join(tmpHome, "sessions", "archive");
    expect(existsSync(archiveDir)).toBe(true);
    const f = readdirSync(archiveDir).find((x) => x.startsWith("env-label_precompact_"))!;
    const data = JSON.parse(readFileSync(join(archiveDir, f), "utf-8"));
    expect(data.sessionId).toBe("env-label");
    expect(data.reason).toBe("pre-compaction backup");
    expect(data.messageCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Diagnostics — summarizer usage recorded
// ---------------------------------------------------------------------------

describe("doCompact — diagnostics", () => {
  it("records summarizer token usage via logUsage", async () => {
    const session = buildSession();
    injectMessages(session, [...SAMPLE_HISTORY]);
    mockClient(session, [
      textResponse(
        `<summary>${LONG_SUMMARY}</summary>`,
        "end_turn",
        { input_tokens: 730_000, output_tokens: 450, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      ),
    ]);

    await drainCompact(session, 734_164);

    expect(logUsage).toHaveBeenCalledTimes(1);
    const entry = vi.mocked(logUsage).mock.calls[0][0];
    expect(entry.sessionId).toBe("test-compact");
    expect(entry.model).toBe("claude-fable-5");
    expect(entry.input_tokens).toBe(730_000);
    expect(entry.output_tokens).toBe(450);
  });

  it("records usage for BOTH calls when the retry path runs", async () => {
    const session = buildSession();
    injectMessages(session, [...SAMPLE_HISTORY]);
    mockClient(session, [
      { content: [{ type: "thinking", thinking: "..." }], stop_reason: "max_tokens", usage: { input_tokens: 10, output_tokens: 8192 } },
      textResponse(`<summary>${LONG_SUMMARY}</summary>`),
    ]);

    await drainCompact(session, 100_000);

    expect(logUsage).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Success path regression — valid summary still compacts normally
// ---------------------------------------------------------------------------

describe("doCompact — success regression", () => {
  it("valid summary replaces history with the synthetic pair and resets baselines", async () => {
    const session = buildSession();
    injectMessages(session, [...SAMPLE_HISTORY]);
    (session as any).previousRealInputTokens = 123_456;
    (session as any).injectedContextCount = 3;
    mockClient(session, [
      textResponse(`<summary>${LONG_SUMMARY}</summary>`),
    ]);

    const events = await drainCompact(session, 100_000);

    const start = events.find((e) => e.type === "compaction_start");
    expect(start).toBeDefined();
    expect(start.compactionStart.reason).toBe("forced");
    const done = events.find((e) => e.type === "compaction");
    expect(done).toBeDefined();
    expect(done.compaction.engine).toBe("fallback");
    const msgs = getMessages(session);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].content).toContain("[Previous conversation summary]");
    expect(msgs[0].content).toContain("long enough summary");
    expect((session as any).previousRealInputTokens).toBe(0);
    expect((session as any).injectedContextCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// F-compact-2.2/2.3 — summarizer prompt-shape hardening (incident #2)
// BDD: compaction.feature "Summarizer prompt-shape hardening"
//
// Incident #2 (2026-06-10): sanitize stripped a trailing orphan tool_use, the
// history ended in a user tool_result, the summarize instruction was NOT
// appended (old code only appended after assistant messages), and the
// summarizer role-played the conversation instead of summarizing.
// ---------------------------------------------------------------------------

const VALID_SUMMARY = "A long enough summary that passes the minimum floor for large contexts easily — padded to be safe.";

describe("doCompact — summarizer request shape", () => {
  it("appends instruction as a new user message after a trailing assistant message, then the prefill", async () => {
    const session = buildSession();
    injectMessages(session, [...SAMPLE_HISTORY]); // ends with assistant
    const create = mockClient(session, [textResponse(`${VALID_SUMMARY}</summary>`)]);

    await drainCompact(session, 20_000);

    const req = create.mock.calls[0][0];
    const reqMsgs = req.messages;
    // last = prefill, second-to-last = instruction user message
    expect(reqMsgs[reqMsgs.length - 1]).toEqual({ role: "assistant", content: "<summary>" });
    expect(reqMsgs[reqMsgs.length - 2].role).toBe("user");
    expect(reqMsgs[reqMsgs.length - 2].content).toContain("Please summarize the conversation above.");
  });

  it("merges instruction into a trailing plain-text user message (no consecutive users)", async () => {
    const session = buildSession();
    injectMessages(session, [
      ...SAMPLE_HISTORY,
      { role: "user", content: "dangling user prompt" },
    ]);
    const create = mockClient(session, [textResponse(`${VALID_SUMMARY}</summary>`)]);

    await drainCompact(session, 20_000);

    const reqMsgs = create.mock.calls[0][0].messages;
    expect(reqMsgs[reqMsgs.length - 1]).toEqual({ role: "assistant", content: "<summary>" });
    const lastUser = reqMsgs[reqMsgs.length - 2];
    expect(lastUser.role).toBe("user");
    expect(lastUser.content).toContain("dangling user prompt");
    expect(lastUser.content).toContain("Please summarize the conversation above.");
    // no consecutive user messages anywhere
    for (let i = 1; i < reqMsgs.length; i++) {
      expect(reqMsgs[i].role === "user" && reqMsgs[i - 1].role === "user").toBe(false);
    }
  });

  it("appends instruction as a trailing text block when history ends in a tool_result user message (incident #2 path)", async () => {
    const session = buildSession();
    injectMessages(session, [
      { role: "user", content: "do something" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "running tool" },
          { type: "tool_use", id: "tu_1", name: "bash", input: { command: "ls" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: "file1\nfile2" }],
      },
    ]);
    const create = mockClient(session, [textResponse(`${VALID_SUMMARY}</summary>`)]);

    await drainCompact(session, 20_000);

    const reqMsgs = create.mock.calls[0][0].messages;
    expect(reqMsgs[reqMsgs.length - 1]).toEqual({ role: "assistant", content: "<summary>" });
    const lastUser = reqMsgs[reqMsgs.length - 2];
    expect(lastUser.role).toBe("user");
    expect(Array.isArray(lastUser.content)).toBe(true);
    const blocks = lastUser.content as any[];
    expect(blocks[0].type).toBe("tool_result");
    const tail = blocks[blocks.length - 1];
    expect(tail.type).toBe("text");
    expect(tail.text).toContain("Please summarize the conversation above.");
  });

  it("disables thinking on the summarizer call", async () => {
    const session = buildSession();
    injectMessages(session, [...SAMPLE_HISTORY]);
    const create = mockClient(session, [textResponse(`${VALID_SUMMARY}</summary>`)]);

    await drainCompact(session, 20_000);

    expect(create.mock.calls[0][0].thinking).toEqual({ type: "disabled" });
  });

  it("does not mutate the in-memory history when appending the instruction", async () => {
    const session = buildSession();
    const original: MessageParam[] = [
      { role: "user", content: "only question" },
    ];
    injectMessages(session, original.map((m) => ({ ...m })));
    mockClient(session, [textResponse(`${VALID_SUMMARY}</summary>`)]);

    await drainCompact(session, 20_000);

    // history was replaced by the compaction pair — but the ORIGINAL message
    // object must not have been patched with the instruction text
    expect(original[0].content).toBe("only question");
  });
});

describe("doCompact — summary extraction with prefill", () => {
  async function compactWithResponse(text: string): Promise<string> {
    const session = buildSession();
    injectMessages(session, [...SAMPLE_HISTORY]);
    mockClient(session, [textResponse(text)]);
    const events = await drainCompact(session, 20_000);
    const done = events.find((e) => e.type === "compaction");
    return done?.compaction?.summary ?? "";
  }

  it("extracts the body when the response carries only the closing tag (prefill consumed the opening)", async () => {
    const summary = await compactWithResponse(`${VALID_SUMMARY}</summary>`);
    expect(summary).toBe(VALID_SUMMARY);
  });

  it("tolerates a model that re-emits the opening tag", async () => {
    const summary = await compactWithResponse(`<summary>${VALID_SUMMARY}</summary>`);
    expect(summary).toBe(VALID_SUMMARY);
  });

  it("falls back to raw text when no closing tag exists", async () => {
    const summary = await compactWithResponse(VALID_SUMMARY);
    expect(summary).toBe(VALID_SUMMARY);
  });
});

// ---------------------------------------------------------------------------
// F-compact-2.4 — proportional short-summary floor
// BDD: compaction.feature "Summary floor is proportional to context size"
// ---------------------------------------------------------------------------

describe("doCompact — proportional summary floor", () => {
  const cases: Array<{ tokensBefore: number; chars: number; accepted: boolean }> = [
    { tokensBefore: 800, chars: 20, accepted: true },
    { tokensBefore: 9_000, chars: 20, accepted: true },
    { tokensBefore: 11_000, chars: 49, accepted: false },
    { tokensBefore: 11_000, chars: 60, accepted: true },
    { tokensBefore: 60_000, chars: 299, accepted: false },
    { tokensBefore: 60_000, chars: 350, accepted: true },
    { tokensBefore: 416_000, chars: 799, accepted: false },
    { tokensBefore: 416_000, chars: 900, accepted: true },
  ];

  for (const { tokensBefore, chars, accepted } of cases) {
    it(`${tokensBefore} tokens + ${chars}-char summary → ${accepted ? "accepted" : "rejected"}`, async () => {
      const session = buildSession();
      injectMessages(session, [...SAMPLE_HISTORY]);
      mockClient(session, [textResponse(`${"x".repeat(chars)}</summary>`)]);

      const events = await drainCompact(session, tokensBefore);

      const done = events.find((e) => e.type === "compaction");
      const failed = events.find((e) => e.type === "compaction_failed");
      if (accepted) {
        expect(done).toBeDefined();
        expect(failed).toBeUndefined();
      } else {
        expect(done).toBeUndefined();
        expect(failed).toBeDefined();
        expect(failed.compactionFailed.reason).toContain("short");
        expect(getMessages(session)).toHaveLength(SAMPLE_HISTORY.length);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// F-compact-2.5 — image-aware measureContext
// BDD: compaction.feature "Context measurement — image-aware heuristic"
// ---------------------------------------------------------------------------

describe("measureContext — image and tool_result accounting", () => {
  const IMAGE_EST = 6_400;

  function imageBlock(): any {
    return { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "A".repeat(100_000) } };
  }

  it("image blocks count a flat estimate regardless of base64 size", () => {
    const session = buildSession();
    injectMessages(session, [{ role: "user", content: [imageBlock()] }]);
    const ctx = session.measureContext();
    expect(ctx.messagesChars).toBe(IMAGE_EST);
  });

  it("tool_result array content counts nested text and image blocks", () => {
    const session = buildSession();
    injectMessages(session, [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_1",
            content: [
              { type: "text", text: "12345" },
              imageBlock(),
            ],
          } as any,
        ],
      },
    ]);
    const ctx = session.measureContext();
    expect(ctx.messagesChars).toBe(5 + IMAGE_EST);
  });

  it("tool_result string content counts its length", () => {
    const session = buildSession();
    injectMessages(session, [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: "abcdefgh" } as any],
      },
    ]);
    const ctx = session.measureContext();
    expect(ctx.messagesChars).toBe(8);
  });
});
