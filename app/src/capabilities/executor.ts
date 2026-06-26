// src/capabilities/executor.ts
import type { EventBus } from "../core/bus.js";
import type { CapabilityRegistry } from "./registry.js";
import type { CapabilityRequestMessage, CapabilityResultMessage, HudUpdateMessage } from "../core/types.js";
import type { Piece } from "../core/piece.js";
import { log } from "../logger/index.js";

/**
 * Remove executor-injected context fields (`__sessionId`, `__toolUseId`,
 * `__traceId`) from a tool input. MUST be applied before forwarding the
 * input to anything outside the process boundary — MCP servers, spawned
 * scripts (`__json_input__` stdin), HTTP bodies — so internal correlation
 * ids never leak into external systems (F4.17, invariant 2 of
 * docs/features/observability-tracing.md). Shared by mcp/manager and
 * capabilities/loader; single source of truth for the strip list.
 */
export function stripExecutorContext(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const { __sessionId: _s, __toolUseId: _t, __traceId: _tr, ...rest } = input;
  return rest;
}

export class CapabilityExecutor implements Piece {
  readonly id = "capability-executor";
  readonly name = "Capability Executor";

  private bus!: EventBus;
  private registry: CapabilityRegistry;
  private totalCalls = 0;
  private totalErrors = 0;
  private totalTimeMs = 0;
  private callsPerTool = new Map<string, number>();

  constructor(registry: CapabilityRegistry) {
    this.registry = registry;
  }

  async start(bus: EventBus): Promise<void> {
    this.bus = bus;

    this.bus.subscribe<CapabilityRequestMessage>("capability.request", (msg) => this.handleRequest(msg));

    // Track ALL capability executions via registry listener
    this.registry.onExecution((toolName, isError, timeMs) => {
      this.callsPerTool.set(toolName, (this.callsPerTool.get(toolName) ?? 0) + 1);
      this.totalCalls++;
      if (isError) this.totalErrors++;
      this.totalTimeMs += timeMs;
      this.bus.publish({
        channel: "hud.update",
        source: this.id,
        action: "update",
        pieceId: this.id,
        data: this.getData(),
        status: "running",
      });
    });

    this.bus.publish({
      channel: "hud.update",
      source: this.id,
      action: "add",
      pieceId: this.id,
      piece: {
        pieceId: this.id,
        type: "panel",
        name: this.name,
        status: "running",
        data: this.getData(),
        position: { x: 1680, y: 10 },
        size: { width: 240, height: 100 },
      },
    });

    log.info("CapabilityExecutor: initialized (event-driven)");
  }

  async stop(): Promise<void> {
    this.bus.publish({
      channel: "hud.update",
      source: this.id,
      action: "remove",
      pieceId: this.id,
    });
    log.info("CapabilityExecutor: stopped");
  }

  private async handleRequest(msg: CapabilityRequestMessage): Promise<void> {
    const sessionId = msg.target!;
    const calls = msg.calls;
    const traceId = (msg as any).traceId;
    const t0 = Date.now();
    log.info({ sessionId, traceId, count: calls.length, names: calls.map(c => c.name) }, "CapabilityExecutor: executing");

    // Inject sessionId + toolUseId + traceId into inputs so capabilities know
    // the calling context. __toolUseId lets handlers register per-tool abort
    // controllers in the AbortRegistry (parallel tools must not collide —
    // registry.execute runs calls via Promise.all). __traceId (F4.17) lets
    // handler-side logs correlate with the originating turn; handlers MUST
    // strip all __ fields before forwarding input to external processes /
    // MCP servers — use stripExecutorContext().
    const enrichedCalls = calls.map(c => ({
      ...c,
      input: {
        ...c.input,
        __sessionId: sessionId,
        __toolUseId: c.id,
        ...(traceId ? { __traceId: traceId } : {}),
      },
    }));

    // Progress callback — publishes tool_progress on ai.stream so the chat
    // timeline can show live stdout while the tool is running.
    const onProgress = (toolId: string, toolName: string, chunk: string) => {
      this.bus.publish({
        channel: "ai.stream",
        source: "capability-executor",
        target: sessionId,
        event: "tool_progress",
        toolId,
        toolName,
        chunk,
        traceId,
      } as any);
    };

    let results: Awaited<ReturnType<typeof this.registry.execute>>;
    try {
      results = await this.registry.execute(enrichedCalls, onProgress);
    } catch (execErr: any) {
      // If registry.execute throws (e.g. MCP timeout, handler crash), publish
      // error results for every pending call so the session is never left
      // zombie in waiting_tools with no capability.result arriving.
      log.error({
        sessionId, traceId,
        err: execErr?.message ?? String(execErr),
        calls: enrichedCalls.map(c => c.name),
      }, "CapabilityExecutor: registry.execute threw — publishing error results");
      this.totalErrors += enrichedCalls.length;
      const errorResults = enrichedCalls.map(c => ({
        tool_use_id: c.id,
        content: `Tool execution failed: ${execErr?.message ?? String(execErr)}`,
        is_error: true,
      }));
      this.bus.publish({
        channel: "capability.result",
        source: "capability-executor",
        target: sessionId,
        results: errorResults,
        ...(traceId ? { traceId } : {}),
      } as any);
      return;
    }

    // Metrics tracked via registry.onExecution listener

    this.bus.publish({
      channel: "capability.result",
      source: "capability-executor",
      target: sessionId,
      results,
      // Propagate the turn's traceId on the result leg (F4.17) so the
      // request→execute→result chain shares one id end-to-end.
      ...(traceId ? { traceId } : {}),
    } as any);

    this.bus.publish({
      channel: "hud.update",
      source: this.id,
      action: "update",
      pieceId: this.id,
      data: this.getData(),
      status: "running",
    });

    log.info({ sessionId, ms: Date.now() - t0 }, "CapabilityExecutor: done");
  }

  getData(): Record<string, unknown> {
    return {
      totalCalls: this.totalCalls,
      totalErrors: this.totalErrors,
      avgTimeMs: this.totalCalls > 0 ? Math.round(this.totalTimeMs / this.totalCalls) : 0,
      tools: this.registry.names,
      callsPerTool: Object.fromEntries(this.callsPerTool),
    };
  }
}
