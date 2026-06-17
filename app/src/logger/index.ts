// src/logger/index.ts
//
// Logger wiring — file transport, rotation, console mirror. The buffer/proxy
// logic lives in ./buffer.ts (pure, unit-tested); this module owns only the
// import-time side effects (rotation, transport workers) and re-exports the
// buffer API so existing consumers keep importing from "logger/index.js".
import pino from "pino";
import { mkdirSync, existsSync, renameSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { jarvisPath } from "../core/paths.js";
import { wrapWithBuffer } from "./buffer.js";

export { getLogBuffer, onLogEntry, type LogEntry } from "./buffer.js";

// Always write logs to file
const LOG_DIR = jarvisPath("logs");
mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = process.env.JARVIS_LOG_FILE ?? join(LOG_DIR, "jarvis.log");

// Rotate on startup: rename current log to timestamped file, keep last 3
const MAX_LOG_FILES = 3;
if (existsSync(LOG_FILE)) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const rotated = join(LOG_DIR, `jarvis-${ts}.log`);
  try {
    renameSync(LOG_FILE, rotated);
  } catch { /* ignore — file may be locked briefly */ }

  // Prune old rotated logs, keep only MAX_LOG_FILES most recent
  try {
    const rotatedFiles = readdirSync(LOG_DIR)
      .filter(f => f.startsWith("jarvis-") && f.endsWith(".log"))
      .sort()
      .reverse();
    for (const f of rotatedFiles.slice(MAX_LOG_FILES)) {
      unlinkSync(join(LOG_DIR, f));
    }
  } catch { /* best effort */ }
}

const consoleLevel = process.env.LOG_LEVEL ?? "silent";

const destination = pino.transport({
  targets: [
    // File: raw NDJSON (one JSON object per line) — F4 item 19. The old
    // pino-pretty file produced multi-line ctx blocks that were unparseable
    // by tooling; NDJSON is jq/grep-friendly and machine-readable. Console
    // (below) remains the human-pretty surface.
    { target: "pino/file", options: { destination: LOG_FILE }, level: "debug" },
    // Console only if LOG_LEVEL is set
    ...(consoleLevel !== "silent"
      ? [{ target: "pino-pretty", options: { colorize: true }, level: consoleLevel }]
      : []),
  ],
});

// The actual pino logger — always writes to file, optionally to console
const pinoLogger = pino({ level: "debug" }, destination);

// Buffered proxy: every level call (including from child loggers) also lands
// in the in-memory ring buffer that feeds the HUD log panel and /logs SSE.
export const log = wrapWithBuffer(pinoLogger);
