// src/capabilities/loader-spawn-plan.test.ts
//
// TDD — RED first.
//
// BUG BEING FIXED
//   spawnOptions() returns shell:true on win32. With shell:true, Node does NOT
//   pass `args` as a vector — it concatenates them into a single command line
//   and hands it to cmd.exe WITHOUT quoting arguments that contain spaces.
//   cmd.exe then re-tokenizes on whitespace.
//
//   Observed on the Windows box (192.168.15.7), bash tool with command "echo OK":
//     $1 = "echo"   ← command split at the space
//     $2 = "OK"     ← became the timeout
//     $3 = "10"     ← the timeout became the cwd
//   → bash-exec.sh reported: "Working directory not found: 10"
//
//   Every capability that receives an argument containing a space is affected,
//   which is all 250+ of them in practice.
//
// ROOT FIX (chosen over per-arg quoting)
//   Stop routing through cmd.exe for ordinary executables. Resolve the command
//   to an absolute path and spawn it with shell:false, which makes Node quote
//   the argv vector correctly.
//
//   shell:true originally existed so .cmd/.bat shims (npx, npm) could be found.
//   That capability must be preserved: .cmd/.bat genuinely require cmd.exe, so
//   for those we invoke cmd.exe explicitly and build the command line ourselves
//   with proper quoting plus windowsVerbatimArguments, so Node leaves it alone.
//
// SUT (does not exist yet — these tests MUST fail first):
//   export interface SpawnPlan {
//     file: string;
//     args: string[];
//     options: { shell: boolean; timeout: number; windowsVerbatimArguments?: boolean };
//   }
//   export function buildSpawnPlan(
//     command: string,
//     args: string[],
//     platform?: string,
//     resolver?: (command: string, platform: string) => string | null,
//   ): SpawnPlan

import { describe, it, expect } from "vitest";

const ARGS_WITH_SPACE = ["capabilities/scripts/bash-exec.sh", "echo OK", "10"];

describe("buildSpawnPlan — never lets cmd.exe re-tokenize arguments", () => {
  it("on unix: passes the command through untouched with shell:false", async () => {
    const { buildSpawnPlan } = await import("./loader.js");
    const plan = buildSpawnPlan("bash", ARGS_WITH_SPACE, "darwin");

    expect(plan.file).toBe("bash");
    expect(plan.args).toEqual(ARGS_WITH_SPACE);
    expect(plan.options.shell).toBe(false);
  });

  it("on win32 with an .exe: spawns the resolved binary directly, shell:false", async () => {
    const { buildSpawnPlan } = await import("./loader.js");
    const exe = "C:\\Program Files\\Git\\bin\\bash.exe";
    const plan = buildSpawnPlan("bash", ARGS_WITH_SPACE, "win32", () => exe);

    // shell:false is the whole point — it makes Node quote argv properly.
    expect(plan.options.shell).toBe(false);
    expect(plan.file).toBe(exe);
    // The argument containing a space must survive as ONE argument.
    expect(plan.args).toEqual(ARGS_WITH_SPACE);
    expect(plan.args[1]).toBe("echo OK");
  });

  it("on win32 with a .cmd shim: routes through cmd.exe with a quoted line", async () => {
    const { buildSpawnPlan } = await import("./loader.js");
    const shim = "C:\\Program Files\\nodejs\\npx.cmd";
    const plan = buildSpawnPlan("npx", ["tsx", "some file.ts"], "win32", () => shim);

    expect(plan.file.toLowerCase()).toContain("cmd.exe");
    expect(plan.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(plan.options.shell).toBe(false);
    // We build the line, so Node must not touch it.
    expect(plan.options.windowsVerbatimArguments).toBe(true);
    // The space-bearing argument must be quoted inside the built line.
    const line = plan.args[3];
    expect(line).toContain('"some file.ts"');
    expect(line).toContain(`"${shim}"`);
  });

  it("on win32: escapes embedded double quotes instead of breaking the line", async () => {
    const { buildSpawnPlan } = await import("./loader.js");
    const shim = "C:\\tools\\run.cmd";
    const plan = buildSpawnPlan("run", ['say "hi"'], "win32", () => shim);

    const line = plan.args[3];
    expect(line).not.toContain('say "hi"');
    expect(line).toContain('\\"hi\\"');
  });

  it("on win32: throws a diagnosable error when the command cannot be resolved", async () => {
    const { buildSpawnPlan } = await import("./loader.js");
    expect(() => buildSpawnPlan("bash", ARGS_WITH_SPACE, "win32", () => null)).toThrowError(/bash/i);
  });

  it("carries a positive timeout on every platform", async () => {
    const { buildSpawnPlan } = await import("./loader.js");
    expect(buildSpawnPlan("bash", [], "darwin").options.timeout).toBeGreaterThan(0);
    expect(buildSpawnPlan("bash", [], "win32", () => "C:\\g\\bash.exe").options.timeout).toBeGreaterThan(0);
  });
});
