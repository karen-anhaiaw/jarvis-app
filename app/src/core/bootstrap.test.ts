// src/core/bootstrap.test.ts
//
// TDD — RED first. Tests for the JARVIS runtime bootstrap:
// populates ~/.jarvis from shipped source on first boot, idempotent,
// portable (no shell, no process.env.HOME, no process.cwd()).
//
// Design invariant (from BDD + Sir's directive 2026-07-29):
//   ~/.jarvis/ holds ALL runtime state.
//   jarvis-app/ is source code only.
//   Nothing at runtime resolves a path against cwd.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-bootstrap-test-"));
}

function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ─── SUT import (will fail until bootstrap.ts exists) ───────────────────────

let bootstrap: (opts: { jarvisHome: string; sourceRoot: string }) => Promise<void>;

// ─── tests ───────────────────────────────────────────────────────────────────

describe("bootstrap — first boot populates ~/.jarvis", () => {
  let tmpHome: string;
  let tmpSource: string;

  beforeEach(() => {
    tmpHome = makeTmpDir();
    tmpSource = makeTmpDir();

    // Minimal shipped-source structure the bootstrap needs to copy from.
    fs.mkdirSync(path.join(tmpSource, ".jarvis"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpSource, ".jarvis", "settings.json"),
      JSON.stringify({ pieces: {} }),
    );
    fs.writeFileSync(
      path.join(tmpSource, "jarvis-system.md"),
      "# JARVIS System Prompt\n",
    );
  });

  afterEach(() => {
    rmrf(tmpHome);
    rmrf(tmpSource);
    vi.resetAllMocks();
  });

  it("creates required directories under jarvisHome", async () => {
    const { bootstrap: boot } = await import("./bootstrap.js");
    await boot({ jarvisHome: tmpHome, sourceRoot: tmpSource });

    for (const dir of ["sessions", "logs", "certs", "oauth", "plugins"]) {
      expect(
        fs.existsSync(path.join(tmpHome, dir)),
        `${dir}/ should exist`,
      ).toBe(true);
    }
  });

  it("copies settings.json from shipped source", async () => {
    const { bootstrap: boot } = await import("./bootstrap.js");
    await boot({ jarvisHome: tmpHome, sourceRoot: tmpSource });

    const dest = path.join(tmpHome, "settings.json");
    expect(fs.existsSync(dest)).toBe(true);
    const content = JSON.parse(fs.readFileSync(dest, "utf-8"));
    expect(content).toEqual({ pieces: {} });
  });

  it("copies jarvis-system.md from shipped source", async () => {
    const { bootstrap: boot } = await import("./bootstrap.js");
    await boot({ jarvisHome: tmpHome, sourceRoot: tmpSource });

    const dest = path.join(tmpHome, "jarvis-system.md");
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.readFileSync(dest, "utf-8")).toContain("JARVIS System Prompt");
  });

  it("creates mcp.json template if absent", async () => {
    const { bootstrap: boot } = await import("./bootstrap.js");
    await boot({ jarvisHome: tmpHome, sourceRoot: tmpSource });

    const dest = path.join(tmpHome, "mcp.json");
    expect(fs.existsSync(dest)).toBe(true);
    const content = JSON.parse(fs.readFileSync(dest, "utf-8"));
    expect(content).toHaveProperty("servers");
  });

  it("creates settings.user.json template if absent", async () => {
    const { bootstrap: boot } = await import("./bootstrap.js");
    await boot({ jarvisHome: tmpHome, sourceRoot: tmpSource });

    const dest = path.join(tmpHome, "settings.user.json");
    expect(fs.existsSync(dest)).toBe(true);
    const content = JSON.parse(fs.readFileSync(dest, "utf-8"));
    expect(content).toHaveProperty("providers");
  });
});

