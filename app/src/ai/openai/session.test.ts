// src/ai/openai/session.test.ts
// Mirrors docs/features/bdd/openai-parity.feature (F2.1-F2.4).
import { describe, it, expect } from "vitest";
import { OpenAISession } from "./session.js";
import { cleanupAbortedToolMessages } from "./cleanup-aborted-tools.js";

// ── Fake OpenAI client ─────────────────────────────────────────────────────
// chat.completions.create returns an async iterable of streaming chunks.

type Chunk = Record<string, unknown>;

const textChunk = (s: string): Chunk => ({ choices: [{ delta: { content: s } }] });
const toolChunk = (index: number, id: string, name: string, args: string): Chunk => ({
  choices: [{ delta: { tool_calls: [{ index, id, function: { name, arguments: args } }] } }],
});
const usageChunk = (): Chunk => ({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } });

function fakeClient(...turns: Chunk[][]) {
  let call = 0;
  return {
    chat: {
      completions: {
        create: async () => {
          const chunks = turns[Math.min(call++, turns.length - 1)];
          return (async function* () { for (const c of chunks) yield c; })();
        },
      },
    },
  } as any;
}

function makeSession(client: any, bus?: any) {
  return new OpenAISession({
    client,
    model: "gpt-test",
    systemPrompt: "sys",
    getTools: () => [],
    label: "test",
    bus,
  });
}

