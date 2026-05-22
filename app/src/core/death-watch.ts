// src/core/death-watch.ts
//
// Global crash & shutdown handler. Wraps the entire JARVIS process with:
//   - uncaughtException     → log + dump + exit
//   - unhandledRejection    → log + dump (does NOT exit by default; configurable)
//   - SIGTERM / SIGHUP      → graceful shutdown hook
//   - warning event         → log only (helps spotting deprecations + leaks)
//   - memory pressure watch → periodic heap check, log when crossing thresholds
//
// Design rules:
//   1. NEVER rely on async logging (pino transport is async — it can lose the
//      last entry when the process is dying). Crash handlers write SYNCHRONOUSLY
//      with appendFileSync + process.stderr.write.
//   2. Always dump a structured snapshot to:
//        ~/.jarvis/logs/crash-<ISO>.log   (per-event, full)
//        ~/.jarvis/logs/last-crash.log    (overwritten — easy to grep on boot)
//      and a one-liner to ~/.jarvis/logs/jarvis.log via the async logger too,
//      so both pipes get the message.
//   3. Stay paranoid: every step is wrapped in try/catch — a crash inside the
//      crash handler must NEVER swallow the original error.

import { appendFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { jarvisPath } from "./paths.js";
import { log } from "../logger/index.js";

const LOG_DIR = jarvisPath("logs");
try { mkdirSync(LOG_DIR, { recursive: true }); } catch { /* best effort */ }

const LAST_CRASH = join(LOG_DIR, "last-crash.log");

/** Capture snapshot of any context the caller wants dumped on crash. */
export type SnapshotProvider = () => Record<string, unknown>;

/** Optional graceful-shutdown callback. Death-watch will call it on SIGTERM/SIGHUP. */
export type GracefulShutdown = (reason: string) => Promise<void> | void;

export interface DeathWatchOptions {
  /** Called when a fatal handler fires; gives the caller a chance to attach
   *  live state (active sessions, last token usage, current model, etc.). */
  snapshot?: SnapshotProvider;
  /** Called on SIGTERM/SIGHUP. Same callback used by main.ts for SIGINT. */
  onGracefulShutdown?: GracefulShutdown;
  /** Exit on unhandledRejection? Defaults to false — Node's own default since v15
   *  is "warn + (future-)throw", and aborting on every stray promise rejection
   *  kills productive sessions. Logged regardless. */
  exitOnUnhandledRejection?: boolean;
  /** Memory pressure watcher interval in ms. Default 30_000. Set to 0 to disable. */
  memoryWatchIntervalMs?: number;
  /** Warn threshold in MB for RSS. Default 1500 (1.5 GiB). */
  memoryWarnMb?: number;
  /** Critical threshold in MB for RSS. Default 3500 (3.5 GiB).
   *  Triggers a heap snapshot suggestion + bus event (if provided). */
  memoryCriticalMb?: number;
  /** Optional callback when memory crosses the critical threshold —
   *  used to publish a system.event so the HUD can surface it. */
  onMemoryCritical?: (info: { rssMb: number; heapUsedMb: number; heapTotalMb: number }) => void;
}

/** Format an Error (or anything) for a crash log entry. */
function fmtError(err: unknown): string {
  if (err instanceof Error) {
    return [
      `name:    ${err.name}`,
      `message: ${err.message}`,
      `stack:`,
      err.stack ?? "(no stack)",
    ].join("\n");
  }
  try { return `non-Error throw: ${JSON.stringify(err, null, 2)}`; } catch { return `non-Error throw: ${String(err)}`; }
}

/** Synchronous, paranoid crash writer. Writes to crash-<iso>.log + last-crash.log
 *  + stderr in one shot. Used by every fatal handler — never throws. */
function writeCrashDump(label: string, err: unknown, snapshot?: SnapshotProvider): string {
  const ts = new Date().toISOString();
  const file = join(LOG_DIR, `crash-${ts.replace(/[:.]/g, "-")}.log`);
  const mem = process.memoryUsage();
  const lines: string[] = [];

  lines.push(`==================================================`);
  lines.push(`JARVIS death-watch: ${label}`);
  lines.push(`timestamp: ${ts}`);
  lines.push(`pid:       ${process.pid}`);
  lines.push(`uptime:    ${process.uptime().toFixed(1)}s`);
  lines.push(`node:      ${process.version}`);
  lines.push(`platform:  ${process.platform} ${process.arch}`);
  lines.push(`==================================================`);
  lines.push(``);
  lines.push(`--- error ---`);
  lines.push(fmtError(err));
  lines.push(``);
  lines.push(`--- memory (bytes) ---`);
  lines.push(`rss:        ${mem.rss}        (${(mem.rss / 1024 / 1024).toFixed(1)} MB)`);
  lines.push(`heapTotal:  ${mem.heapTotal}  (${(mem.heapTotal / 1024 / 1024).toFixed(1)} MB)`);
  lines.push(`heapUsed:   ${mem.heapUsed}   (${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB)`);
  lines.push(`external:   ${mem.external}   (${(mem.external / 1024 / 1024).toFixed(1)} MB)`);
  lines.push(`arrayBuf:   ${mem.arrayBuffers} (${(mem.arrayBuffers / 1024 / 1024).toFixed(1)} MB)`);
  lines.push(``);

  // Snapshot is best-effort — never let it break the crash dump.
  if (snapshot) {
    lines.push(`--- snapshot ---`);
    try {
      const snap = snapshot();
      lines.push(JSON.stringify(snap, null, 2));
    } catch (snapErr) {
      lines.push(`snapshot failed: ${String((snapErr as Error)?.message ?? snapErr)}`);
    }
    lines.push(``);
  }

  const body = lines.join("\n") + "\n";

  // Synchronous writes — these MUST land even if the loop is dying.
  try { appendFileSync(file, body); } catch { /* best effort */ }
  try { writeFileSync(LAST_CRASH, body); } catch { /* best effort */ }
  try { process.stderr.write(`\n[JARVIS death-watch] ${label} — full dump: ${file}\n`); } catch { /* best effort */ }

  // Also fire the async logger — may or may not flush, but worth trying.
  try { log.fatal({ event: "death-watch", label, file, err: fmtError(err) }, `[death-watch] ${label}`); } catch { /* best effort */ }

  return file;
}

let installed = false;

// Live options — mutable via re-call. The signal handlers, uncaughtException,
// etc. close over THIS object (not over the destructured locals), so calling
// installDeathWatch a second time with richer opts updates behaviour on the
// fly. Used by main.ts: first call early (no refs), second call after
// SessionManager/PieceManager/etc exist (rich snapshot + graceful-shutdown).
const liveOpts: Required<Pick<DeathWatchOptions, "exitOnUnhandledRejection" | "memoryWarnMb" | "memoryCriticalMb">> & Pick<DeathWatchOptions, "snapshot" | "onGracefulShutdown" | "onMemoryCritical"> = {
  exitOnUnhandledRejection: false,
  memoryWarnMb: 1500,
  memoryCriticalMb: 3500,
};

/** Install global handlers. Re-callable to enrich opts (snapshot, graceful-shutdown,
 *  memory thresholds) — the signal handlers close over a mutable `liveOpts` so a
 *  later call updates behaviour without re-attaching handlers. */
export function installDeathWatch(opts: DeathWatchOptions = {}): void {
  // Always merge — even on re-call — so late wiring of snapshot/shutdown works.
  if (opts.snapshot !== undefined) liveOpts.snapshot = opts.snapshot;
  if (opts.onGracefulShutdown !== undefined) liveOpts.onGracefulShutdown = opts.onGracefulShutdown;
  if (opts.onMemoryCritical !== undefined) liveOpts.onMemoryCritical = opts.onMemoryCritical;
  if (opts.exitOnUnhandledRejection !== undefined) liveOpts.exitOnUnhandledRejection = opts.exitOnUnhandledRejection;
  if (opts.memoryWarnMb !== undefined) liveOpts.memoryWarnMb = opts.memoryWarnMb;
  if (opts.memoryCriticalMb !== undefined) liveOpts.memoryCriticalMb = opts.memoryCriticalMb;

  if (installed) {
    try { log.info({ event: "death-watch", reinstalled: true }, "[death-watch] options updated"); } catch { /* best effort */ }
    return;
  }
  installed = true;

  const memoryWatchIntervalMs = opts.memoryWatchIntervalMs ?? 30_000;

  // ─── uncaughtException ──────────────────────────────────────────────
  // Synchronous failure no one caught. The process is in an undefined state;
  // dump and exit hard (exit code 1).
  process.on("uncaughtException", (err, origin) => {
    try {
      writeCrashDump(`uncaughtException (origin=${origin})`, err, liveOpts.snapshot);
    } finally {
      // Force exit — the loop is poisoned, don't try to drain it.
      process.exit(1);
    }
  });

  // ─── unhandledRejection ─────────────────────────────────────────────
  // Some async chain rejected without a .catch. By default, log + continue —
  // these are usually recoverable (one stray actor crash shouldn't kill JARVIS).
  // Set exitOnUnhandledRejection:true to be strict.
  process.on("unhandledRejection", (reason, promise) => {
    try {
      writeCrashDump(
        "unhandledRejection",
        reason instanceof Error ? reason : new Error(`unhandledRejection: ${String(reason)}`),
        () => ({
          ...(liveOpts.snapshot?.() ?? {}),
          promise: String(promise),
        }),
      );
    } catch { /* best effort */ }
    if (liveOpts.exitOnUnhandledRejection) {
      try { process.exit(1); } catch { /* unreachable */ }
    }
  });

  // ─── warning ────────────────────────────────────────────────────────
  // Node emits these for deprecations, MaxListenersExceeded, etc. Worth
  // capturing — MaxListeners warnings often precede memory issues.
  process.on("warning", (warning) => {
    try {
      log.warn({
        event: "process-warning",
        name: warning.name,
        message: warning.message,
        stack: warning.stack,
      }, `[process.warning] ${warning.name}: ${warning.message}`);
    } catch { /* best effort */ }
  });

  // ─── SIGTERM / SIGHUP ───────────────────────────────────────────────
  // Different from SIGINT (which main.ts already handles). SIGTERM is the
  // polite kill (kill <pid> without -9). SIGHUP is sent when the controlling
  // terminal closes. Try to drain gracefully, then exit.
  for (const sig of ["SIGTERM", "SIGHUP"] as const) {
    process.on(sig, async () => {
      try {
        log.info({ signal: sig }, `[death-watch] received ${sig}, draining`);
        process.stderr.write(`\n[JARVIS death-watch] received ${sig}, draining...\n`);
        if (liveOpts.onGracefulShutdown) await liveOpts.onGracefulShutdown(sig);
      } catch (err) {
        writeCrashDump(`error during ${sig} shutdown`, err, liveOpts.snapshot);
      } finally {
        process.exit(0);
      }
    });
  }

  // ─── beforeExit ─────────────────────────────────────────────────────
  // Fires when the loop has nothing to do AND process.exit() wasn't called.
  // If we ever get here it usually means a piece forgot to keep itself alive
  // (intervals/listeners gone) — worth logging.
  process.on("beforeExit", (code) => {
    try { log.warn({ code, event: "beforeExit" }, "[death-watch] event loop empty, process about to exit"); } catch { /* best effort */ }
  });

  // ─── exit ───────────────────────────────────────────────────────────
  // Final synchronous hook — last chance to write. We can't await here.
  process.on("exit", (code) => {
    try {
      const ts = new Date().toISOString();
      appendFileSync(
        join(LOG_DIR, "exit.log"),
        `[${ts}] pid=${process.pid} exitCode=${code} uptime=${process.uptime().toFixed(1)}s\n`,
      );
    } catch { /* best effort */ }
  });

  // ─── memory pressure watcher ────────────────────────────────────────
  // Periodically sample memoryUsage(). Log at WARN once when crossing the
  // warn threshold, log at ERROR + fire callback when crossing critical.
  // Resets when memory drops back under warn (so it re-arms for next spike).
  if (memoryWatchIntervalMs > 0) {
    let lastBucket: "ok" | "warn" | "critical" = "ok";
    const watcher = setInterval(() => {
      try {
        const mem = process.memoryUsage();
        const rssMb = mem.rss / 1024 / 1024;
        const heapUsedMb = mem.heapUsed / 1024 / 1024;
        const heapTotalMb = mem.heapTotal / 1024 / 1024;

        const bucket: "ok" | "warn" | "critical" =
          rssMb >= liveOpts.memoryCriticalMb ? "critical" :
          rssMb >= liveOpts.memoryWarnMb     ? "warn"     :
                                                "ok";

        if (bucket !== lastBucket) {
          const payload = {
            event: "memory-pressure",
            level: bucket,
            rssMb: Math.round(rssMb),
            heapUsedMb: Math.round(heapUsedMb),
            heapTotalMb: Math.round(heapTotalMb),
            warnMb: liveOpts.memoryWarnMb,
            criticalMb: liveOpts.memoryCriticalMb,
          };

          if (bucket === "critical") {
            log.error(payload, `[death-watch] memory CRITICAL: RSS ${Math.round(rssMb)} MB ≥ ${liveOpts.memoryCriticalMb} MB`);
            try { liveOpts.onMemoryCritical?.({ rssMb, heapUsedMb, heapTotalMb }); } catch { /* best effort */ }
            // Also dump a crash-style snapshot so we have it on disk before any kill.
            writeCrashDump("memory-critical (process still alive)", new Error(`RSS ${Math.round(rssMb)} MB crossed critical threshold ${liveOpts.memoryCriticalMb} MB`), liveOpts.snapshot);
          } else if (bucket === "warn") {
            log.warn(payload, `[death-watch] memory WARN: RSS ${Math.round(rssMb)} MB ≥ ${liveOpts.memoryWarnMb} MB`);
          } else {
            log.info(payload, `[death-watch] memory recovered to OK: RSS ${Math.round(rssMb)} MB`);
          }

          lastBucket = bucket;
        }
      } catch { /* best effort */ }
    }, memoryWatchIntervalMs);
    // Don't keep the loop alive just for this watcher.
    if (typeof watcher.unref === "function") watcher.unref();
  }

  try { log.info({ event: "death-watch", warnMb: liveOpts.memoryWarnMb, criticalMb: liveOpts.memoryCriticalMb }, "[death-watch] installed"); } catch { /* best effort */ }
}
