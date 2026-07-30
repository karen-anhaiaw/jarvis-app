// src/capabilities/loader-spawn.test.ts
//
// HISTORY — this file previously asserted the opposite of what it asserts now.
//
// It used to test spawnOptions(platform), which returned shell:true on win32
// so that .cmd shims (npx, npm) could be found by spawn(). That turned out to
// be the source of a production bug on Windows: with shell:true, Node does not
// forward `args` as a vector — it concatenates them into a single command line
// for cmd.exe WITHOUT quoting arguments containing spaces, and cmd.exe then
// re-tokenizes on whitespace. Every capability argument shifted by one position.
//
// spawnOptions was therefore replaced by buildSpawnPlan, which never sets
// shell:true. The .cmd/.bat use case is preserved by invoking cmd.exe
// explicitly with a command line we quote ourselves. See loader.ts and
// loader-spawn-plan.test.ts for the behavioural contract.
//
// What remains here is the guard against regression: no code path may ever
// re-introduce shell:true, on any platform.

import { describe, it, expect } from "vitest";

const PLATFORMS = ["win32", "darwin", "linux", "freebsd"] as const;
const ALWAYS_RESOLVES = () => "C:\\Program Files\\Git\\bin\\bash.exe";

describe("spawn invariants — shell must never be enabled", () => {
  it("never returns shell:true, on any platform", async () => {
    const { buildSpawnPlan } = await import("./loader.js");
    for (const platform of PLATFORMS) {
      const plan = buildSpawnPlan("bash", ["script.sh", "arg with space"], platform, ALWAYS_RESOLVES);
      expect(plan.options.shell, `shell must be false on ${platform}`).toBe(false);
    }
  });

  it("carries a positive timeout on every platform", async () => {
    const { buildSpawnPlan } = await import("./loader.js");
    for (const platform of PLATFORMS) {
      const plan = buildSpawnPlan("bash", [], platform, ALWAYS_RESOLVES);
      expect(plan.options.timeout, `timeout must be set on ${platform}`).toBeGreaterThan(0);
    }
  });

  it("no longer exports spawnOptions — the shell:true helper is gone for good", async () => {
    const mod: Record<string, unknown> = await import("./loader.js");
    expect(mod.spawnOptions).toBeUndefined();
  });

  it("defaults to the running platform when none is given", async () => {
    const { buildSpawnPlan } = await import("./loader.js");
    // On Unix hosts this must pass the command through untouched. On a Windows
    // host it resolves via PATH; either way shell stays false.
    const plan = buildSpawnPlan("bash", ["x"], undefined, ALWAYS_RESOLVES);
    expect(plan.options.shell).toBe(false);
    expect(plan.args).toEqual(["x"]);
  });

  it("preserves arguments containing spaces as single arguments on unix", async () => {
    const { buildSpawnPlan } = await import("./loader.js");
    const args = ["capabilities/scripts/bash-exec.sh", "echo OK", "10"];
    const plan = buildSpawnPlan("bash", args, "linux");
    expect(plan.args).toEqual(args);
    expect(plan.args).toHaveLength(3);
  });
});
