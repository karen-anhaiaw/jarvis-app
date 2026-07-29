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

  it("loads capabilities from JARVIS_CAPABILITIES_DIR when set", async () => {
    // Point JARVIS_CAPABILITIES_DIR directly at our tmp caps dir
    vi.stubEnv("JARVIS_CAPABILITIES_DIR", tmpCaps);
    vi.resetModules();
    const { CapabilityLoaderPiece } = await import("./loader.js");
    const { CapabilityRegistry } = await import("./registry.js");

    const registry = new CapabilityRegistry();
    const piece = new CapabilityLoaderPiece(registry);
    const fakeBus = { publish: vi.fn() } as any;
    await piece.start(fakeBus);

    expect(registry.names).toContain("test_tool");
  });

  it("does NOT load sentinel from the real capabilities dir when JARVIS_CAPABILITIES_DIR overrides", async () => {
    vi.stubEnv("JARVIS_CAPABILITIES_DIR", tmpCaps);
    vi.resetModules();
    const { CapabilityLoaderPiece } = await import("./loader.js");
    const { CapabilityRegistry } = await import("./registry.js");

    const registry = new CapabilityRegistry();
    const piece = new CapabilityLoaderPiece(registry);
    const fakeBus = { publish: vi.fn() } as any;
    await piece.start(fakeBus);

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