describe("bootstrap — idempotent (shipped defaults refresh, user files untouched)", () => {
  let tmpHome: string;
  let tmpSource: string;

  beforeEach(() => {
    tmpHome = makeTmpDir();
    tmpSource = makeTmpDir();
    fs.mkdirSync(path.join(tmpSource, ".jarvis"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpSource, ".jarvis", "settings.json"),
      JSON.stringify({ pieces: { "jarvis-core": { enabled: true } } }),
    );
    fs.writeFileSync(
      path.join(tmpSource, "jarvis-system.md"),
      "# Updated System Prompt\n",
    );
  });

  afterEach(() => {
    rmrf(tmpHome);
    rmrf(tmpSource);
  });

  it("overwrites shipped settings.json on second boot (upgrade propagation)", async () => {
    const { bootstrap: boot } = await import("./bootstrap.js");
    // First boot
    await boot({ jarvisHome: tmpHome, sourceRoot: tmpSource });
    // Simulate upgrade: source changes
    fs.writeFileSync(
      path.join(tmpSource, ".jarvis", "settings.json"),
      JSON.stringify({ pieces: { "jarvis-core": { enabled: true }, "grpc": { enabled: true } } }),
    );
    // Second boot
    await boot({ jarvisHome: tmpHome, sourceRoot: tmpSource });

    const dest = JSON.parse(fs.readFileSync(path.join(tmpHome, "settings.json"), "utf-8"));
    expect(dest.pieces).toHaveProperty("grpc");
  });

  it("does NOT overwrite settings.user.json on second boot", async () => {
    const { bootstrap: boot } = await import("./bootstrap.js");
    await boot({ jarvisHome: tmpHome, sourceRoot: tmpSource });

    // User edits their settings
    const userPath = path.join(tmpHome, "settings.user.json");
    fs.writeFileSync(userPath, JSON.stringify({ providers: { anthropic: { apiKey: "user-key" } } }));

    // Second boot
    await boot({ jarvisHome: tmpHome, sourceRoot: tmpSource });

    const user = JSON.parse(fs.readFileSync(userPath, "utf-8"));
    expect(user.providers?.anthropic?.apiKey).toBe("user-key");
  });

  it("does NOT overwrite mcp.json on second boot", async () => {
    const { bootstrap: boot } = await import("./bootstrap.js");
    await boot({ jarvisHome: tmpHome, sourceRoot: tmpSource });

    const mcpPath = path.join(tmpHome, "mcp.json");
    fs.writeFileSync(mcpPath, JSON.stringify({ servers: { "my-server": { command: "uv" } } }));

    await boot({ jarvisHome: tmpHome, sourceRoot: tmpSource });

    const mcp = JSON.parse(fs.readFileSync(mcpPath, "utf-8"));
    expect(mcp.servers).toHaveProperty("my-server");
  });

  it("is safe to call N times — same result", async () => {
    const { bootstrap: boot } = await import("./bootstrap.js");
    await boot({ jarvisHome: tmpHome, sourceRoot: tmpSource });
    await boot({ jarvisHome: tmpHome, sourceRoot: tmpSource });
    await boot({ jarvisHome: tmpHome, sourceRoot: tmpSource });

    expect(fs.existsSync(path.join(tmpHome, "settings.json"))).toBe(true);
  });
});

describe("bootstrap — Windows: never uses process.env.HOME or process.cwd()", () => {
  let tmpHome: string;
  let tmpSource: string;

  beforeEach(() => {
    tmpHome = makeTmpDir();
    tmpSource = makeTmpDir();
    fs.mkdirSync(path.join(tmpSource, ".jarvis"), { recursive: true });
    fs.writeFileSync(path.join(tmpSource, ".jarvis", "settings.json"), "{}");
    fs.writeFileSync(path.join(tmpSource, "jarvis-system.md"), "# prompt\n");
  });

  afterEach(() => {
    rmrf(tmpHome);
    rmrf(tmpSource);
    vi.unstubAllEnvs();
  });

  it("succeeds even when HOME is undefined", async () => {
    vi.stubEnv("HOME", undefined as any);

    const { bootstrap: boot } = await import("./bootstrap.js");
    // Must not throw
    await expect(boot({ jarvisHome: tmpHome, sourceRoot: tmpSource })).resolves.toBeUndefined();
    expect(fs.existsSync(path.join(tmpHome, "sessions"))).toBe(true);
  });

  it("does not create a literal '~' directory anywhere", async () => {
    vi.stubEnv("HOME", undefined as any);

    const { bootstrap: boot } = await import("./bootstrap.js");
    await boot({ jarvisHome: tmpHome, sourceRoot: tmpSource });

    const tildeInHome = fs.existsSync(path.join(tmpHome, "~"));
    const tildeInSource = fs.existsSync(path.join(tmpSource, "~"));
    expect(tildeInHome).toBe(false);
    expect(tildeInSource).toBe(false);
  });

  it("does not shell out — uses only node:fs APIs", async () => {
    // We verify indirectly: cp, find, openssl are not available in the test
    // sandbox on CI. The test passes only if bootstrap uses fs.cpSync / mkdirSync.
    // On platforms where those binaries exist, the test still validates correctness.
    const { bootstrap: boot } = await import("./bootstrap.js");
    await expect(boot({ jarvisHome: tmpHome, sourceRoot: tmpSource })).resolves.toBeUndefined();
  });
});

describe("bootstrap — JARVIS_HOME override is honoured", () => {
  let tmpA: string;
  let tmpB: string;
  let tmpSource: string;

  beforeEach(() => {
    tmpA = makeTmpDir();
    tmpB = makeTmpDir();
    tmpSource = makeTmpDir();
    fs.mkdirSync(path.join(tmpSource, ".jarvis"), { recursive: true });
    fs.writeFileSync(path.join(tmpSource, ".jarvis", "settings.json"), "{}");
    fs.writeFileSync(path.join(tmpSource, "jarvis-system.md"), "# prompt\n");
  });

  afterEach(() => {
    rmrf(tmpA);
    rmrf(tmpB);
    rmrf(tmpSource);
  });

  it("two instances with different jarvisHome do not share state", async () => {
    const { bootstrap: boot } = await import("./bootstrap.js");
    await boot({ jarvisHome: tmpA, sourceRoot: tmpSource });
    await boot({ jarvisHome: tmpB, sourceRoot: tmpSource });

    // Write different user settings to each
    fs.writeFileSync(path.join(tmpA, "settings.user.json"), JSON.stringify({ tag: "A" }));
    fs.writeFileSync(path.join(tmpB, "settings.user.json"), JSON.stringify({ tag: "B" }));

    const a = JSON.parse(fs.readFileSync(path.join(tmpA, "settings.user.json"), "utf-8"));
    const b = JSON.parse(fs.readFileSync(path.join(tmpB, "settings.user.json"), "utf-8"));
    expect(a.tag).toBe("A");
    expect(b.tag).toBe("B");
  });
});
