// src/mcp/manager.ts
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { EventBus } from "../core/bus.js";
import type { SystemEventMessage, HudUpdateMessage } from "../core/types.js";
import type { CapabilityRegistry } from "../capabilities/registry.js";
import { abortRegistry } from "../capabilities/abort-registry.js";
import type { Piece } from "../core/piece.js";
import { log } from "../logger/index.js";
import { JarvisOAuthProvider } from "./oauth.js";
import { graphRegistry } from "../core/graph-registry.js";
// NOTE: PieceManager is responsible for registering this piece as a core graph node.
// This piece only enriches its node with children (MCP servers) and updates meta.

export interface McpServerConfig {
  type: "http" | "sse" | "stdio";
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  oauth?: { clientId?: string; callbackPort?: number };
  autoConnect?: boolean;
}

type ServerStatus = "disconnected" | "connecting" | "connected" | "auth_required" | "error";

interface McpServerState {
  name: string;
  config: McpServerConfig;
  status: ServerStatus;
  error?: string;
  client?: Client;
  transport?: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;
  authProvider?: JarvisOAuthProvider;
  toolNames: string[];
  /** Resolves when connectServer() finishes (success or failure). Prevents duplicate spawns. */
  connectPromise?: Promise<string>;
}

/** Deep-compare two MCP server configs with key-order-insensitive JSON. */
export function configsEqual(a: McpServerConfig, b: McpServerConfig): boolean {
  return stableStringify(a) === stableStringify(b);
}

/** Recursively stringify with sorted keys so key order doesn't affect equality.
 *  Arrays keep their order (meaningful for `args`); plain objects are key-sorted.
 *  Keys whose value is `undefined` are skipped (matches JSON.stringify semantics),
 *  so `{x:1}` and `{x:1, y:undefined}` compare equal.
 */
