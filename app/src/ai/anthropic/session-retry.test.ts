// src/ai/anthropic/session-retry.test.ts
//
// Unit coverage for the API-call retry policy (feature: api-retry).
// Tests the pure decision helpers (classifyRetryError, parseRetryAfter) and the
// abortable wait — the parts that don't require a live Anthropic stream mock.
// The full streamFromAPI loop (yield of the wait notice, budget exhaustion,
// abort-during-wait) is exercised by the BDD scenarios in
// docs/features/bdd/api-retry.feature via the functional test.
import { describe, it, expect } from "vitest";
import { AnthropicSession } from "./session.js";

const noTools = () => [];

function mk() {
  return new AnthropicSession({
    model: "claude-opus-4-8",
    systemPrompt: "x",
    getTools: noTools,
    label: "t",
    highEffort: false,
  });
}

const RETRY = { rateLimitWaitMs: 15000, backoffBaseMs: 2000, respectRetryAfter: true };

describe("classifyRetryError — retryable vs non-retryable", () => {
  it("429 without retry-after → fixed rateLimitWaitMs, kind=rate_limit", () => {
    const d = (mk() as any).classifyRetryError({ status: 429 }, 1, RETRY);
    expect(d).toEqual({ waitMs: 15000, kind: "rate_limit" });
  });

  it("429 with retry-after seconds → honored", () => {
    const err = { status: 429, headers: { "retry-after": "8" } };
    const d = (mk() as any).classifyRetryError(err, 1, RETRY);
    expect(d).toEqual({ waitMs: 8000, kind: "rate_limit" });
  });

  it("429 with retry-after ignored when respectRetryAfter=false", () => {
    const err = { status: 429, headers: { "retry-after": "8" } };
    const d = (mk() as any).classifyRetryError(err, 1, { ...RETRY, respectRetryAfter: false });
    expect(d).toEqual({ waitMs: 15000, kind: "rate_limit" });
  });

  it("529 overloaded → exponential backoff (2s, 4s, 8s...)", () => {
    const c = mk() as any;
    expect(c.classifyRetryError({ status: 529 }, 1, RETRY).waitMs).toBe(2000);
    expect(c.classifyRetryError({ status: 529 }, 2, RETRY).waitMs).toBe(4000);
    expect(c.classifyRetryError({ status: 529 }, 3, RETRY).waitMs).toBe(8000);
    expect(c.classifyRetryError({ status: 529 }, 1, RETRY).kind).toBe("backoff");
  });

  it("500/502/503 → backoff", () => {
    const c = mk() as any;
    for (const status of [500, 502, 503]) {
      expect(c.classifyRetryError({ status }, 1, RETRY)).toEqual({ waitMs: 2000, kind: "backoff" });
    }
  });

  it("408/409 transient → backoff", () => {
    const c = mk() as any;
    expect(c.classifyRetryError({ status: 408 }, 1, RETRY).kind).toBe("backoff");
    expect(c.classifyRetryError({ status: 409 }, 1, RETRY).kind).toBe("backoff");
  });

  it("network errors → backoff", () => {
    const c = mk() as any;
    for (const msg of ["ECONNRESET", "socket hang up", "other side closed", "ETIMEDOUT", "fetch failed"]) {
      expect(c.classifyRetryError({ message: msg }, 1, RETRY).kind).toBe("backoff");
    }
  });

  it.each([400, 401, 403, 404, 422])("deterministic %i → null (no retry)", (status) => {
    expect((mk() as any).classifyRetryError({ status }, 1, RETRY)).toBeNull();
  });

  it("unknown/unclassified error → null (conservative)", () => {
    expect((mk() as any).classifyRetryError({ message: "weird" }, 1, RETRY)).toBeNull();
  });
});

describe("parseRetryAfter", () => {
  it("plain-object header, seconds", () => {
    expect((mk() as any).parseRetryAfter({ headers: { "retry-after": "3" } })).toBe(3000);
  });

  it("Headers-like get() accessor", () => {
    const headers = { get: (k: string) => (k === "retry-after" ? "5" : null) };
    expect((mk() as any).parseRetryAfter({ headers })).toBe(5000);
  });

  it("HTTP-date format ~3s in the future", () => {
    const future = new Date(Date.now() + 3000).toUTCString();
    const ms = (mk() as any).parseRetryAfter({ headers: { "retry-after": future } });
    expect(ms).toBeGreaterThan(2000);
    expect(ms).toBeLessThanOrEqual(3000);
  });

  it("absent header → undefined", () => {
    expect((mk() as any).parseRetryAfter({})).toBeUndefined();
    expect((mk() as any).parseRetryAfter({ headers: {} })).toBeUndefined();
  });

  it("unparseable value → undefined", () => {
    expect((mk() as any).parseRetryAfter({ headers: { "retry-after": "not-a-date" } })).toBeUndefined();
  });
});

describe("abortableWait", () => {
  it("resolves true after the delay when not aborted", async () => {
    const s = mk() as any;
    s.abortController = new AbortController();
    const t0 = Date.now();
    const ok = await s.abortableWait(30);
    expect(ok).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(20);
  });

  it("resolves false immediately if already aborted", async () => {
    const s = mk() as any;
    s.abortController = new AbortController();
    s.abortController.abort();
    const ok = await s.abortableWait(1000);
    expect(ok).toBe(false);
  });

  it("resolves false when aborted mid-wait", async () => {
    const s = mk() as any;
    s.abortController = new AbortController();
    const p = s.abortableWait(1000);
    setTimeout(() => s.abortController.abort(), 20);
    const ok = await p;
    expect(ok).toBe(false);
  });
});
