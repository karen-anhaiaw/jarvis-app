// src/core/piece-manager.ts
//
// PieceManager owns the lifecycle of all pieces AND their core graph node registration.
//
// Responsibility boundary:
//   - PieceManager registers/unregisters every piece as a node in graphRegistry (core nodes).
//   - PieceManager updates node status on enable/disable transitions.
//   - Pieces do NOT register/unregister themselves in graphRegistry.
//   - Pieces MAY enrich their node with children (via graphRegistry.setChildren)
//     or meta (via graphRegistry.update) — this is their domain-specific data.
//   - hud-core-node reads graphRegistry.getTree() and pushes it to the HUD.
//
import type { EventBus } from "./bus.js";
import type { Piece } from "./piece.js";
import type { HudUpdateMessage } from "./types.js";
import type { CapabilityRegistry } from "../capabilities/registry.js";
import { load, save, getPieceSettings, setPieceSettings, isProtected, type Settings } from "./settings.js";
import { graphRegistry } from "./graph-registry.js";
import { log } from "../logger/index.js";

export class PieceManager {
  readonly pieces: Map<string, Piece>;
  private running = new Set<string>();
  private bus: EventBus;
  private registry: CapabilityRegistry;
  private settings: Settings;
  private ephemeralPieces = new Set<string>();
  /** Pieces that failed start() — flushed to main session after jarvisCore.ready(). */
  private startupFailures: Array<{ name: string; id: string; err: string }> = [];

  constructor(pieces: Piece[], bus: EventBus, registry: CapabilityRegistry) {
    this.pieces = new Map(pieces.map(p => [p.id, p]));
    this.bus = bus;
    this.registry = registry;
    this.settings = load();
    this.registerTools();

    // Track ephemeral panels — when a piece registers as ephemeral via hud.update,
    // we skip persisting its layout/visibility to settings.
    bus.subscribe<import("./types.js").HudUpdateMessage>("hud.update", (msg) => {
      if (msg.action === "add" && msg.piece?.ephemeral) {
        this.ephemeralPieces.add(msg.piece.pieceId);
      } else if (msg.action === "remove") {
        this.ephemeralPieces.delete(msg.pieceId);
      }
    });
  }

  private isEphemeral(pieceId: string): boolean {
    return this.ephemeralPieces.has(pieceId);
  }

  async startAll(): Promise<void> {
    for (const piece of this.pieces.values()) {
      const ps = getPieceSettings(this.settings, piece.id);
      if (!ps.enabled) {
        log.info({ pieceId: piece.id }, "PieceManager: skipped (disabled in settings)");
        this.registerGraphNode(piece.id, piece.name, "disabled");
        continue;
      }
      // Register in graph BEFORE start() so pieces can enrich with children/meta during start()
      this.registerGraphNode(piece.id, piece.name, "running");
      try {
        await piece.start(this.bus);
      } catch (err) {
        log.error({ pieceId: piece.id, err: String(err) }, "PieceManager: piece.start() failed — piece isolated, JARVIS continues");
        graphRegistry.update(piece.id, { status: "error" });
        // Collect for post-startup notification (see notifyStartupFailures())
        this.startupFailures.push({ name: piece.name, id: piece.id, err: String(err) });
        continue;
      }
      this.running.add(piece.id);

      // Apply visibility from settings
      if (!ps.visible) {
        this.setVisible(piece.id, false);
      }
    }
    log.info({ running: [...this.running], total: this.pieces.size }, "PieceManager: started");
  }

  /** Call this after jarvisCore.ready() to flush piece startup failures to the main session. */
  notifyStartupFailures(): void {
    if (this.startupFailures.length === 0) return;
    for (const { name, id, err } of this.startupFailures) {
      const isDockerIssue = err.includes("docker") || err.includes("Docker") || err.includes("preflight");
      const text = isDockerIssue
        ? `[SYSTEM] **${name}** não conseguiu iniciar — Docker não está disponível ou o container não existe.\n\n${err}\n\nInicie o Docker e rode \`jarvis_reset\` para tentar novamente.`
        : `[SYSTEM] Piece **${name}** (${id}) failed to start: ${err}\n\nThe piece has been isolated. JARVIS continues normally without it.`;
      this.bus.publish({ channel: "ai.request", source: "system", target: "main", text } as any);
    }
    this.startupFailures = [];
  }

