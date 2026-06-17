// src/core/hud-core-node.ts
// HUD Core Node piece — pushes graphRegistry tree snapshots to the HUD.
//
// Previously used a setInterval of 500ms to poll for changes (causing constant re-renders
// and high CPU in the Electron renderer even when nothing changed).
// Now subscribes to graphRegistry.onChange() and publishes hud.update ONLY when the tree
// actually mutates (register/unregister/update/setChildren). Zero publishes at rest.
//
// This piece is a pure reader — it never registers/unregisters graph nodes.
// PieceManager owns core node registration; pieces enrich their nodes with children/meta.

import type { EventBus } from "./bus.js";
import type { Piece } from "./piece.js";
import { graphRegistry } from "./graph-registry.js";
import { log } from "../logger/index.js";

export class HudCoreNodePiece implements Piece {
  readonly id = "hud-core-node";
  readonly name = "Core Node";

  private bus!: EventBus;
  private unsubscribe: (() => void) | null = null;

  async start(bus: EventBus): Promise<void> {
    this.bus = bus;

    // Register HUD panel and hydrate with the initial tree snapshot
    this.bus.publish({
      channel: "hud.update",
      source: this.id,
      action: "add",
      pieceId: this.id,
      piece: {
        pieceId: this.id,
        type: "overlay",
        name: this.name,
        status: "running",
        data: { tree: graphRegistry.getTree() },
        position: { x: 0, y: 0 },
        size: { width: 0, height: 0 },
        visible: false,  // not rendered as a panel — consumed by HudRenderer directly
      },
    });

    // Subscribe to registry mutations — publish only when something actually changes
    this.unsubscribe = graphRegistry.onChange(() => {
      this.bus.publish({
        channel: "hud.update",
        source: this.id,
        action: "update",
        pieceId: this.id,
        data: { tree: graphRegistry.getTree() },
      });
    });

    log.info("HudCoreNodePiece: started (event-driven, no polling)");
  }

  async stop(): Promise<void> {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.bus?.publish({
      channel: "hud.update",
      source: this.id,
      action: "remove",
      pieceId: this.id,
    });
    log.info("HudCoreNodePiece: stopped");
  }
}
