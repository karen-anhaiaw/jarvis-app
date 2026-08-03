// src/core/session-dispatcher-abort.test.ts
//
// Regression tests for the abort/queue-stuck bug (2026-08-03).
//
// BUG (observed live): aborting a session while a tool was in flight left the
// dispatcher's per-session `running` flag true while SessionManager's state
// stack had already returned to idle. Every subsequent ai.request then hit the
// `if (d.running)` branch and only enqueued — nothing ever drained the queue.
//
// ROOT CAUSE: two sources of truth for "is the session busy?" updated
// inconsistently on the abort path. The fix reconciles d.running with the
// stateStack at the end of abort(): manager idle => dispatcher not running.
//
// See docs/features/bdd/session-dispatcher-abort.feature

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventBus } from "./bus.js";
import { SessionManager } from "./session-manager.js";
import { SessionDispatcher } from "./session-dispatcher.js";
import type { AISession, AISessionFactory } from "../ai/types.js";

// ─── Minimal fake AISession ──────────────────────────────────────────────
// The dispatcher only calls: sendAndStream, continueAndStream, addToolResults,
// abort, close, getMessages, setMessages, and (duck-typed) setTurnTraceId.
function makeFakeSession(id: string): AISession {
  return {
    sessionId: id,
    // Default: a stream that completes with plain text (no tools).
    async *sendAndStream() {
      yield { type: "message_complete" as const, stopReason: "end_turn" as const,
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } };
    },
    async *continueAndStream() {
      yield { type: "message_complete" as const, stopReason: "end_turn" as const,
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } };
    },
    addToolResults() {},
    abort() {},
    close() {},
    getMessages() { return []; },
    setMessages() {},
  } as unknown as AISession;
}

function makeFactory(): AISessionFactory {
  return {
    create: (opts?: { label?: string }) => makeFakeSession(opts?.label ?? "unknown"),
    createWithPrompt: (opts: { label?: string }) => makeFakeSession(opts.label ?? "unknown"),
    getToolDefinitions: () => [],
  } as unknown as AISessionFactory;
}

