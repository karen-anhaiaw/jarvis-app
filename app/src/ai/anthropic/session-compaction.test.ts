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
      textResponse("<summary>This is a proper summary of the conversation with plenty of detail preserved.</summary>"),
    ]);

    const events = await drainCompact(session, 100_000);

    expect(create).toHaveBeenCalledTimes(2);
    // base 8192 → retry min(8192*4, getMaxOutput(fable)=128000) = 32768
    expect(create.mock.calls[0][0].max_tokens).toBe(8192);
    expect(create.mock.calls[1][0].max_tokens).toBe(32_768);
    const done = events.find((e) => e.type === "compaction");
    expect(done).toBeDefined();
    expect(done.compaction.summary).toContain("proper summary");
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
      textResponse("<summary>A long enough summary that passes the minimum floor for large contexts easily.</summary>"),
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
      textResponse("<summary>A long enough summary that passes the minimum floor for large contexts easily.</summary>"),
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
      textResponse("<summary>A long enough summary that passes the minimum floor for large contexts easily.</summary>"),
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
        "<summary>A long enough summary that passes the minimum floor for large contexts easily.</summary>",
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
      textResponse("<summary>A long enough summary that passes the minimum floor for large contexts easily.</summary>"),
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
      textResponse("<summary>A long enough summary that passes the minimum floor for large contexts easily.</summary>"),
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
