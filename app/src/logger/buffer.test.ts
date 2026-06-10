// src/logger/buffer.test.ts
//
// BDD: docs/features/bdd/observability-tracing.feature (F4, items 16 + 16b)
//
// Tests the PURE buffered-logger layer (logger/buffer.ts) — no pino transport,
// no file rotation, no side effects. A stub pino-like object stands in for the
// real logger so we can assert exactly what reaches the ring buffer.
import { describe, it, expect, beforeEach } from "vitest";
import { wrapWithBuffer, getLogBuffer, clearLogBuffer, onLogEntry } from "./buffer.js";

/** Minimal pino-like stub: level methods + child() returning another stub. */
function stubPino(): any {
  const calls: any[] = [];
  const make = (): any => ({
    calls,
    trace: (...a: any[]) => calls.push(["trace", a]),
    debug: (...a: any[]) => calls.push(["debug", a]),
    info: (...a: any[]) => calls.push(["info", a]),
    warn: (...a: any[]) => calls.push(["warn", a]),
    error: (...a: any[]) => calls.push(["error", a]),
    fatal: (...a: any[]) => calls.push(["fatal", a]),
    child: (_bindings: Record<string, unknown>) => make(),
  });
  return make();
}

beforeEach(() => clearLogBuffer());

describe("LogEntry.ctx — structured ring buffer (item 16)", () => {
  it("captures the object argument as ctx", () => {
    const log = wrapWithBuffer(stubPino());
    log.info({ sessionId: "main", traceId: "abc12345" }, "hello");
    const entry = getLogBuffer().at(-1)!;
    expect(entry.msg).toBe("hello");
    expect(entry.ctx).toEqual({ sessionId: "main", traceId: "abc12345" });
  });

  it("string-only call produces entry without ctx", () => {
    const log = wrapWithBuffer(stubPino());
    log.info("plain message");
    const entry = getLogBuffer().at(-1)!;
    expect(entry.msg).toBe("plain message");
    expect(entry.ctx).toBeUndefined();
  });

  it("still forwards the call to the underlying pino", () => {
    const stub = stubPino();
    const log = wrapWithBuffer(stub);
    log.warn({ a: 1 }, "fwd");
    expect(stub.calls).toContainEqual(["warn", [{ a: 1 }, "fwd"]]);
  });
});

describe("proxied child() — ring buffer integrity (item 16b)", () => {
  it("child logger calls land in the ring buffer with merged bindings", () => {
    const log = wrapWithBuffer(stubPino());
    const child = log.child({ plugin: "voice" });
    child.info({ event: "x" }, "from child");
    const entry = getLogBuffer().at(-1)!;
    expect(entry.msg).toBe("from child");
    expect(entry.ctx).toEqual({ plugin: "voice", event: "x" });
  });

  it("grandchild merges bindings from the whole chain", () => {
    const log = wrapWithBuffer(stubPino());
    const grandchild = log.child({ a: 1 }).child({ b: 2 });
    grandchild.info("deep");
    const entry = getLogBuffer().at(-1)!;
    expect(entry.msg).toBe("deep");
    expect(entry.ctx).toEqual({ a: 1, b: 2 });
  });

  it("call-site ctx wins over child bindings on key collision", () => {
    const log = wrapWithBuffer(stubPino());
    const child = log.child({ sessionId: "from-binding" });
    child.info({ sessionId: "from-call" }, "collision");
    expect(getLogBuffer().at(-1)!.ctx).toEqual({ sessionId: "from-call" });
  });

  it("listeners fire for child entries too", () => {
    const log = wrapWithBuffer(stubPino());
    const seen: string[] = [];
    const unsub = onLogEntry((e) => seen.push(e.msg));
    log.child({ x: 1 }).info("notify");
    unsub();
    expect(seen).toContain("notify");
  });
});
