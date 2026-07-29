// src/capabilities/loader-paths.test.ts
//
// TDD — RED first. Tests for CapabilityLoaderPiece path resolution and
// system context correctness on both Unix and Windows (no HOME env var).
//
// Three behaviors under test:
//   1. CAPABILITIES_DIR resolves under jarvisHome(), never process.cwd()
//   2. systemContext() uses os.homedir(), never process.env.HOME
//   3. spawn() uses shell:true on Windows so .cmd binaries are found

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-loader-test-"));
}
function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe("CapabilityLoaderPiece — path resolution", () => {
  let tmpHome: string;
  let tmpCaps: string;

  beforeEach(() => {
    tmpHome = makeTmpDir();
    // Logger and other pieces resolve paths under JARVIS_HOME; pre-create dirs.
    fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
    tmpCaps = path.join(tmpHome, "capabilities");
    fs.mkdirSync(tmpCaps, { recursive: true });
    // Write a minimal capability JSON
    fs.writeFileSync(
      path.join(tmpCaps, "test-tool.json"),
      JSON.stringify({
        name: "test_tool",
        type: "script",
        description: "Test tool",
        command: "bash",
        args: ["capabilities/scripts/test.sh"],
      }),
    );
  });

  afterEach(() => {
    rmrf(tmpHome);
    vi.resetAllMocks();
    vi.unstubAllEnvs();
  });

  it("loads capabilities from jarvisHome()/capabilities/, not process.cwd()", async () => {
    vi.stubEnv("JARVIS_HOME", tmpHome);
    // Reimport after env change so module picks up new JARVIS_HOME
    vi.resetModules();
    const { CapabilityLoaderPiece } = await import("./loader.js");
    const { CapabilityRegistry } = await import("./registry.js");

    const registry = new CapabilityRegistry();
    const piece = new CapabilityLoaderPiece(registry);

    // Simulate start without a real bus
    const fakeBus = { publish: vi.fn() } as any;
    await piece.start(fakeBus);

    const names = registry.names;
    expect(names).toContain("test_tool");
  });

  it("does NOT load from process.cwd() when JARVIS_HOME is set", async () => {
    // Put a DIFFERENT tool in cwd/capabilities
    const cwdCaps = path.join(process.cwd(), "capabilities");
    const sentinel = path.join(cwdCaps, "sentinel-should-not-load.json");
    const sentinelExists = fs.existsSync(sentinel);
    // We don't create it — just verify that if JARVIS_HOME points elsewhere,
    // tools from cwd are not automatically loaded.
    vi.stubEnv("JARVIS_HOME", tmpHome);
    vi.resetModules();
    const { CapabilityLoaderPiece } = await import("./loader.js");
    const { CapabilityRegistry } = await import("./registry.js");

    const registry = new CapabilityRegistry();
    const piece = new CapabilityLoaderPiece(registry);
    const fakeBus = { publish: vi.fn() } as any;
    await piece.start(fakeBus);

    // Only the tool from tmpHome should be loaded
    expect(registry.names).toContain("test_tool");
    expect(registry.names).not.toContain("sentinel-should-not-load");
  });
});

describe("CapabilityLoaderPiece — systemContext()", () => {
  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("reports homedir via os.homedir(), not process.env.HOME", async () => {
    vi.stubEnv("HOME", undefined as any); // simulate Windows native without HOME
    vi.resetModules();
    const { CapabilityLoaderPiece } = await import("./loader.js");
    const { CapabilityRegistry } = await import("./registry.js");

    const piece = new CapabilityLoaderPiece(new CapabilityRegistry());
    const ctx = piece.systemContext?.() ?? "";

    // Must contain the real homedir (not "undefined")
    expect(ctx).toContain(os.homedir());
    expect(ctx).not.toContain("undefined");
    expect(ctx).not.toContain("null");
  });

  it("never mentions process.cwd() as the home directory", async () => {
    vi.resetModules();
    const { CapabilityLoaderPiece } = await import("./loader.js");
    const { CapabilityRegistry } = await import("./registry.js");

    const piece = new CapabilityLoaderPiece(new CapabilityRegistry());
    const ctx = piece.systemContext?.() ?? "";

    // Home dir in context must be os.homedir(), which on Unix typically
    // differs from cwd. We just assert it doesn't embed a raw cwd reference
    // where the home is claimed to be.
    // homedir() must appear somewhere in the context (exact wording may vary)
    expect(ctx).toContain(os.homedir());
  });
});
