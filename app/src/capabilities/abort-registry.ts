// src/capabilities/abort-registry.ts
// AbortRegistry — per-tool abort controllers, keyed (sessionId, toolUseId).
//
// WHY THIS EXISTS (decision record):
//   registry.execute() runs tool calls in PARALLEL (Promise.all — see
//   capabilities/registry.ts). The previous design kept ONE AbortController
//   per sessionId, duplicated in two places (capabilities/loader.ts and
//   mcp/manager.ts), each with its own ai.stream subscription. With 2+ tools
//   in the same turn the second register overwrote the first — ESC aborted
//   only the LAST tool and earlier ones kept running as orphan processes
//   (e.g. bash side effects landing AFTER the user aborted).
//
//   This module replaces both copies:
//   - Controllers are keyed by (sessionId, toolUseId) so parallel tools
//     never collide.
//   - abortSession(sessionId) kills EVERY in-flight tool of that session.
//   - wire(bus) is called ONCE (main.ts); consumers only register/release.
//
// USAGE (tool handler pattern):
//   const signal = abortRegistry.register(sessionId, toolUseId);
//   try { ...pass signal to execFile/fetch/MCP call... }
//   finally { abortRegistry.release(sessionId, toolUseId); }
import type { EventBus } from "../core/bus.js";
import { log } from "../logger/index.js";

export class AbortRegistry {
  /** sessionId → (toolUseId → controller). Nested map keeps session-level
   *  abort O(tools-in-session) and avoids string-concat composite keys. */
  private controllers = new Map<string, Map<string, AbortController>>();
  private wired = false;
  /** Fallback counter for calls without a toolUseId — guarantees uniqueness. */
  private anonSeq = 0;

  /**
   * Create and track an AbortController for one tool execution.
   *
   * @param sessionId - Owning session ("main", "actor-alice", ...)
   * @param toolUseId - Tool use id from the provider (CapabilityCall.id).
   *                    When absent (defensive), a unique synthetic key is used
   *                    so two anonymous registrations never collide.
   * @returns The AbortSignal to pass into execFile/fetch/MCP calls.
   */
  register(sessionId: string, toolUseId: string | undefined): AbortSignal {
    const key = toolUseId ?? `anon-${this.anonSeq++}`;
    let session = this.controllers.get(sessionId);
    if (!session) {
      session = new Map();
      this.controllers.set(sessionId, session);
    }
    const ctrl = new AbortController();
    session.set(key, ctrl);
    return ctrl.signal;
  }

  /**
   * Stop tracking one tool execution (does NOT abort).
   * Call from the handler's `finally` — after completion or error.
   * Accepts undefined toolUseId for symmetry with register(); in that case
   * the synthetic key is unknown to the caller, so release is a no-op and
   * the entry is cleaned up by the next abortSession() or stays inert
   * (controllers are GC-light; an inert controller holds no resources).
   */
  release(sessionId: string, toolUseId: string | undefined): void {
    if (!toolUseId) return;
    const session = this.controllers.get(sessionId);
    if (!session) return;
    session.delete(toolUseId);
    if (session.size === 0) this.controllers.delete(sessionId);
  }

  /**
   * Abort EVERY in-flight tool of a session and clear its entries.
   * @returns Number of controllers aborted (0 if none — safe no-op).
   */
  abortSession(sessionId: string): number {
    const session = this.controllers.get(sessionId);
    if (!session || session.size === 0) return 0;
    let count = 0;
    for (const [key, ctrl] of session) {
      try {
        ctrl.abort();
        count++;
      } catch (err) {
        log.warn({ sessionId, key, err }, "AbortRegistry: controller.abort threw");
      }
    }
    this.controllers.delete(sessionId);
    log.info({ sessionId, aborted: count }, "AbortRegistry: session tools aborted");
    return count;
  }

  /** Number of tracked in-flight tools (for a session, or total). */
  activeCount(sessionId?: string): number {
    if (sessionId) return this.controllers.get(sessionId)?.size ?? 0;
    let total = 0;
    for (const [, s] of this.controllers) total += s.size;
    return total;
  }

  /**
   * Subscribe to ai.stream "aborted" events → abortSession(target).
   * Called ONCE from main.ts. Idempotent — repeated calls are no-ops so a
   * careless double-wire can't double-subscribe.
   */
  wire(bus: EventBus): void {
    if (this.wired) return;
    this.wired = true;
    bus.subscribe("ai.stream", (msg: any) => {
      if (msg.event === "aborted" && msg.target) {
        this.abortSession(msg.target);
      }
    });
    log.info("AbortRegistry: wired to bus (ai.stream aborted)");
  }
}

/** Module-level singleton — same pattern as graphRegistry. Pieces import
 *  this instance; main.ts wires it to the bus during boot. */
export const abortRegistry = new AbortRegistry();
