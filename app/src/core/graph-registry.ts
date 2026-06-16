// src/core/graph-registry.ts
// GraphRegistry — typed, bus-free registry for the hud-core-node graph.
// Pieces call register() in start() and unregister() in stop().
// HudCoreNodePiece subscribes via onChange() and receives a notification whenever the tree
// mutates — no polling needed. Call notify() after any structural or status change.

import { log } from "../logger/index.js";

export interface GraphNodeDef {
  /** Unique node id (usually the piece id) */
  id: string;
  /** Display label */
  label: string;
  /** Current status — drives color: running, processing, stopped, error, connected, etc. */
  status: string;
  /** Arbitrary metadata shown in tooltips (e.g. { tools: 5 }, { drawers: 12 }) */
  meta?: Record<string, unknown>;
  /** Callback that returns child nodes. Called every render frame — keep it cheap. */
  children?: () => GraphNodeChild[];
}

export interface GraphNodeChild {
  id: string;
  label: string;
  status: string;
  meta?: Record<string, unknown>;
  children?: () => GraphNodeChild[];
}

/** Flat snapshot of a node for the renderer */
export interface GraphNodeSnapshot {
  id: string;
  label: string;
  status: string;
  parentId: string | null;
  meta?: Record<string, unknown>;
}

class GraphRegistryImpl {
  private nodes = new Map<string, GraphNodeDef>();
  /** Root node status — updated via update("jarvis-core", { status }) */
  private rootStatus = "online";
  /** Listeners notified on every structural or status mutation. */
  private changeListeners = new Set<() => void>();

  /** Subscribe to tree mutations. Returns an unsubscribe function. */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  /** Fire all registered listeners. Call after any register/unregister/update/setChildren. */
  private notify(): void {
    for (const fn of this.changeListeners) {
      try { fn(); } catch (e) {
        log.warn({ error: (e as Error).message }, "GraphRegistry: onChange listener threw");
      }
    }
  }

  register(node: GraphNodeDef): void {
    const existing = this.nodes.get(node.id);
    if (existing) {
      // Preserve children and meta set by plugins via graphHandle
      if (!node.children && existing.children) node.children = existing.children;
      if (!node.meta && existing.meta) node.meta = existing.meta;
    }
    this.nodes.set(node.id, node);
    log.debug({ nodeId: node.id }, "GraphRegistry: registered");
    this.notify();
  }

  unregister(id: string): void {
    this.nodes.delete(id);
    log.debug({ nodeId: id }, "GraphRegistry: unregistered");
    this.notify();
  }

  /** Set or clear the children callback on an existing node.
   *  Pieces use this to enrich their graph node with dynamic children
   *  (e.g. MCP servers, plugin sub-components) without re-registering. */
  setChildren(id: string, children: (() => GraphNodeChild[]) | undefined): void {
    const node = this.nodes.get(id);
    if (!node) return;
    node.children = children;
    this.notify();
  }

  /** Update status/meta/label without re-registering */
  update(id: string, patch: Partial<Pick<GraphNodeDef, "status" | "meta" | "label">>): void {
    // Special case: root node status is stored separately
    if (id === "jarvis-core" && patch.status !== undefined) {
      this.rootStatus = patch.status;
      this.notify();
      return;
    }
    const node = this.nodes.get(id);
    if (!node) return;
    if (patch.status !== undefined) node.status = patch.status;
    if (patch.meta !== undefined) node.meta = patch.meta;
    if (patch.label !== undefined) node.label = patch.label;
    this.notify();
  }

  /**
   * Returns a flat list of all nodes with parentId references.
   * The root "jarvis-core" node is always included.
   * Children are resolved by calling each node's children() callback.
   */
  getTree(): GraphNodeSnapshot[] {
    const result: GraphNodeSnapshot[] = [];

    // Root node — status is updated by JarvisCore.deriveGlobalState()
    result.push({
      id: "jarvis-core",
      label: "JARVIS",
      status: this.rootStatus,
      parentId: null,
    });

    // Level 1: registered pieces → children of jarvis-core
    for (const node of this.nodes.values()) {
      result.push({
        id: node.id,
        label: node.label,
        status: node.status,
        parentId: "jarvis-core",
        meta: node.meta,
      });

      // Recurse children
      if (node.children) {
        try {
          this.collectChildren(node.children(), node.id, result);
        } catch (e) {
          log.warn({ nodeId: node.id, error: (e as Error).message }, "GraphRegistry: children() threw");
        }
      }
    }

    return result;
  }

  private collectChildren(children: GraphNodeChild[], parentId: string, result: GraphNodeSnapshot[]): void {
    for (const child of children) {
      result.push({
        id: child.id,
        label: child.label,
        status: child.status,
        parentId,
        meta: child.meta,
      });

      if (child.children) {
        try {
          this.collectChildren(child.children(), child.id, result);
        } catch (e) {
          log.warn({ nodeId: child.id, error: (e as Error).message }, "GraphRegistry: nested children() threw");
        }
      }
    }
  }

  /** Check if a node is registered (excludes root) */
  has(id: string): boolean {
    return this.nodes.has(id);
  }

  /** Number of registered level-1 nodes (excludes root) */
  get size(): number {
    return this.nodes.size;
  }
}

/** Singleton — import this from any piece */
export const graphRegistry = new GraphRegistryImpl();
