// src/capabilities/loader-abort-tree.test.ts
//
// Part 3 of the abort fix: aborting a tool must kill the ENTIRE process tree,
// not just the direct child. A `bash -c "sleep 300"` spawns a grandchild
// (`sleep`) in the same process group; killing only the bash left `sleep`
// running as an orphan. The fix spawns detached (new process group) and, on
// abort, signals the whole group via process.kill(-pid, ...).
//
// POSIX-only: process groups / negative-pid kill do not exist on Windows.
// The test is skipped there; the Windows path falls back to child.kill().

import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { readFileSync, unlinkSync } from "node:fs";

const isPosix = process.platform !== "win32";

// Probe: is a pid alive? kill(pid, 0) throws ESRCH if not.
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!isPosix)("abort kills the whole process tree (POSIX)", () => {
  it("detached spawn + negative-pid SIGTERM kills a grandchild sleep", async () => {
    // Parent bash spawns a child `sleep 300` and prints the child's PID.
    // With detached:true the parent leads a new process group; killing the
    // group (-pid) takes the grandchild with it.
    const child = spawn("bash", ["-c", "sleep 300 & echo $!; wait"], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });

    let out = "";
    child.stdout.on("data", (b: Buffer) => { out += b.toString(); });

    // Wait for the grandchild PID to be printed.
    await delay(300);
    const grandchildPid = parseInt(out.trim(), 10);
    expect(Number.isInteger(grandchildPid)).toBe(true);
    expect(isAlive(grandchildPid)).toBe(true);

    // THE BEHAVIOUR UNDER TEST: killTree() from loader.ts must kill the whole
    // group, not just the child.
    const { killTree } = await import("./loader.js");
    killTree(child, /* detached */ true);

    // Give the OS a moment to reap.
    await delay(300);

    expect(isAlive(grandchildPid)).toBe(false);
  }, 10_000);

  it("non-detached fallback kills at least the direct child", async () => {
    const { killTree } = await import("./loader.js");
    const child = spawn("bash", ["-c", "sleep 300"], { stdio: "ignore" });
    await delay(150);
    expect(isAlive(child.pid!)).toBe(true);

    // detached=false → fallback path uses child.kill("SIGTERM").
    killTree(child, /* detached */ false);
    await delay(300);

    expect(isAlive(child.pid!)).toBe(false);
  }, 10_000);

  it("killTree never throws when the process already exited", async () => {
    const { killTree } = await import("./loader.js");
    const child = spawn("bash", ["-c", "true"], { stdio: "ignore", detached: true });
    // Wait for natural exit.
    await new Promise<void>((res) => child.on("close", () => res()));
    // The pid is now dead — killTree must swallow ESRCH.
    expect(() => killTree(child, true)).not.toThrow();
  }, 10_000);

  // ── REAL topology regression (the gap that let the bug ship) ─────────────
  // The original unit test used `bash -c "sleep &"` directly, which does NOT
  // reproduce production: the bash tool runs `bash bash-exec.sh <cmd> <timeout>`
  // and bash-exec.sh internally runs `timeout N bash -c "<cmd>"`. `timeout`
  // (coreutils) runs its target in its OWN process group, so killing the
  // script's group leaves the timeout + grandchildren orphaned (reparented to
  // init). The fix is a TERM/INT trap in bash-exec.sh that targets the
  // timeout's group. This test runs the REAL script end to end.
  it("aborting the real bash-exec.sh kills the grandchild spawned under timeout", async () => {
    const pidFile = "/tmp/jarvis-test-gc-" + process.pid + ".pid";
    // The command spawns a long-lived grandchild and records its PID, then
    // itself sleeps — mirroring a user's `bash` tool call that started a
    // background process.
    const cmd = `sleep 600 & echo $! > ${pidFile}; sleep 120`;
    const child = spawn(
      "bash",
      ["capabilities/scripts/bash-exec.sh", cmd, "600"],
      { detached: true, stdio: "ignore" },
    );

    // Wait for the grandchild PID to be written.
    await delay(1500);
    let gcPid = 0;
    try { gcPid = parseInt(readFileSync(pidFile, "utf8").trim(), 10); } catch { /* ignore */ }
    expect(Number.isInteger(gcPid)).toBe(true);
    expect(isAlive(gcPid)).toBe(true);

    // Abort exactly as execWithProgress does: kill the child's process group.
    try { process.kill(-child.pid!, "SIGTERM"); } catch { /* already gone */ }
    await delay(400);
    try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ }
    await delay(500);

    const survived = isAlive(gcPid);
    // Cleanup regardless of outcome so a regression never leaks a real orphan.
    if (survived) { try { process.kill(gcPid, "SIGKILL"); } catch { /* ignore */ } }
    try { unlinkSync(pidFile); } catch { /* ignore */ }

    expect(survived).toBe(false);
  }, 15_000);
});