async function drain(gen: AsyncGenerator<unknown, void>) {
  const events: unknown[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

const msgs = (s: OpenAISession) => s.getMessages() as any[];

// ── F2.1: assistant text survives tool calls ──────────────────────────────

describe("OpenAI parity — F2.1 text with tool calls", () => {
  it("assistant text with tool calls is preserved in history", async () => {
    const s = makeSession(fakeClient([
      textChunk("Let me check that file"),
      toolChunk(0, "t1", "read_file", '{"path":"x"}'),
      usageChunk(),
    ]));
    await drain(s.sendAndStream("go"));
    s.addToolResults(
      [{ id: "t1", name: "read_file", input: { path: "x" } }],
      [{ tool_use_id: "t1", content: "file data" }],
    );

    const m = msgs(s);
    // [user, assistant(content + tool_calls), tool]
    expect(m).toHaveLength(3);
    expect(m[1].role).toBe("assistant");
    expect(m[1].content).toBe("Let me check that file");
    expect(m[1].tool_calls).toHaveLength(1);
    expect(m[2].role).toBe("tool");
  });

  it("text-only turn is saved as a plain assistant message", async () => {
    const s = makeSession(fakeClient([textChunk("Done"), usageChunk()]));
    await drain(s.sendAndStream("go"));
    const m = msgs(s);
    expect(m[m.length - 1]).toMatchObject({ role: "assistant", content: "Done" });
  });

  it("pending pre-tool text is consumed exactly once", async () => {
    const s = makeSession(fakeClient(
      [textChunk("Thinking first"), toolChunk(0, "t1", "bash", "{}"), usageChunk()],
      [textChunk("Done2"), usageChunk()],
    ));
    await drain(s.sendAndStream("go"));
    s.addToolResults(
      [{ id: "t1", name: "bash", input: {} }],
      [{ tool_use_id: "t1", content: "ok" }],
    );
    await drain(s.continueAndStream());

    const m = msgs(s);
    const withText = m.filter(x => x.role === "assistant" && typeof x.content === "string" && x.content.includes("Thinking first"));
    expect(withText).toHaveLength(1);
    expect(m[m.length - 1]).toMatchObject({ role: "assistant", content: "Done2" });
  });
});

// ── F2.2: injections without fabricated turns ─────────────────────────────

describe("OpenAI parity — F2.2 context injection", () => {
  it("injections prepend to the real user message — no fake pair", async () => {
    const s = makeSession(fakeClient([textChunk("hi"), usageChunk()]));
    s.setContextInjector(() => ["memory snippet"]);
    await drain(s.sendAndStream("hello"));

    const m = msgs(s);
    // [user(context+prompt), assistant] — NOT [user(ctx), assistant(fake), user, assistant]
    expect(m).toHaveLength(2);
    expect(m[0].role).toBe("user");
    expect(m[0].content).toContain("<context>");
    expect(m[0].content).toContain("memory snippet");
    expect(m[0].content).toContain("hello");
    expect(m.some(x => x.role === "assistant" && String(x.content).includes("Understood"))).toBe(false);
  });

  it("no injections → plain prompt", async () => {
    const s = makeSession(fakeClient([textChunk("hi"), usageChunk()]));
    s.setContextInjector(() => []);
    await drain(s.sendAndStream("hello"));
    expect(msgs(s)[0].content).toBe("hello");
  });
});

// ── F2.3: well-formed bus events ───────────────────────────────────────────

describe("OpenAI parity — F2.3 bus event shape", () => {
  it("streaming start publishes event 'streaming_started' — never a bare type field", async () => {
    const published: any[] = [];
    const bus = { publish: (m: any) => published.push(m), subscribe: () => () => {} };
    const s = makeSession(fakeClient([textChunk("x"), usageChunk()]), bus);
    await drain(s.sendAndStream("go"));

    const start = published.find(m => m.channel === "ai.stream" && m.event === "streaming_started");
    expect(start).toBeDefined();
    expect(start.data.streamingVerb).toBeTruthy();
    expect(start.data.model).toBe("gpt-test");
    // The malformed legacy shape (type set, event missing) must be gone.
    expect(published.some(m => m.channel === "ai.stream" && m.type !== undefined && m.event === undefined)).toBe(false);
  });
});

// ── F2.4: additive abort cleanup (ported Anthropic semantics) ──────────────

describe("OpenAI parity — F2.4 cleanupAbortedToolMessages", () => {
  const pending = (id: string, name = "bash") => ({ id, name, input: {} });
  const ABORT = "[Tool execution was aborted by user]";

  it("abort before any tool message adds the full synthetic pair", () => {
    const history: any[] = [{ role: "user", content: "do it" }];
    const out = cleanupAbortedToolMessages(history, [pending("t1"), pending("t2")]);

    const assistant = out.find(m => m.role === "assistant" && (m as any).tool_calls);
    expect(assistant).toBeDefined();
    expect((assistant as any).tool_calls.map((tc: any) => tc.id)).toEqual(["t1", "t2"]);
    const toolMsgs = out.filter(m => m.role === "tool");
    expect(toolMsgs.map((t: any) => t.tool_call_id).sort()).toEqual(["t1", "t2"]);
    expect(toolMsgs.every((t: any) => t.content === ABORT)).toBe(true);
  });

  it("completed previous sequences are never touched", () => {
    const completed = [
      { role: "user", content: "first" },
      { role: "assistant", tool_calls: [{ id: "old1", type: "function", function: { name: "ls", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "old1", content: "files" },
      { role: "user", content: "second" },
    ];
    const out = cleanupAbortedToolMessages(completed as any, [pending("t1")]);

    // Original four messages unchanged, in place
    expect(out.slice(0, 4)).toEqual(completed);
    // Pending pair appended
    expect(out.filter(m => m.role === "tool" && (m as any).tool_call_id === "t1")).toHaveLength(1);
  });

  it("existing tool_call without result gains only the synthetic result", () => {
    const history = [
      { role: "user", content: "go" },
      { role: "assistant", tool_calls: [{ id: "t1", type: "function", function: { name: "bash", arguments: "{}" } }] },
    ];
    const out = cleanupAbortedToolMessages(history as any, [pending("t1")]);

    const assistants = out.filter(m => m.role === "assistant");
    expect(assistants).toHaveLength(1); // no duplicate
    expect(out.filter(m => m.role === "tool" && (m as any).tool_call_id === "t1")).toHaveLength(1);
  });

  it("orphaned non-pending tool_calls get emergency results — final invariant holds", () => {
    const history = [
      { role: "assistant", tool_calls: [{ id: "tX", type: "function", function: { name: "ls", arguments: "{}" } }] },
    ];
    const out = cleanupAbortedToolMessages(history as any, [pending("t1")]);

    const resultIds = new Set(out.filter(m => m.role === "tool").map((t: any) => t.tool_call_id));
    expect(resultIds.has("tX")).toBe(true);
    expect(resultIds.has("t1")).toBe(true);
    // Invariant: every tool_call id has a tool message
    const callIds = out.flatMap(m => (m as any).tool_calls?.map((tc: any) => tc.id) ?? []);
    for (const id of callIds) expect(resultIds.has(id)).toBe(true);
  });

  it("empty pending is a no-op", () => {
    const history: any[] = [{ role: "user", content: "x" }];
    expect(cleanupAbortedToolMessages(history, [])).toEqual(history);
  });
});