describe("SessionDispatcher.abort — no zombie, queue drains", () => {
  let bus: EventBus;
  let sessions: SessionManager;
  let dispatcher: SessionDispatcher;

  beforeEach(() => {
    bus = new EventBus();
    sessions = new SessionManager(makeFactory());
    sessions.setBus(bus);
    dispatcher = new SessionDispatcher(sessions);
    dispatcher.start(bus);
  });

  // Helper: force a session into a given managed state by pushing frames,
  // and set up the dispatcher's per-session runtime state to mirror it.
  function makeBusy(sessionId: string, state: "processing" | "waiting_tools") {
    sessions.get(sessionId); // create
    sessions.pushState(sessionId, "processing");
    if (state === "waiting_tools") {
      sessions.pushState(sessionId, "waiting_tools");
    }
    const d = dispatcher.getDispatch(sessionId);
    d.running = true;
    d.currentTraceId = "trace-x";
    if (state === "waiting_tools") {
      d.pendingToolCalls = [{ id: "bash-1", name: "bash", input: { command: "sleep 300" } }];
    }
  }

  it("waiting_tools abort resets running and drains the stuck message", () => {
    makeBusy("main", "waiting_tools");
    // one message stuck in the queue
    const d = dispatcher.getDispatch("main");
    d.queue.push({ text: "retry this", source: "chat-input", traceId: "t-q" });

    dispatcher.abort("main");

    // The stuck message MUST be picked up — drainQueue shifts it out of the
    // queue and dispatches it. Draining legitimately re-enters "processing"
    // (dispatchToSession pushes it) to serve the drained message, so we assert
    // on the queue emptying, NOT on the session staying idle. The whole point
    // of the fix is that the queue is no longer stuck.
    expect(d.queue.length).toBe(0);
  });

  it("waiting_tools abort with EMPTY queue returns to idle (no zombie)", () => {
    makeBusy("main", "waiting_tools");
    // no queued messages — nothing to drain

    dispatcher.abort("main");

    expect(sessions.getState("main")).toBe("idle");
    expect(dispatcher.getDispatch("main").running).toBe(false);
  });

  it("processing abort reconciles running to the stack truth (Case B)", () => {
    // Case B: the stream never emits a clean aborted event, so consumeStream
    // will not reset running. abort() itself must reconcile.
    makeBusy("main", "processing");

    dispatcher.abort("main");

    // sessions.abort() popped the single "processing" frame => idle.
    expect(sessions.getState("main")).toBe("idle");
    // The invariant that was violated live: manager idle but dispatcher running.
    expect(dispatcher.getDispatch("main").running).toBe(false);
  });

  it("never leaves a zombie: manager idle AND dispatcher running is impossible after abort", () => {
    makeBusy("main", "waiting_tools");
    dispatcher.abort("main");

    const managerIdle = sessions.getState("main") === "idle";
    const dispatcherRunning = dispatcher.getDispatch("main").running;
    expect(managerIdle && dispatcherRunning).toBe(false);
  });

  it("abort on unknown session is a safe no-op", () => {
    expect(() => dispatcher.abort("ghost")).not.toThrow();
    expect(dispatcher.getDispatch("ghost").running).toBe(false);
  });

  // ── Part 2: cleanupAbortedTools called on waiting_tools abort ────────────

  it("waiting_tools abort calls cleanupAbortedTools with the pending calls", () => {
    // A tool_use block for the aborted bash sits in history with no matching
    // tool_result. Without cleanup, the next turn gets HTTP 400 from Anthropic.
    const cleanupSpy = vi.fn();
    sessions.get("main");
    const managed = sessions.peek("main")!;
    (managed.session as any).cleanupAbortedTools = cleanupSpy;

    sessions.pushState("main", "processing");
    sessions.pushState("main", "waiting_tools");
    const d = dispatcher.getDispatch("main");
    d.running = true;
    d.currentTraceId = "trace-x";
    const pending = [{ id: "bash-1", name: "bash", input: { command: "sleep 300" } }];
    d.pendingToolCalls = pending;

    dispatcher.abort("main");

    expect(cleanupSpy).toHaveBeenCalledTimes(1);
    expect(cleanupSpy).toHaveBeenCalledWith(pending);
  });

  it("processing abort does NOT call cleanupAbortedTools (no orphan tool_use)", () => {
    const cleanupSpy = vi.fn();
    sessions.get("main");
    (sessions.peek("main")!.session as any).cleanupAbortedTools = cleanupSpy;

    sessions.pushState("main", "processing");
    const d = dispatcher.getDispatch("main");
    d.running = true;
    d.currentTraceId = "trace-x";

    dispatcher.abort("main");

    expect(cleanupSpy).not.toHaveBeenCalled();
  });

  // ── Part 4: abortEpoch discards a late capability.result ────────────────

  it("abort increments the session's abortEpoch", () => {
    const d = dispatcher.getDispatch("main");
    const before = d.abortEpoch ?? 0;
    sessions.get("main");
    sessions.pushState("main", "processing");
    d.running = true;

    dispatcher.abort("main");

    expect((d.abortEpoch ?? 0)).toBe(before + 1);
  });

  it("a capability.result from a stale epoch is discarded", async () => {
    // Simulate: bash was dispatched (epoch 0), user aborted (epoch → 1), the
    // session re-armed waiting_tools with a NEW tool. The bash's late result
    // (epoch 0) must NOT be applied against the new pending calls.
    const addToolResults = vi.fn();
    sessions.get("main");
    (sessions.peek("main")!.session as any).addToolResults = addToolResults;

    const d = dispatcher.getDispatch("main");
    // Session is genuinely waiting on a NEW tool of the current epoch (1).
    sessions.pushState("main", "processing");
    sessions.pushState("main", "waiting_tools");
    d.running = true;
    d.abortEpoch = 1;
    d.pendingToolCalls = [{ id: "new-tool", name: "read_file", input: {} }];

    // Late result from the aborted bash — epoch 0 (stale).
    bus.publish({
      channel: "capability.result",
      source: "capability-executor",
      target: "main",
      results: [{ tool_use_id: "bash-1", content: "late output", is_error: false }],
      epoch: 0,
    } as any);

    // Give the async handler a tick.
    await new Promise((r) => setImmediate(r));

    // The stale result must be discarded — the new tool's results are untouched.
    expect(addToolResults).not.toHaveBeenCalled();
    expect(d.pendingToolCalls).toEqual([{ id: "new-tool", name: "read_file", input: {} }]);
  });
});
