// src/input/grpc-piece.ts
import type { EventBus } from "../core/bus.js";
import type { Piece } from "../core/piece.js";
import type { HudUpdateMessage } from "../core/types.js";
import type { CapabilityRegistry } from "../capabilities/registry.js";
import { GrpcServer } from "../transport/grpc/server.js";
import { GrpcInputAdapter } from "./grpc.js";
import { config } from "../config/index.js";
import { log } from "../logger/index.js";
import { graphRegistry } from "../core/graph-registry.js";
// NOTE: PieceManager is responsible for registering this piece as a core graph node.
// This piece only updates its node meta (port, running state).

export class GrpcPiece implements Piece {
  readonly id = "grpc";
  readonly name = "gRPC Server";

  private bus!: EventBus;
  private server: GrpcServer | null = null;
  private adapter: GrpcInputAdapter | null = null;

  systemContext(): string {
    return `## gRPC Piece
External clients can interact with you via gRPC on port ${config.grpcPort}.
Tools: grpc_start, grpc_stop, grpc_status.`;
  }

  constructor(private registry: CapabilityRegistry) {}

  async start(bus: EventBus): Promise<void> {
    this.bus = bus;
    this.adapter = new GrpcInputAdapter(bus);

    if (config.grpcEnabled) {
      this.server = new GrpcServer(config.grpcPort);
      this.server.setHandler((prompt, clientId, target) => this.adapter!.processMessage(prompt, clientId, target));
    }

    this.registry.register({
      name: "grpc_status",
      category: "grpc",
      description: "Check if gRPC server is running",
      input_schema: { type: "object", properties: {}, required: [] },
      handler: async () => ({ running: !!this.server, port: this.server ? config.grpcPort : null }),
    });

    this.registry.register({
      name: "grpc_start",
      category: "grpc",
      description: "Start the gRPC server",
      input_schema: { type: "object", properties: {}, required: [] },
      handler: async () => {
        if (this.server) return "gRPC already running";
        this.server = new GrpcServer(config.grpcPort);
        this.server.setHandler((prompt, clientId, target) => this.adapter!.processMessage(prompt, clientId, target));
        this.updateHud("running");
        return `gRPC started on :${config.grpcPort}`;
      },
    });

    this.registry.register({
      name: "grpc_stop",
      category: "grpc",
      description: "Stop the gRPC server",
      input_schema: { type: "object", properties: {}, required: [] },
      handler: async () => {
        if (!this.server) return "gRPC is not running";
        this.server.stop();
        this.server = null;
        this.updateHud("stopped");
        return "gRPC stopped";
      },
    });

    this.bus.publish({
      channel: "hud.update",
      source: this.id,
      action: "add",
      pieceId: this.id,
      piece: {
        pieceId: this.id,
        type: "indicator",
        name: this.name,
        status: this.server ? "running" : "stopped",
        data: { port: this.server ? config.grpcPort : null, running: !!this.server },
        position: { x: 20, y: 20 },
        size: { width: 120, height: 36 },
      },
    });

    // Enrich the graph node (registered by PieceManager) with meta
    graphRegistry.update(this.id, { meta: { port: config.grpcPort } });

    log.info({ enabled: config.grpcEnabled, port: config.grpcPort }, "GrpcPiece: started");
  }

  async stop(): Promise<void> {
    if (this.server) {
      this.server.stop();
      this.server = null;
    }
    // NOTE: PieceManager handles graph unregistration
    this.bus.publish({
      channel: "hud.update",
      source: this.id,
      action: "remove",
      pieceId: this.id,
    });
    log.info("GrpcPiece: stopped");
  }

  private updateHud(status: string): void {
    this.bus.publish({
      channel: "hud.update",
      source: this.id,
      action: "update",
      pieceId: this.id,
      data: { port: this.server ? config.grpcPort : null, running: !!this.server },
      status,
    });
  }
}
