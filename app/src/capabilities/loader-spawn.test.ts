// src/capabilities/loader-spawn.test.ts
//
// TDD — RED first. Tests that CapabilityLoaderPiece.execWithProgress
// passes shell:true on Windows and shell:false on Unix.
//
// ESM native modules cannot be vi.spied directly. We test via a
// platform-aware helper extracted from loader.ts: spawnOptions(platform).
// The helper is a pure function — testable without mocking spawn itself.

import { describe, it, expect } from "vitest";

// ─── SUT import (will fail until spawnOptions is exported) ──────────────────
// We expect loader.ts to export a testable helper:
//   export function spawnOptions(platform?: string): { shell: boolean; timeout: number }

describe("spawnOptions — shell flag by platform", () => {
  it("returns shell:true on win32", async () => {
    const { spawnOptions } = await import("./loader.js");
    const opts = spawnOptions("win32");
    expect(opts.shell).toBe(true);
  });

  it("returns shell:false on darwin", async () => {
    const { spawnOptions } = await import("./loader.js");
    const opts = spawnOptions("darwin");
    expect(opts.shell).toBe(false);
  });

  it("returns shell:false on linux", async () => {
    const { spawnOptions } = await import("./loader.js");
    const opts = spawnOptions("linux");
    expect(opts.shell).toBe(false);
  });

  it("defaults to current process.platform when called without args", async () => {
    const { spawnOptions } = await import("./loader.js");
    const opts = spawnOptions();
    const expected = process.platform === "win32";
    expect(opts.shell).toBe(expected);
  });

  it("always includes a timeout", async () => {
    const { spawnOptions } = await import("./loader.js");
    expect(spawnOptions("win32").timeout).toBeGreaterThan(0);
    expect(spawnOptions("darwin").timeout).toBeGreaterThan(0);
  });
});
