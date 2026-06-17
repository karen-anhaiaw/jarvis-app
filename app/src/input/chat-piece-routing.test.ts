import { describe, it, expect, vi } from "vitest";
import { ChatPiece } from "./chat-piece.js";
import type { EventBus } from "../core/bus.js";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Tests for ChatPiece's session-agnostic routing in handleSend().
 *
 * Contract:
 *   - ChatPiece is plugin-agnostic. It NEVER mirrors type:"user" itself.
 *   - The session OWNER (JarvisCore for main/grpc-*, or any plugin owning
 *     custom sessionIds) is responsible for emitting
 *     `prompt_dispatched` (timeline) when the prompt actually goes to the
 *     model and `pending_queue` (queue cards) while it waits.
 *   - ChatPiece only publishes `ai.request` on the bus and lets the owner
 *     decide what to broadcast.
 */

function makeBus(): { bus: EventBus; published: any[] } {
  const published: any[] = [];
  const bus = {
    publish: (msg: any) => { published.push(msg); },
    subscribe: () => () => {},
  } as unknown as EventBus;
  return { bus, published };
}

function makeReqRes(body: any): { req: IncomingMessage; res: ServerResponse; sent: any } {
  const sent: any = { headers: null, body: null };
  const req = {
    on: vi.fn((event: string, cb: any) => {
      if (event === "data") cb(Buffer.from(JSON.stringify(body)));
      if (event === "end") cb();
    }),
  } as any;
  const res = {
    writeHead: (code: number, headers: any) => { sent.statusCode = code; sent.headers = headers; },
    end: (b: any) => { sent.body = b; },
  } as any;
  return { req, res, sent };
}

describe("ChatPiece.handleSend — session-agnostic routing", () => {
  it("does NOT broadcast type:'user' for any session — owner emits prompt_dispatched", async () => {
    const { bus, published } = makeBus();
    const piece = new ChatPiece();
    (piece as any).bus = bus;

    const broadcastSpy = vi.spyOn(piece as any, "broadcast");

    const { req, res, sent } = makeReqRes({ sessionId: "main", prompt: "hello" });
    await piece.handleSend(req, res);

    const aiReq = published.find((m: any) => m.channel === "ai.request");
    expect(aiReq).toBeDefined();
    expect(aiReq.text).toBe("hello");
    expect(aiReq.target).toBe("main");

    const userBroadcasts = broadcastSpy.mock.calls.filter(
      ([_sid, evt]: any[]) => evt?.type === "user"
    );
    expect(userBroadcasts).toHaveLength(0);
    expect(sent.statusCode).toBe(200);
  });

  it("does NOT broadcast type:'user' for plugin-owned sessions either", async () => {
    // Same contract as core-owned sessions: the plugin owner (e.g. a
    // session-orchestrator) emits prompt_dispatched. ChatPiece stays neutral.
    const { bus, published } = makeBus();
    const piece = new ChatPiece();
    (piece as any).bus = bus;

    const broadcastSpy = vi.spyOn(piece as any, "broadcast");

    const { req, res, sent } = makeReqRes({ sessionId: "bg-jarvis-imp", prompt: "fix the bug" });
    await piece.handleSend(req, res);

    const aiReq = published.find((m: any) => m.channel === "ai.request");
    expect(aiReq.target).toBe("bg-jarvis-imp");
    expect(aiReq.text).toBe("fix the bug");

    const userBroadcasts = broadcastSpy.mock.calls.filter(
      ([_sid, evt]: any[]) => evt?.type === "user"
    );
    expect(userBroadcasts).toHaveLength(0);
    expect(sent.statusCode).toBe(200);
  });

  it("setOwnedSessionMatcher is a deprecated no-op (kept for backward compat)", async () => {
    const { bus } = makeBus();
    const piece = new ChatPiece();
    (piece as any).bus = bus;

    // Setting the matcher must not throw and must not change behavior.
    piece.setOwnedSessionMatcher((sid) => sid === "main");

    const broadcastSpy = vi.spyOn(piece as any, "broadcast");
    const { req, res } = makeReqRes({ sessionId: "bg-x", prompt: "hi" });
    await piece.handleSend(req, res);

    const userBroadcasts = broadcastSpy.mock.calls.filter(
      ([_sid, evt]: any[]) => evt?.type === "user"
    );
    expect(userBroadcasts).toHaveLength(0);
  });
});

