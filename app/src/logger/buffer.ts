// src/logger/buffer.ts
//
// PURE buffered-logger layer — the in-memory ring buffer behind the HUD log
// panel and the `/logs` SSE endpoint, plus the proxy factory that taps pino
// calls into it.
//
// WHY a separate module (F4): logger/index.ts has import-time side effects
// (file rotation, pino transport worker). Keeping the buffer + proxy logic
// here, side-effect-free, makes it unit-testable with a stub pino and keeps
// tests from rotating real log files.
//
// Design decisions (mission jarvis-fix, F4 / Pillar C):
//   - LogEntry.ctx carries the STRUCTURED object of the call (item 16). The
//     old proxy extracted only `msg` and dropped the object, leaving the HUD
//     blind to sessionId/traceId/err fields.
//   - child() is wrapped RECURSIVELY (item 16b). The old proxy returned raw
//     pino children, so plugin loggers (ctx.log = log.child({plugin})) and
//     any per-turn child NEVER reached the ring buffer — invisible in the
//     HUD/SSE while present in the file. Bindings accumulate down the chain
//     and are merged into ctx (call-site fields win on collision, matching
//     pino's own semantics).

export type LogEntry = {
  seq: number;
  timestamp: string;
  level: string;
  msg: string;
  /** Structured context: child bindings merged with the call's object
   *  argument (call-site wins). Absent for string-only calls. */
  ctx?: Record<string, unknown>;
};

const MAX_BUFFER = 500;
const logBuffer: LogEntry[] = [];
const listeners: Set<(entry: LogEntry) => void> = new Set();
let nextSeq = 0;

function pushEntry(entry: LogEntry) {
  logBuffer.push(entry);
  if (logBuffer.length > MAX_BUFFER) logBuffer.shift();
  for (const fn of listeners) fn(entry);
}

export function getLogBuffer(): LogEntry[] {
  return [...logBuffer];
}

/** Test helper — resets buffer and seq. Not used by production code. */
export function clearLogBuffer(): void {
  logBuffer.length = 0;
  nextSeq = 0;
}

export function onLogEntry(fn: (entry: LogEntry) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;

/**
 * Wrap a pino(-like) logger so every level call ALSO pushes a structured
 * entry to the ring buffer, and every child() returns a wrapped child with
 * accumulated bindings. The underlying logger still receives the original
 * call untouched (file/console output unchanged).
 */
export function wrapWithBuffer<T extends object>(
  logger: T,
  bindings: Record<string, unknown> = {},
): T {
  return new Proxy(logger, {
    get(target, prop, receiver) {
      const val = Reflect.get(target, prop, receiver);

      if (typeof prop === "string" && (LEVELS as readonly string[]).includes(prop)) {
        return (...args: unknown[]) => {
          // pino calling conventions: (msg), (obj, msg), (obj), (msg, ...interp)
          const objArg = (args[0] !== null && typeof args[0] === "object")
            ? args[0] as Record<string, unknown>
            : undefined;
          const msg = typeof args[0] === "string" ? args[0]
            : typeof args[1] === "string" ? args[1]
            : String(args[0]);

          const merged = { ...bindings, ...objArg };
          pushEntry({
            seq: nextSeq++,
            timestamp: new Date().toISOString(),
            level: prop,
            msg,
            ...(Object.keys(merged).length > 0 ? { ctx: merged } : {}),
          });

          return (val as (...a: unknown[]) => unknown).apply(target, args);
        };
      }

      if (prop === "child" && typeof val === "function") {
        return (childBindings: Record<string, unknown>, ...rest: unknown[]) => {
          const rawChild = (val as (...a: unknown[]) => object).call(target, childBindings, ...rest);
          return wrapWithBuffer(rawChild, { ...bindings, ...childBindings });
        };
      }

      return val;
    },
  });
}