function stableStringify(value: unknown): string {
  if (value === undefined) return "null"; // shouldn't reach here top-level; safe fallback
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(v => v === undefined ? "null" : stableStringify(v)).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter(k => obj[k] !== undefined).sort();
  return "{" + keys.map(k => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}

export class McpManager implements Piece {
  readonly id = "mcp-manager";
  readonly name = "MCP Manager";

  private bus!: EventBus;
  private registry: CapabilityRegistry;
  private servers = new Map<string, McpServerState>();
  private configPath: string;

  systemContext(): string {
    const serverList = [...this.servers.entries()]
      .map(([name, s]) => `${name}: ${s.status}, ${s.toolNames.length} tools`)
      .join('; ');
    return `## MCP Manager Piece
You can connect to external services via Model Context Protocol.
Configured servers: ${serverList || 'none loaded yet'}.
Tools: mcp_list, mcp_connect, mcp_disconnect, mcp_login, mcp_refresh.
Connect servers on demand when the user needs external services (Jira, Slack, Confluence, etc).`;
  }

  constructor(registry: CapabilityRegistry, configPath?: string) {
    this.registry = registry;
    // Canonical path: ~/.jarvis/mcp.json (user config). Fallback to cwd for tests/custom setups.
    this.configPath = configPath ?? join(homedir(), ".jarvis", "mcp.json");
  }

  async start(bus: EventBus): Promise<void> {
    this.bus = bus;
    this.loadServers();
    this.registerManagementTools();

    // In-flight MCP call cancellation is handled by the shared AbortRegistry
    // (wired once in main.ts). Handlers register/release per-tool controllers.

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
        position: { x: 1680, y: 208 },
        size: { width: 240, height: 130 },
      },
    });

    // Enrich the graph node (registered by PieceManager) with children and meta.
    // Children are MCP server connections — resolved dynamically every render frame.
    graphRegistry.update(this.id, { meta: { servers: this.servers.size } });
    graphRegistry.setChildren(this.id, () => [...this.servers.values()].map(s => ({
      id: `mcp-${s.name}`,
      label: s.name,
      status: s.status,
      meta: { tools: s.toolNames.length },
    })));

    log.info({ serverCount: this.servers.size }, "McpManager: started");

    // Fire-and-forget: auto-connect servers with autoConnect: true
    this.autoConnectServers();
  }

  private autoConnectServers(): void {
    const autoConnectNames = [...this.servers.entries()]
      .filter(([_, s]) => s.config.autoConnect === true)
      .map(([name]) => name);

    if (autoConnectNames.length === 0) return;

    log.info({ servers: autoConnectNames }, "McpManager: auto-connecting servers in background");

    for (const name of autoConnectNames) {
      this.connectServer(name)
        .then((result) => {
          log.info({ name, result }, "McpManager: auto-connect finished");
          this.bus.publish({
            channel: "system.event",
            source: "mcp-manager",
            event: "mcp.auto-connected",
            data: { server: name, result },
          });
        })
        .catch((err) => {
          log.error({ name, err }, "McpManager: auto-connect failed");
        });
    }
  }

  async stop(): Promise<void> {
    for (const [name, server] of this.servers) {
      if (server.client && server.status === "connected") {
        try {
          await server.client.close();
          log.info({ name }, "McpManager: disconnected");
        } catch (err) {
          log.error({ name, err }, "McpManager: error disconnecting");
        }
      }
    }
    this.servers.clear();
    // NOTE: PieceManager handles graph unregistration — we just clear children
    graphRegistry.setChildren(this.id, undefined);
    this.bus.publish({
      channel: "hud.update",
      source: this.id,
      action: "remove",
      pieceId: this.id,
    });
    log.info("McpManager: stopped");
  }

  getData(): Record<string, unknown> {
    const servers = [...this.servers.values()].map(s => ({
      name: s.name,
      type: s.config.type,
      status: s.status,
      tools: s.toolNames.length,
      error: s.error,
    }));
    const connected = servers.filter(s => s.status === "connected").length;
    return { servers, connected, total: servers.length };
  }

  // --- Public actions (called by tools) ---

  async connectServer(name: string): Promise<string> {
    const server = this.servers.get(name);
    if (!server) return `Server '${name}' not found. Available: ${[...this.servers.keys()].join(", ")}`;
    if (server.status === "connected") return `Server '${name}' is already connected.`;

    // Guard: if a connect is already in flight, wait for it instead of spawning a second process
    if (server.connectPromise) {
      log.info({ name }, "McpManager: connect already in progress, waiting for existing attempt");
      return server.connectPromise;
    }

    server.connectPromise = this.doConnect(server);
    try {
      return await server.connectPromise;
    } finally {
      server.connectPromise = undefined;
    }
  }

  private async doConnect(server: McpServerState): Promise<string> {
    const name = server.name;
    server.status = "connecting";
    server.error = undefined;

    try {
      const client = new Client({ name: `jarvis-${name}`, version: "1.0.0" });
      let transport: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;
      let authProvider: JarvisOAuthProvider | undefined;

      if (server.config.type === "http") {
        if (!server.config.url) throw new Error("HTTP type requires url");
        authProvider = new JarvisOAuthProvider(name, server.config.oauth);
        transport = new StreamableHTTPClientTransport(new URL(server.config.url), {
          requestInit: { headers: server.config.headers ?? {} },
          authProvider,
        });
      } else if (server.config.type === "sse") {
        if (!server.config.url) throw new Error("SSE type requires url");
        authProvider = new JarvisOAuthProvider(name, server.config.oauth);
        transport = new SSEClientTransport(new URL(server.config.url), {
          requestInit: { headers: server.config.headers ?? {} },
          authProvider,
        });
      } else if (server.config.type === "stdio") {
        if (!server.config.command) throw new Error("stdio type requires command");
        transport = new StdioClientTransport({
          command: server.config.command,
          args: server.config.args ?? [],
          env: { ...process.env, ...(server.config.env ?? {}) } as Record<string, string>,
          ...(server.config.cwd ? { cwd: server.config.cwd } : {}),
        });
      } else {
        throw new Error(`Unknown type: ${server.config.type}`);
      }

      // Pre-check: if HTTP and no saved tokens, probe for device code support BEFORE connect
      if (authProvider && server.config.url && !authProvider.tokens()) {
        const deviceSupport = await authProvider.discoverDeviceCodeSupport(server.config.url).catch(() => null);
        if (deviceSupport) {
          server.status = "auth_required";
          server.client = client;
          server.transport = transport;
          server.authProvider = authProvider;
          log.info({ name }, "McpManager: device code flow detected — authenticating before connect");
          this.awaitDeviceCodeInBackground(server);
          return `Server '${name}' requires authentication. Check the terminal for the device code and verification URL.`;
        }
      }

      try {
        await client.connect(transport);
      } catch (error) {
        if (error instanceof UnauthorizedError) {
          server.status = "auth_required";
          server.client = client;
          server.transport = transport;
          server.authProvider = authProvider;
          log.info({ name }, "McpManager: auth required — waiting for browser login in background");
          if (authProvider) {
            this.awaitLoginInBackground(server);
          }
          return `Server '${name}' requires authentication. Browser opened — complete the login and the connection will finalize automatically.`;
        }
        throw error;
      }

      // Connected — list and register tools
      server.client = client;
      server.transport = transport;
      server.authProvider = authProvider;
      await this.registerServerTools(server);
      server.status = "connected";
      log.info({ name, tools: server.toolNames.length }, "McpManager: connected");
      this.publishHudUpdate();
      return `Connected to '${name}'. ${server.toolNames.length} tools available.`;

    } catch (err) {
      server.status = "error";
      server.error = String(err);
      log.error({ name, err }, "McpManager: connect failed");
      this.publishHudUpdate();
      return `Failed to connect to '${name}': ${err}`;
    }
  }

  private awaitLoginInBackground(server: McpServerState): void {
    const name = server.name;
    server.authProvider!.waitForCallback()
      .then(async (code) => {
        log.info({ name }, "McpManager: OAuth callback received");
        if (server.transport instanceof StreamableHTTPClientTransport || server.transport instanceof SSEClientTransport) {
          await server.transport.finishAuth(code);
        }
        if (server.client) {
          await server.client.connect(server.transport!);
        }
        await this.registerServerTools(server);
        server.status = "connected";
        log.info({ name, tools: server.toolNames.length }, "McpManager: background login successful");

        // Notify via EventBus
        this.bus.publish({
          channel: "system.event",
          source: "mcp-manager",
          event: "mcp.connected",
          data: { server: name, tools: server.toolNames },
        });
        this.publishHudUpdate();
      })
      .catch((err) => {
        server.status = "error";
        server.error = String(err);
        log.error({ name, err }, "McpManager: background login failed");
        this.publishHudUpdate();
      });
  }

  private awaitDeviceCodeInBackground(server: McpServerState): void {
    const name = server.name;
    server.authProvider!.deviceCodeFlow(server.config.url!)
      .then(async () => {
        log.info({ name }, "McpManager: device code auth completed — reconnecting");

        // Reconnect with the new tokens
        const client = new Client({ name: `jarvis-${name}`, version: "1.0.0" });
        let transport: StreamableHTTPClientTransport | SSEClientTransport;

        if (server.config.type === "http") {
          transport = new StreamableHTTPClientTransport(new URL(server.config.url!), {
            requestInit: { headers: server.config.headers ?? {} },
            authProvider: server.authProvider,
          });
        } else {
          transport = new SSEClientTransport(new URL(server.config.url!), {
            requestInit: { headers: server.config.headers ?? {} },
            authProvider: server.authProvider,
          });
        }

        await client.connect(transport);
        server.client = client;
        server.transport = transport;
        await this.registerServerTools(server);
        server.status = "connected";
        log.info({ name, tools: server.toolNames.length }, "McpManager: device code login successful");

        // Notify via EventBus
        this.bus.publish({
          channel: "system.event",
          source: "mcp-manager",
          event: "mcp.connected",
          data: { server: name, tools: server.toolNames },
        });
        this.publishHudUpdate();
      })
      .catch((err) => {
        server.status = "error";
        server.error = String(err);
        log.error({ name, err }, "McpManager: device code login failed");
        this.publishHudUpdate();
      });
  }

  async loginServer(name: string): Promise<string> {
    const server = this.servers.get(name);
    if (!server) return `Server '${name}' not found.`;
    if (server.status !== "auth_required") return `Server '${name}' is not waiting for auth (status: ${server.status}).`;
    if (!server.authProvider || !server.transport) return `Server '${name}' has no auth provider.`;

    try {
      log.info({ name }, "McpManager: starting OAuth login");
      const code = await server.authProvider.waitForCallback();

      if (server.transport instanceof StreamableHTTPClientTransport || server.transport instanceof SSEClientTransport) {
        await server.transport.finishAuth(code);
      }

      // Reconnect
      if (server.client) {
        await server.client.connect(server.transport);
      }

      await this.registerServerTools(server);
      server.status = "connected";
      log.info({ name, tools: server.toolNames.length }, "McpManager: login successful");
      this.publishHudUpdate();
      return `Authenticated and connected to '${name}'. ${server.toolNames.length} tools available.`;

    } catch (err) {
      server.status = "error";
      server.error = String(err);
      log.error({ name, err }, "McpManager: login failed");
      this.publishHudUpdate();
      return `Login failed for '${name}': ${err}`;
    }
  }

  async refreshConfig(): Promise<string> {
    const configs = this.loadConfig();
    const added: string[] = [];
    const removed: string[] = [];
    const changed: string[] = [];
    const reconnectTargets: string[] = [];

    // Add new servers
    for (const [name, config] of Object.entries(configs)) {
      if (!this.servers.has(name)) {
        this.servers.set(name, { name, config, status: "disconnected", toolNames: [] });
        added.push(name);
      }
    }

    // Detect changed configs on existing servers — disconnect + replace config.
    // Uses a stable JSON snapshot to compare (order-independent at top level via sort).
    for (const [name, server] of this.servers) {
      if (!(name in configs)) continue;
      const newCfg = configs[name];
      if (configsEqual(server.config, newCfg)) continue;

      const wasConnected = server.status === "connected";
      if (server.client) {
        try { await server.client.close(); } catch { /* ignore */ }
      }
      server.client = undefined;
      server.transport = undefined;
      server.connectPromise = undefined;
      server.config = newCfg;
      server.status = "disconnected";
      server.toolNames = [];
      server.error = undefined;
      changed.push(name);
      if (wasConnected || newCfg.autoConnect === true) {
        reconnectTargets.push(name);
      }
    }

    // Remove servers no longer in config (disconnect first)
    for (const [name, server] of this.servers) {
      if (!(name in configs)) {
        if (server.client && server.status === "connected") {
          try { await server.client.close(); } catch { /* ignore */ }
        }
        this.servers.delete(name);
        removed.push(name);
      }
    }

    // Auto-reconnect: (a) previously-connected servers whose config changed,
    // (b) any server (new or existing) with autoConnect=true that isn't connected,
    // so a config edit that flips autoConnect=true also takes effect.
    const autoConnectNames = new Set<string>(reconnectTargets);
    for (const [name, server] of this.servers) {
      if (server.config.autoConnect === true && server.status !== "connected") {
        autoConnectNames.add(name);
      }
    }
    if (autoConnectNames.size > 0) {
      // Fire-and-forget — don't block refresh on reconnect results.
      for (const name of autoConnectNames) {
        this.connectServer(name).catch(err => {
          log.warn({ name, err: String(err) }, "McpManager: auto-reconnect after refresh failed");
        });
      }
    }

    log.info({ added, removed, changed }, "McpManager: config refreshed");
    const parts: string[] = [];
    if (added.length) parts.push(`Added: ${added.join(", ")}`);
    if (changed.length) parts.push(`Updated: ${changed.join(", ")}`);
    if (removed.length) parts.push(`Removed: ${removed.join(", ")}`);
    if (!parts.length) parts.push("No changes");
    parts.push(`Total: ${this.servers.size} servers`);
    this.publishHudUpdate();
    return parts.join(". ");
  }

  async disconnectServer(name: string): Promise<string> {
    const server = this.servers.get(name);
    if (!server) return `Server '${name}' not found.`;
    if (server.status === "disconnected") return `Server '${name}' is already disconnected.`;

    // Wait for any in-flight connect to finish before tearing down
    if (server.connectPromise) {
      log.info({ name }, "McpManager: waiting for in-flight connect before disconnect");
      await server.connectPromise.catch(() => {});
    }

    if (server.client) {
      try { await server.client.close(); } catch { /* ignore */ }
    }

    server.status = "disconnected";
    server.client = undefined;
    server.transport = undefined;
    server.toolNames = [];
    server.error = undefined;
    log.info({ name }, "McpManager: disconnected");
    this.publishHudUpdate();
    return `Disconnected from '${name}'.`;
  }

  private publishHudUpdate(): void {
    this.bus.publish({
      channel: "hud.update",
      source: this.id,
      action: "update",
      pieceId: this.id,
      data: this.getData(),
      status: "running",
    });
  }

  // --- Internal ---

  private loadServers(): void {
    const configs = this.loadConfig();
    for (const [name, config] of Object.entries(configs)) {
      this.servers.set(name, {
        name,
        config,
        status: "disconnected",
        toolNames: [],
      });
    }
    log.info({ servers: [...this.servers.keys()] }, "McpManager: servers loaded from config");
  }

  private async registerServerTools(server: McpServerState): Promise<void> {
    if (!server.client) return;

    const { tools } = await server.client.listTools();
    server.toolNames = [];

    for (const tool of tools) {
      const toolName = `mcp__${server.name}__${tool.name}`;
      server.toolNames.push(toolName);

      this.registry.register({
        name: toolName,
        // Explicit for clarity — the `mcp__` prefix fallback would also apply.
        category: "mcp",
        description: tool.description ?? `Tool ${tool.name} from MCP server ${server.name}`,
        input_schema: (tool.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
        handler: async (input) => {
          const sessionId = input.__sessionId as string | undefined;
          const toolUseId = input.__toolUseId as string | undefined;
          // Strip executor-injected context fields — MCP servers must only
          // receive the tool's declared arguments.
          const { __sessionId: _, __toolUseId: __, ...args } = input;
          // Per-tool abort: parallel MCP calls each get their own controller.
          const signal = sessionId ? abortRegistry.register(sessionId, toolUseId) : new AbortController().signal;
          try {
            const result = await server.client!.callTool(
              { name: tool.name, arguments: args },
              undefined,
              { signal },
            );
            if (Array.isArray(result.content)) {
              return (result.content as Array<{ type: string; text?: string }>)
                .filter((c) => c.type === "text")
                .map((c) => c.text)
                .join("\n");
            }
            return result.content;
          } catch (err: any) {
            if (signal.aborted || err?.name === "AbortError") {
              return { error: "aborted" };
            }
            throw err;
          } finally {
            if (sessionId) abortRegistry.release(sessionId, toolUseId);
          }
        },
      });
    }
  }

  private registerManagementTools(): void {
    this.registry.register({
      name: "mcp_list",
      category: "mcp",
      description: "List all configured MCP servers with their connection status",
      input_schema: { type: "object", properties: {}, required: [] },
      handler: async () => {
        return [...this.servers.values()].map(s => ({
          name: s.name,
          type: s.config.type,
          status: s.status,
          tools: s.toolNames.length,
          error: s.error,
        }));
      },
    });

    this.registry.register({
      name: "mcp_connect",
      category: "mcp",
      description: "Connect to a configured MCP server by name",
      input_schema: {
        type: "object",
        properties: { name: { type: "string", description: "Server name from mcp.json" } },
        required: ["name"],
      },
      handler: async (input) => this.connectServer(input.name as string),
    });

    this.registry.register({
      name: "mcp_login",
      category: "mcp",
      description: "Authenticate with an MCP server that requires OAuth login. Opens browser for auth flow.",
      input_schema: {
        type: "object",
        properties: { name: { type: "string", description: "Server name requiring auth" } },
        required: ["name"],
      },
      handler: async (input) => this.loginServer(input.name as string),
    });

    this.registry.register({
      name: "mcp_disconnect",
      category: "mcp",
      description: "Disconnect from a connected MCP server",
      input_schema: {
        type: "object",
        properties: { name: { type: "string", description: "Server name to disconnect" } },
        required: ["name"],
      },
      handler: async (input) => this.disconnectServer(input.name as string),
    });

    this.registry.register({
      name: "mcp_refresh",
      category: "mcp",
      description: "Reload mcp.json config — picks up new servers or removes deleted ones without restarting JARVIS",
      input_schema: { type: "object", properties: {}, required: [] },
      handler: async () => this.refreshConfig(),
    });
  }

  private loadConfig(): Record<string, McpServerConfig> {
    const defaultConfig = this.loadConfigFile(this.configPath);
    const userPath = this.configPath.replace(/\.json$/, ".user.json");
    const userConfig = this.loadConfigFile(userPath);

    // User overrides default — server-level merge (user wins entirely per server name)
    const merged = { ...defaultConfig, ...userConfig };
    log.info({
      defaultPath: this.configPath,
      userPath,
      defaultServers: Object.keys(defaultConfig),
      userServers: Object.keys(userConfig),
      mergedServers: Object.keys(merged),
    }, "McpManager: config loaded (default + user)");
    return merged;
  }

  private loadConfigFile(path: string): Record<string, McpServerConfig> {
    if (!existsSync(path)) {
      return {};
    }
    try {
      const content = readFileSync(path, "utf-8");
      const parsed = JSON.parse(content);
      return parsed.mcpServers ?? {};
    } catch (err) {
      log.error({ path, err }, "McpManager: failed to parse config file");
      return {};
    }
  }
}