  async stopAll(): Promise<void> {
    const reversed = [...this.running].reverse();
    for (const id of reversed) {
      const piece = this.pieces.get(id);
      if (piece) await piece.stop();
    }
    this.running.clear();
    log.info("PieceManager: all stopped");
  }

  async enable(pieceId: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.pieces.has(pieceId)) return { ok: false, error: `Unknown piece: ${pieceId}` };
    if (this.running.has(pieceId)) return { ok: false, error: `${pieceId} is already running` };

    const piece = this.pieces.get(pieceId)!;
    try {
      await piece.start(this.bus);
    } catch (err) {
      log.error({ pieceId, err: String(err) }, "PieceManager: piece.start() failed during enable");
      graphRegistry.update(pieceId, { status: "error" });
      return { ok: false, error: String(err) };
    }
    this.running.add(pieceId);

    // Persist enabled + visible (re-enabling a piece should make it visible again)
    this.settings = setPieceSettings(this.settings, pieceId, { enabled: true, visible: true });
    save(this.settings);
    graphRegistry.update(pieceId, { status: "running" });

    log.info({ pieceId }, "PieceManager: enabled");
    return { ok: true };
  }

  async disable(pieceId: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.pieces.has(pieceId)) return { ok: false, error: `Unknown piece: ${pieceId}` };
    if (isProtected(pieceId)) return { ok: false, error: `${pieceId} is protected and cannot be disabled` };
    if (!this.running.has(pieceId)) return { ok: false, error: `${pieceId} is not running` };

    const piece = this.pieces.get(pieceId)!;
    await piece.stop();
    this.running.delete(pieceId);

    this.settings = setPieceSettings(this.settings, pieceId, { enabled: false });
    save(this.settings);
    graphRegistry.update(pieceId, { status: "disabled" });

    log.info({ pieceId }, "PieceManager: disabled");
    return { ok: true };
  }

  async registerDynamic(piece: Piece, source: string): Promise<{ ok: boolean; error?: string }> {
    if (this.pieces.has(piece.id)) {
      return { ok: false, error: `Piece ${piece.id} already registered` };
    }

    this.pieces.set(piece.id, piece);

    // If PieceManager already started, start this piece immediately
    if (this.running.size > 0) {
      // Register in graph BEFORE start() so pieces can enrich with children/meta during start()
      this.registerGraphNode(piece.id, piece.name, "running");
      await piece.start(this.bus);
      this.running.add(piece.id);
    }

    // Ensure settings entry has enabled/visible — reload from disk to avoid overwriting other changes
    this.settings = load();
    const existing = this.settings.pieces[piece.id];
    // Set defaults if piece has no settings or is missing enabled/visible (e.g. only has config.layout)
    if (!existing || existing.enabled === undefined || existing.visible === undefined) {
      this.settings = setPieceSettings(this.settings, piece.id, {
        enabled: existing?.enabled ?? true,
        visible: existing?.visible ?? true,
      });
      save(this.settings);
    }

    // Apply saved visibility — re-read after potential save above
    const finalSettings = getPieceSettings(this.settings, piece.id);
    if (!finalSettings.visible) {
      this.setVisible(piece.id, false);
    }

    log.info({ pieceId: piece.id, source }, "PieceManager: registered dynamic piece");
    return { ok: true };
  }

  async unregisterDynamic(pieceId: string): Promise<{ ok: boolean; error?: string }> {
    const piece = this.pieces.get(pieceId);
    if (!piece) return { ok: false, error: `Piece ${pieceId} not found` };

    if (this.running.has(pieceId)) {
      await piece.stop();
      this.running.delete(pieceId);
    }

    this.pieces.delete(pieceId);
    graphRegistry.unregister(pieceId);
    // Don't delete settings — preserves layout for re-enable

    log.info({ pieceId }, "PieceManager: unregistered dynamic piece");
    return { ok: true };
  }

  show(pieceId: string): { ok: boolean; error?: string } {
    this.setVisible(pieceId, true);
    if (!this.isEphemeral(pieceId)) {
      this.settings = setPieceSettings(this.settings, pieceId, { visible: true });
      save(this.settings);
    }
    return { ok: true };
  }

  hide(pieceId: string): { ok: boolean; error?: string } {
    this.setVisible(pieceId, false);
    if (!this.isEphemeral(pieceId)) {
      this.settings = setPieceSettings(this.settings, pieceId, { visible: false });
      save(this.settings);
    }
    return { ok: true };
  }

  setLayout(pieceId: string, x: number, y: number, width: number, height: number): { ok: boolean; error?: string } {
    // Push to HUD live (always — even ephemeral panels move on screen)
    this.bus.publish({
      channel: "hud.update",
      source: "piece-manager",
      action: "update",
      pieceId,
      data: {},
      layout: { x, y, width, height },
    });

    // Skip persistence for ephemeral panels
    if (this.isEphemeral(pieceId)) {
      log.info({ pieceId, x, y, width, height }, "PieceManager: layout updated (ephemeral, not persisted)");
      return { ok: true };
    }

    // Persist to settings
    this.settings = load();
    if (!this.settings.pieces[pieceId]) {
      this.settings.pieces[pieceId] = { enabled: true, visible: true };
    }
    this.settings.pieces[pieceId].config = {
      ...this.settings.pieces[pieceId].config,
      layout: { x, y, width, height },
    };
    save(this.settings);

    log.info({ pieceId, x, y, width, height }, "PieceManager: layout updated");
    return { ok: true };
  }

  /** Register a piece as a node in the core graph (unconditional — for disabled pieces). */
  private registerGraphNode(pieceId: string, label: string, status: string): void {
    if (pieceId === "jarvis-core") return; // root node is always present
    graphRegistry.register({ id: pieceId, label, status });
  }

  private setVisible(pieceId: string, visible: boolean): void {
    this.bus.publish({
      channel: "hud.update",
      source: "piece-manager",
      action: "update",
      pieceId,
      data: {},
      visible,
    });
    log.debug({ pieceId, visible }, "PieceManager: visibility changed");
  }

  private registerTools(): void {
    this.registry.register({
      name: "piece_list",
      description: "List all JARVIS pieces with their enabled/running/visible status.",
      input_schema: { type: "object", properties: {} },
      handler: async () => {
        return [...this.pieces.values()].map(p => ({
          id: p.id,
          name: p.name,
          enabled: getPieceSettings(this.settings, p.id).enabled,
          running: this.running.has(p.id),
          visible: getPieceSettings(this.settings, p.id).visible,
          protected: isProtected(p.id),
        }));
      },
    });

    this.registry.register({
      name: "piece_enable",
      description: "Enable and start a JARVIS piece. Use piece_list to see available pieces.",
      input_schema: {
        type: "object",
        properties: { piece_id: { type: "string", description: "The piece ID to enable" } },
        required: ["piece_id"],
      },
      handler: async (input) => this.enable(String(input.piece_id)),
    });

    this.registry.register({
      name: "piece_disable",
      description: "Disable and stop a JARVIS piece. Protected pieces cannot be disabled.",
      input_schema: {
        type: "object",
        properties: { piece_id: { type: "string", description: "The piece ID to disable" } },
        required: ["piece_id"],
      },
      handler: async (input) => this.disable(String(input.piece_id)),
    });

    this.registry.register({
      name: "hud_show",
      description: "Show a HUD panel that was previously hidden.",
      input_schema: {
        type: "object",
        properties: { piece_id: { type: "string", description: "The piece/panel ID to show" } },
        required: ["piece_id"],
      },
      handler: async (input) => this.show(String(input.piece_id)),
    });

    this.registry.register({
      name: "hud_hide",
      description: "Hide a HUD panel without disabling the piece.",
      input_schema: {
        type: "object",
        properties: { piece_id: { type: "string", description: "The piece/panel ID to hide" } },
        required: ["piece_id"],
      },
      handler: async (input) => this.hide(String(input.piece_id)),
    });

    this.registry.register({
      name: "hud_layout",
      description: "Set position and size of a HUD panel. Persists to settings so it survives restarts.",
      input_schema: {
        type: "object",
        properties: {
          piece_id: { type: "string", description: "The piece/panel ID to reposition" },
          x: { type: "number", description: "X position in pixels" },
          y: { type: "number", description: "Y position in pixels" },
          width: { type: "number", description: "Width in pixels" },
          height: { type: "number", description: "Height in pixels" },
        },
        required: ["piece_id", "x", "y", "width", "height"],
      },
      handler: async (input) => this.setLayout(
        String(input.piece_id),
        Number(input.x), Number(input.y),
        Number(input.width), Number(input.height),
      ),
    });
  }
}
