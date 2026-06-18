// app/src/core/session-dispatcher.ts
//
// WHY: JarvisCore and actor-runner both subscribe to ai.request and call
// sendAndStream independently — causing duplicate API calls on the same
// session. SessionDispatcher is the single ai.request consumer for ALL
// sessions (main, actor-*, grpc-*, etc.). JarvisCore and actor-runner become
// lifecycle orchestrators only.
import type { EventBus } from "./bus.js";
import type { SessionManager } from "./session-manager.js";
import type { CapabilityCall } from "../ai/types.js";
import { log } from "../logger/index.js";

/** Per-session queue entry */
interface QueuedMessage {
  text: string;
  source: string;
  replyTo?: string;
  images?: any[];
  traceId: string;
  systems?: string[];
}

/** Per-session dispatcher runtime state */
interface SessionDispatch {
  queue: QueuedMessage[];
  running: boolean;
  currentTraceId?: string;
  pendingToolCalls?: CapabilityCall[];
}

export class SessionDispatcher {
  private state = new Map<string, SessionDispatch>();
  private bus!: EventBus;
  readonly sessions: SessionManager;

  constructor(sessions: SessionManager) {
    this.sessions = sessions;
  }

  start(_bus: EventBus): void {
    this.bus = _bus;
    log.info("SessionDispatcher: started (skeleton — subscribers not yet wired)");
  }

  /** Get or create per-session dispatch state */
  getDispatch(sessionId: string): SessionDispatch {
    let d = this.state.get(sessionId);
    if (!d) {
      d = { queue: [], running: false };
      this.state.set(sessionId, d);
    }
    return d;
  }

  /** Called when a session is closed — evict dispatch state to avoid leaks */
  evict(sessionId: string): void {
    this.state.delete(sessionId);
    log.debug({ sessionId }, "SessionDispatcher: evicted");
  }

  get size(): number {
    return this.state.size;
  }
}