/**
 * Tests for ChatPiece.handleSessionInfo — GET /chat/session-info.
 *
 * Contract (BDD: phantom-sessions.feature + chat.feature "Model Indicator"):
 *   - MUST use sessions.peek(), NEVER sessions.get(). get() materializes a
 *     ghost session (main's full system prompt, wrong role) for unknown ids,
 *     and the ModelPicker polls this endpoint every 5s for EVERY open panel.
 *   - Live sessions report peekModel() (next ?? sticky ?? base).
 *   - Not-yet-materialized sessions report the provider default (config.model)
 *     — what a brand-new session would use — never a null placeholder.
 */
describe("ChatPiece.handleSessionInfo — ghost-session guard", () => {
  function makeGetReqRes(url: string): { req: IncomingMessage; res: ServerResponse; sent: any } {
    const sent: any = { statusCode: null, headers: null, body: null };
    const req = { url } as any;
    const res = {
      writeHead: (code: number, headers: any) => { sent.statusCode = code; sent.headers = headers; },
      end: (b: any) => { sent.body = b; },
    } as any;
    return { req, res, sent };
  }

  it("never calls sessions.get() — peek() only, so no ghost is materialized", async () => {
    const piece = new ChatPiece();
    const peek = vi.fn(() => undefined);
    const get = vi.fn();
    (piece as any).sessions = { peek, get };

    const { req, res, sent } = makeGetReqRes("/chat/session-info?sessionId=nope-123");
    piece.handleSessionInfo(req, res);

    expect(peek).toHaveBeenCalledWith("nope-123");
    expect(get).not.toHaveBeenCalled();
    expect(sent.statusCode).toBe(200);
  });

  it("unknown session → 200 with provider default model and provider null", async () => {
    const { config } = await import("../config/index.js");
    const piece = new ChatPiece();
    (piece as any).sessions = { peek: () => undefined, get: vi.fn() };

    const { req, res, sent } = makeGetReqRes("/chat/session-info?sessionId=nope-123");
    piece.handleSessionInfo(req, res);

    const body = JSON.parse(sent.body);
    expect(sent.statusCode).toBe(200);
    expect(body.model).toBe(config.model); // provider default, not null/placeholder
    expect(body.provider).toBeNull();
  });

  it("live session → peekModel() wins (session-scoped truth, not global aggregate)", () => {
    const piece = new ChatPiece();
    const managed = { session: { peekModel: () => "claude-fable-5" } };
    (piece as any).sessions = { peek: () => managed, get: vi.fn() };

    const { req, res, sent } = makeGetReqRes("/chat/session-info?sessionId=main");
    piece.handleSessionInfo(req, res);

    const body = JSON.parse(sent.body);
    expect(body.model).toBe("claude-fable-5");
  });

  it("live session without peekModel falls back to stickyModelOverride", () => {
    const piece = new ChatPiece();
    const managed = { session: { stickyModelOverride: "claude-opus-4-8" } };
    (piece as any).sessions = { peek: () => managed, get: vi.fn() };

    const { req, res, sent } = makeGetReqRes("/chat/session-info?sessionId=bg-x");
    piece.handleSessionInfo(req, res);

    const body = JSON.parse(sent.body);
    expect(body.model).toBe("claude-opus-4-8");
  });

  it("missing sessionId query param → 400", () => {
    const piece = new ChatPiece();
    (piece as any).sessions = { peek: vi.fn(), get: vi.fn() };

    const { req, res, sent } = makeGetReqRes("/chat/session-info");
    piece.handleSessionInfo(req, res);

    expect(sent.statusCode).toBe(400);
  });
});
