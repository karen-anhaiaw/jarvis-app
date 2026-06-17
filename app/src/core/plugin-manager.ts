// src/core/plugin-manager.ts
// Manages JARVIS plugins from GitHub repos.
// Plugins are cloned to ~/.jarvis/plugins/ and referenced by settings.
// Tools, prompts loaded at runtime. Pieces/renderers in phase 2.

import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { EventBus } from "./bus.js";
import type { Piece } from "./piece.js";
import type { HudUpdateMessage, ChatTimelineEntry } from "./types.js";
import type { CapabilityRegistry } from "../capabilities/registry.js";
import type { PieceManager } from "./piece-manager.js";
import type { PluginContext, ContextInjectorFn } from "@jarvis/core";
import type { AISessionFactory } from "../ai/types.js";
// Note: getMessageInjectedSkills was removed — skill injection is a plugin concern
import type { SessionManager } from "./session-manager.js";

interface HttpServerLike {
  registerRoute(method: string, path: string, handler: (req: any, res: any) => void): void;
}
import { load as loadSettings, save as saveSettings, removeKey, type PluginSettings } from "./settings.js";
import { graphRegistry } from "./graph-registry.js";
import { log } from "../logger/index.js";
import { DEFAULT_SESSION } from "./constants.js";

const PLUGINS_DIR = join(process.env.HOME ?? "~", ".jarvis", "plugins");

interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author?: string;
  entry?: string;
  capabilities?: {
    tools?: boolean;
    pieces?: boolean;
    renderers?: boolean;
    prompts?: boolean;
  };
}

interface LoadedPlugin {
  name: string;
  manifest: PluginManifest;
  settings: PluginSettings;
  tools: string[];
  prompts: string[];
  pieces: string[];      // piece IDs loaded from this plugin
  renderers: string[];   // renderer file names (without .tsx)
  context: string;       // system prompt context from context.md
}

export class PluginManager implements Piece {
  readonly id = "plugin-manager";
  readonly name = "Plugin Manager";

  private bus!: EventBus;
  private registry: CapabilityRegistry;
  private plugins = new Map<string, LoadedPlugin>();
  private pieceManager?: PieceManager;
  private factory?: AISessionFactory;
  private sessions?: SessionManager;
  private httpServer?: HttpServerLike;
  /** Chat-piece reference for timeline entry broadcasting. Set by main.ts. */
  private chatPiece?: { broadcastEvent(sessionId: string, data: Record<string, unknown>): void };
  /** Plugin load failures — flushed to main after jarvisCore.ready(). */
  private pluginLoadFailures: Array<{ name: string; err: string }> = [];

  /**
   * Set of context injectors registered by plugins. Composed into a single
   * aggregator that is installed on every owned AISession (current + future).
   * Each injector is keyed by an opaque token so registration order is stable
   * (Set preserves insertion order in JS).
   */
  private contextInjectors = new Set<ContextInjectorFn>();

  constructor(registry: CapabilityRegistry) {
    this.registry = registry;
  }

  setPieceManager(pm: PieceManager): void {
    this.pieceManager = pm;
  }

  setFactory(factory: AISessionFactory): void {
    this.factory = factory;
  }

  setSessionManager(sessions: SessionManager): void {
    this.sessions = sessions;
    // Register the global aggregator once — SessionManager applies it to every
    // session (existing + future) without per-session wiring or onSessionCreated hooks.
    sessions.setGlobalContextInjector(async (sessionId: string): Promise<string[]> => {
      log.info({ sessionId, injectorCount: this.contextInjectors.size }, "PluginManager: global aggregator called");
      if (this.contextInjectors.size === 0) return [];
      const out: string[] = [];
      const fns = Array.from(this.contextInjectors);
      const results = await Promise.allSettled(
        fns.map(async (fn, i) => {
          log.info({ sessionId, i, fnName: fn.name || "anonymous" }, "PluginManager: calling injector");
          const r = await fn(sessionId);
          log.info({ sessionId, i, resultLen: Array.isArray(r) ? r.length : -1 }, "PluginManager: injector returned");
          return r;
        }),
      );
      for (const r of results) {
        if (r.status === "rejected") {
          log.warn({ sessionId, err: String(r.reason) }, "PluginManager: context injector threw — skipped");
          continue;
        }
        if (Array.isArray(r.value)) out.push(...r.value);
      }
      log.info({ sessionId, totalBlocks: out.length }, "PluginManager: global aggregator done");
      return out;
    });
  }

  /**
   * Add a context injector. Returns an unregister function.
   * The global aggregator on SessionManager closes over `this.contextInjectors`,
   * so additions/removals take effect on the next request without re-wiring.
   */
  registerContextInjector(fn: ContextInjectorFn): () => void {
    this.contextInjectors.add(fn);
    log.debug({ count: this.contextInjectors.size }, "PluginManager: context injector registered");
    return () => {
      this.contextInjectors.delete(fn);
      log.debug({ count: this.contextInjectors.size }, "PluginManager: context injector unregistered");
    };
  }

  setChatPiece(cp: { broadcastEvent(sessionId: string, data: Record<string, unknown>): void }): void {
    this.chatPiece = cp;
  }

  setHttpServer(server: HttpServerLike): void {
    this.httpServer = server;
  }

  /** Plugin instructions: registry + context.md (static, rarely changes) */
  systemContext(): string {
    if (this.plugins.size === 0) return "";

    // Plugin registry
    const list = [...this.plugins.values()]
      .map(p => `${p.name}: ${p.manifest.description} (${p.tools.length} tools, ${p.pieces.length} pieces)`)
      .join("\n");
    const header = `## Plugins\n${list}\nTools: plugin_install, plugin_list, plugin_update, plugin_enable, plugin_disable, plugin_remove\n\n<system-reminder>\n<important>\n<never-skip>\n**[MUST] Plugin functional tests — MANDATORY, NO EXCEPTIONS.**\n\nEvery plugin MUST have a \`functional-test.md\` in its root directory (\`~/.jarvis/plugins/<plugin-name>/functional-test.md\`).\n\nAfter installing, updating, or enabling a plugin, you MUST:\n1. Read its \`functional-test.md\` in full.\n2. Execute **EVERY SINGLE BDD scenario** one by one — **no skipping, no summarizing, no shortcuts**.\n3. Validate each assertion in each scenario before moving to the next.\n4. Report pass/fail for EACH scenario individually.\n\n**This is NOT optional. This is NOT a suggestion. This is NOT up to LLM judgment.**\n- You MUST NOT skip scenarios you consider "less important" or "already covered".\n- You MUST NOT batch or collapse multiple scenarios into one test.\n- You MUST NOT stop after "the happy path works" — error scenarios, edge cases, and HUD validations are EQUALLY mandatory.\n- You MUST NOT claim installation is successful until ALL scenarios have been executed and pass.\n- If a plugin has no \`functional-test.md\`, report it as a defect — the plugin is incomplete.\n\nA plugin installation is ONLY considered successful when every single scenario in functional-test.md has been individually executed and validated.\n</never-skip>\n</important>\n</system-reminder>`;

    // Static context.md from each plugin
    const contexts = [...this.plugins.values()]
      .map(p => p.context)
      .filter(Boolean);

    return [header, ...contexts].join("\n\n");
  }

  /** Plugin dynamic context: systemContext() from plugin pieces (changes every turn) */
  pluginPieceContext(sessionId?: string): string {
    if (!this.pieceManager) return "";

    const pieceContexts: string[] = [];
    for (const plugin of this.plugins.values()) {
      for (const pieceId of plugin.pieces) {
        const piece = this.pieceManager.pieces.get(pieceId);
        if (piece?.systemContext) {
          const ctx = piece.systemContext(sessionId);
          if (ctx) pieceContexts.push(ctx);
        }
      }
    }

    return pieceContexts.join("\n\n");
  }

  /** Call after jarvisCore.ready() to flush plugin load failures to the main session. */
  notifyLoadFailures(): void {
    if (this.pluginLoadFailures.length === 0) return;
    for (const { name, err } of this.pluginLoadFailures) {
      this.bus.publish({
        channel: "ai.request",
        source: "system",
        target: DEFAULT_SESSION,
        text: `[SYSTEM] Plugin **${name}** failed to load: ${err}\n\nThe plugin has been skipped. JARVIS continues normally without it.`,
      } as any);
    }
    this.pluginLoadFailures = [];
  }

  async start(bus: EventBus): Promise<void> {
    this.bus = bus;

    if (!existsSync(PLUGINS_DIR)) mkdirSync(PLUGINS_DIR, { recursive: true });

    // Load enabled plugins from settings — auto-clone if repo not present
    const settings = loadSettings();
    for (const [name, ps] of Object.entries(settings.plugins ?? {})) {
      if (!ps.enabled) continue;

      // Resolve path: use explicit path or default to ~/.jarvis/plugins/<name>
      if (!ps.path) ps.path = join(PLUGINS_DIR, name);

      // Auto-clone if the plugin directory doesn't exist but we have a repo URL
      if (!existsSync(ps.path) && ps.repo) {
        const repoUrl = ps.repo.startsWith("http") ? ps.repo : `https://${ps.repo}`;
        try {
          log.info({ name, repo: repoUrl, dir: ps.path }, "PluginManager: auto-cloning missing plugin");
          execSync(`git clone ${repoUrl} ${ps.path}`, { timeout: 60000 });
        } catch (err) {
          log.error({ name, err: String(err) }, "PluginManager: auto-clone failed (git)");
          continue;
        }

        // Run npm install if package.json exists — non-fatal if it fails
        const pkgPath = join(ps.path, "package.json");
        if (existsSync(pkgPath)) {
          try {
            const npmrcPath = join(ps.path, ".npmrc");
            const npmrcFlag = existsSync(npmrcPath) ? ` --userconfig "${npmrcPath}"` : "";
            log.info({ name }, "PluginManager: running npm install after clone");
            execSync(`npm install --registry https://registry.npmjs.org${npmrcFlag}`, { cwd: ps.path, timeout: 60000 });
          } catch (err) {
            log.warn({ name, err: String(err) }, "PluginManager: npm install failed (non-fatal, plugin may still work)");
          }
        }
      }

      await this.loadPlugin(name, ps);
    }

    this.registerTools();

    this.bus.publish({
      channel: "hud.update",
      source: this.id,
      action: "add",
      pieceId: this.id,
      piece: {
        pieceId: this.id,
        type: "indicator",
        name: this.name,
        status: "running",
        data: this.getData(),
        position: { x: 10, y: 114 },
        size: { width: 150, height: 40 },
      },
    });

    // Enrich graph node with children (installed plugins) — resolved dynamically every render frame
    this.updateGraphChildren();

    log.info({ plugins: [...this.plugins.keys()] }, "PluginManager: started");

    // Async version check — runs in background after startup
    this.checkPluginVersions().catch(err =>
      log.warn({ err: String(err) }, "PluginManager: version check failed")
    );
  }

  async stop(): Promise<void> {
    graphRegistry.setChildren(this.id, undefined);
    this.bus.publish({
      channel: "hud.update",
      source: this.id,
      action: "remove",
      pieceId: this.id,
    });
  }

  // ─── Plugin Loading ───────────────────────────────────────

  private async loadPlugin(name: string, ps: PluginSettings): Promise<void> {
    const pluginDir = ps.path;
    if (!existsSync(pluginDir)) {
      log.warn({ name, path: pluginDir }, "PluginManager: plugin dir not found");
      return;
    }

    // Read manifest
    const manifestPath = join(pluginDir, "plugin.json");
    if (!existsSync(manifestPath)) {
      log.warn({ name }, "PluginManager: no plugin.json");
      return;
    }

    const manifest: PluginManifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

    // Load context.md — static system prompt instructions from plugin
    const contextPath = join(pluginDir, "context.md");
    const context = existsSync(contextPath) ? readFileSync(contextPath, "utf-8").trim() : "";

    const loaded: LoadedPlugin = { name, manifest, settings: ps, tools: [], prompts: [], pieces: [], renderers: [], context };

    // Load tools
    const toolsDir = join(pluginDir, "tools");
    if (existsSync(toolsDir)) {
      const files = readdirSync(toolsDir).filter(f => f.endsWith(".json"));
      for (const file of files) {
        try {
          const content = readFileSync(join(toolsDir, file), "utf-8");
          const config = JSON.parse(content);
          // Adjust script paths to be relative to plugin dir
          if (config.args) {
            config.args = config.args.map((a: string) =>
              a.startsWith("tools/") ? join(pluginDir, a) : a
            );
          }
          this.registry.register({
            name: config.name,
            description: `[${manifest.name}] ${config.description}`,
            input_schema: config.input_schema,
            // Declarative category pass-through (F3.15): plugin JSON tools may
            // declare their own slash-menu group; omitted → registry fallback.
            category: config.category,
            handler: this.createToolHandler(config, pluginDir),
          });
          loaded.tools.push(config.name);
        } catch (err) {
          log.error({ name, file, err: String(err) }, "PluginManager: failed to load tool");
        }
      }
    }

    // Load prompts
    const promptsDir = join(pluginDir, "prompts");
    if (existsSync(promptsDir)) {
      const files = readdirSync(promptsDir).filter(f => f.endsWith(".md"));
      for (const file of files) {
        try {
          const content = readFileSync(join(promptsDir, file), "utf-8");
          loaded.prompts.push(content);
        } catch {}
      }
    }

    // Load pieces (Phase 2)
    if (manifest.capabilities?.pieces && manifest.entry) {
      try {
        const entryPath = join(pluginDir, manifest.entry);
        if (existsSync(entryPath)) {
          // Cache-bust with mtime so plugin edits take effect on next restart
          // without requiring a full process kill+relaunch each time.
          const { statSync: _pStat } = await import("fs");
          const _pMtime = _pStat(entryPath).mtimeMs;
          const mod = await import(`${entryPath}?t=${_pMtime}`);
          if (typeof mod.createPieces === "function" && this.pieceManager) {
            const configKey = `plugin:${name}`;
            const ctx: PluginContext = {
              bus: this.bus as unknown as PluginContext["bus"],
              capabilityRegistry: this.registry,
              config: loadSettings().pieces?.[configKey]?.config ?? {},
              pluginDir,
              sessionFactory: this.factory as unknown as PluginContext["sessionFactory"],
              // Provide the core logger as a child scoped to the plugin name.
              // Plugin entries land in jarvis.log alongside core entries and
              // are filterable by the `plugin` field — no pino bundling needed.
              log: log.child({ plugin: name }) as unknown as PluginContext["log"],
              sessionManager: this.sessions as unknown as PluginContext["sessionManager"],
              registerRoute: (method: string, path: string, handler: any) => {
                if (this.httpServer) {
                  this.httpServer.registerRoute(method, path, handler);
                }
              },
              saveConfig: (config: Record<string, unknown>) => {
                const settings = loadSettings();
                if (!settings.pieces[configKey]) settings.pieces[configKey] = { enabled: true, visible: true };
                settings.pieces[configKey].config = config;
                saveSettings(settings);
              },
              registerSlashCommand: (cmd: any) => {
                this.registry.registerSlashCommand(cmd);
              },
              unregisterSlashCommand: (name: string) => {
                this.registry.unregisterSlashCommand(name);
              },
              graphHandle: (pieceId: string) => ({
                setChildren: (children: (() => import("@jarvis/core").GraphNodeChild[]) | undefined) => {
                  graphRegistry.setChildren(pieceId, children as any);
                },
                update: (patch: { status?: string; meta?: Record<string, unknown>; label?: string }) => {
                  graphRegistry.update(pieceId, patch);
                },
              }),
              registerContextInjector: (fn: ContextInjectorFn) => this.registerContextInjector(fn),
              addChatTimelineEntry: (
                sessionId: string,
                entry: Omit<ChatTimelineEntry, "sessionId" | "source">,
              ) => {
                this.chatPiece?.broadcastEvent(sessionId, {
                  type: "timeline_entry",
                  entry: { ...entry, sessionId, source: name },
                  session: sessionId,
                });
              },
            };
            const pieces = mod.createPieces(ctx);
            for (const piece of pieces) {
              await this.pieceManager.registerDynamic(piece, `plugin:${name}`);
              loaded.pieces.push(piece.id);
            }
            log.info({ name, pieces: loaded.pieces }, "PluginManager: loaded pieces");
          }
        }
      } catch (err) {
        log.error({ name, err: String(err) }, "PluginManager: failed to load pieces");
        // Notify main session — deferred so the message arrives after jarvisCore.ready()
        this.pluginLoadFailures.push({ name, err: String(err) });
      }
    }

    // Discover renderers
    if (manifest.capabilities?.renderers) {
      const renderersDir = join(pluginDir, "renderers");
      if (existsSync(renderersDir)) {
        const files = readdirSync(renderersDir).filter(f => f.endsWith(".tsx"));
        loaded.renderers = files.map(f => f.replace(".tsx", ""));
        log.info({ name, renderers: loaded.renderers }, "PluginManager: discovered renderers");
      }
    }

    this.plugins.set(name, loaded);
    log.info({ name, tools: loaded.tools.length, prompts: loaded.prompts.length, pieces: loaded.pieces.length }, "PluginManager: loaded plugin");
  }

  private createToolHandler(config: any, pluginDir: string): (input: Record<string, unknown>) => Promise<unknown> {
    return async (input) => {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);

      const expand = (s: string) => s.replace(/^~/, process.env.HOME ?? "~");
      const args = (config.args ?? []).map((arg: string) =>
        expand(arg.replace(/\$\{(\w+)\}/g, (_: string, key: string) => expand(String(input[key] ?? ""))))
      );

      try {
        const { stdout } = await execFileAsync(config.command, args, {
          timeout: 30000,
          maxBuffer: 1024 * 1024 * 10,
          cwd: pluginDir,
        });

        if (stdout.startsWith("__TYPE__:error\n")) {
          return { error: stdout.split("\n").slice(1).join("\n").trim() };
        }
        const text = stdout.startsWith("__TYPE__:text\n")
          ? stdout.split("\n").slice(1).join("\n").trim()
          : stdout.trim();
        return { stdout: text };
      } catch (err: any) {
        return { error: err.message, exitCode: err.code };
      }
    };
  }

  // ─── Tools ────────────────────────────────────────────────

  private async install(repo: string): Promise<{ ok: boolean; name?: string; error?: string }> {
    try {
      // Normalize repo URL
      const repoUrl = repo.startsWith("http") ? repo : `https://${repo}`;
      const name = repo.split("/").pop()?.replace(".git", "") ?? repo;
      const pluginDir = join(PLUGINS_DIR, name);

      if (existsSync(pluginDir)) {
        return { ok: false, error: `Plugin ${name} already installed at ${pluginDir}` };
      }

      log.info({ repo: repoUrl, dir: pluginDir }, "PluginManager: cloning");
      execSync(`git clone ${repoUrl} ${pluginDir}`, { timeout: 60000 });

      // Update settings
      const settings = loadSettings();
      if (!settings.plugins) settings.plugins = {};
      settings.plugins[name] = {
        repo,
        path: pluginDir,
        enabled: true,
        branch: "main",
      };
      saveSettings(settings);

      // Load immediately
      await this.loadPlugin(name, settings.plugins[name]);
      this.updateHud();

      const loaded = this.plugins.get(name);
      return { ok: true, name, ...loaded ? { tools: loaded.tools.length, description: loaded.manifest.description } : {} };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  private async update(name: string): Promise<{ ok: boolean; error?: string }> {
    const plugin = this.plugins.get(name);
    if (!plugin) return { ok: false, error: `Plugin not found: ${name}` };

    try {
      const dir = plugin.settings.path;
      execSync(`git -C "${dir}" pull`, { timeout: 30000 });

      // Rebuild: run npm install if package.json exists (picks up new/changed deps)
      const pkgPath = join(dir, "package.json");
      if (existsSync(pkgPath)) {
        const npmrcPath = join(dir, ".npmrc");
        const npmrcFlag = existsSync(npmrcPath) ? ` --userconfig "${npmrcPath}"` : "";
        log.info({ name }, "PluginManager: running npm install after update");
        execSync(`npm install${npmrcFlag}`, { cwd: dir, timeout: 60000 });
      }

      // Reload
      this.plugins.delete(name);
      await this.loadPlugin(name, plugin.settings);
      this.updateHud();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  private async remove(name: string): Promise<{ ok: boolean; error?: string }> {
    // Stop plugin pieces and collect their IDs for settings cleanup
    const loaded = this.plugins.get(name);
    const pieceIds: string[] = loaded ? [...loaded.pieces] : [];
    if (loaded && this.pieceManager) {
      for (const pieceId of pieceIds) {
        await this.pieceManager.unregisterDynamic(pieceId);
      }
    }

    const settings = loadSettings();
    const ps = settings.plugins?.[name];

    // Delete the plugin directory
    const dir = loaded?.settings.path ?? ps?.path;
    if (dir && existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }

    // Remove from in-memory map
    this.plugins.delete(name);

    // Remove plugin + its pieces from BOTH settings files
    removeKey("plugins", name);
    for (const pieceId of pieceIds) {
      removeKey("pieces", pieceId);
    }

    this.updateHud();
    return { ok: true };
  }

  private registerTools(): void {
    this.registry.register({
      name: "plugin_install",
      category: "plugins",
      description: "Install a JARVIS plugin from a GitHub repo. Clones to ~/.jarvis/plugins/ and loads tools/prompts. IMPORTANT: Installation is NOT considered successful until the relevant functional tests from functional-test.md have been executed and pass. After calling this tool, you MUST read the plugin's functional-test.md and execute ALL BDD scenarios — every single one, no exceptions, no skipping.",
      input_schema: {
        type: "object",
        properties: { repo: { type: "string", description: "GitHub repo (e.g. 'github.com/user/jarvis-plugin-test')" } },
        required: ["repo"],
      },
      handler: async (input) => this.install(String(input.repo)),
    });

    this.registry.register({
      name: "plugin_list",
      category: "plugins",
      description: "List all installed JARVIS plugins.",
      input_schema: { type: "object", properties: {} },
      handler: async () => {
        const settings = loadSettings();
        return {
          installed: [...this.plugins.values()].map(p => ({
            name: p.name,
            description: p.manifest.description,
            version: p.manifest.version,
            tools: p.tools,
            prompts: p.prompts.length,
            enabled: p.settings.enabled,
            path: p.settings.path,
          })),
          available: Object.entries(settings.plugins ?? {})
            .filter(([n]) => !this.plugins.has(n))
            .map(([n, ps]) => ({ name: n, enabled: ps.enabled, path: ps.path })),
        };
      },
    });

    this.registry.register({
      name: "plugin_update",
      category: "plugins",
      description: "Update a plugin by pulling latest from git.",
      input_schema: {
        type: "object",
        properties: { name: { type: "string", description: "Plugin name" } },
        required: ["name"],
      },
      handler: async (input) => this.update(String(input.name)),
    });

    this.registry.register({
      name: "plugin_enable",
      category: "plugins",
      description: "Enable a disabled plugin.",
      input_schema: {
        type: "object",
        properties: { name: { type: "string", description: "Plugin name" } },
        required: ["name"],
      },
      handler: async (input) => {
        const name = String(input.name);
        const settings = loadSettings();
        if (!settings.plugins?.[name]) return { ok: false, error: `Plugin not found: ${name}` };
        settings.plugins[name].enabled = true;
        saveSettings(settings);
        await this.loadPlugin(name, settings.plugins[name]);
        this.updateHud();
        return { ok: true };
      },
    });

    this.registry.register({
      name: "plugin_disable",
      category: "plugins",
      description: "Disable an installed plugin (keeps files, stops loading).",
      input_schema: {
        type: "object",
        properties: { name: { type: "string", description: "Plugin name" } },
        required: ["name"],
      },
      handler: async (input) => {
        const name = String(input.name);
        const settings = loadSettings();
        if (!settings.plugins?.[name]) return { ok: false, error: `Plugin not found: ${name}` };

        // Stop plugin pieces
        const loaded = this.plugins.get(name);
        if (loaded && this.pieceManager) {
          for (const pieceId of loaded.pieces) {
            await this.pieceManager.unregisterDynamic(pieceId);
          }
        }

        settings.plugins[name].enabled = false;
        saveSettings(settings);
        this.plugins.delete(name);
        this.updateHud();
        return { ok: true };
      },
    });

    this.registry.register({
      name: "plugin_remove",
      category: "plugins",
      description: "Remove a plugin completely (deletes files and settings).",
      input_schema: {
        type: "object",
        properties: { name: { type: "string", description: "Plugin name" } },
        required: ["name"],
      },
      handler: async (input) => this.remove(String(input.name)),
    });
  }

  // ─── Version Check ────────────────────────────────────────

  private async checkPluginVersions(): Promise<void> {
    const outdated: string[] = [];
    const errors: string[] = [];

    for (const [name, plugin] of this.plugins) {
      const dir = plugin.settings.path;
      if (!dir || !existsSync(join(dir, ".git"))) continue;

      try {
        // Fetch latest without modifying working tree
        execSync(`git -C "${dir}" fetch --quiet 2>/dev/null`, { timeout: 15000 });
        const local = execSync(`git -C "${dir}" rev-parse HEAD`, { timeout: 5000 }).toString().trim();
        const remote = execSync(`git -C "${dir}" rev-parse @{u}`, { timeout: 5000 }).toString().trim();

        if (local !== remote) {
          const behind = parseInt(execSync(`git -C "${dir}" rev-list HEAD..@{u} --count`, { timeout: 5000 }).toString().trim(), 10);
          if (behind > 0) {
            outdated.push(`${name} (${behind} commits behind)`);
          }
        }
      } catch (err: any) {
        // No remote / no upstream — skip silently (local-only plugins)
        if (!String(err).includes("no upstream")) {
          errors.push(`${name}: ${String(err.message ?? err).slice(0, 80)}`);
        }
      }
    }

    // Check jarvis-app itself
    try {
      const appDir = join(import.meta.dirname, "..", "..");
      if (existsSync(join(appDir, ".git"))) {
        execSync(`git -C "${appDir}" fetch --quiet 2>/dev/null`, { timeout: 15000 });
        const local = execSync(`git -C "${appDir}" rev-parse HEAD`, { timeout: 5000 }).toString().trim();
        const remote = execSync(`git -C "${appDir}" rev-parse @{u}`, { timeout: 5000 }).toString().trim();
        if (local !== remote) {
          const behind = parseInt(execSync(`git -C "${appDir}" rev-list HEAD..@{u} --count`, { timeout: 5000 }).toString().trim(), 10);
          if (behind > 0) outdated.unshift(`jarvis-app (${behind} commits behind)`);
        }
      }
    } catch {
      // ignore — no remote or detached HEAD
    }

    if (outdated.length > 0) {
      const msg = `[SYSTEM] Plugin version check: updates available for ${outdated.join(", ")}. Use plugin_update to update, or git pull for jarvis-app.`;
      this.bus.publish({
        channel: "ai.request",
        source: this.id,
        target: DEFAULT_SESSION,
        text: msg,
      });
      log.info({ outdated }, "PluginManager: outdated plugins found");
    } else {
      log.info("PluginManager: all plugins up to date");
    }
  }

  // ─── HUD ──────────────────────────────────────────────────

  private getData(): Record<string, unknown> {
    return {
      count: this.plugins.size,
      plugins: [...this.plugins.values()].map(p => ({ name: p.name, tools: p.tools.length })),
    };
  }

  private updateHud(): void {
    this.bus.publish({
      channel: "hud.update",
      source: this.id,
      action: "update",
      pieceId: this.id,
      data: this.getData(),
    });
    this.updateGraphChildren();
  }

  private updateGraphChildren(): void {
    graphRegistry.update(this.id, { meta: { plugins: this.plugins.size } });
    graphRegistry.setChildren(this.id, () => [...this.plugins.values()].map(p => ({
      id: `plugin-${p.name}`,
      label: p.name.replace(/^jarvis-plugin-/, ""),
      status: "running",
      meta: { tools: p.tools.length, pieces: p.pieces.length, version: p.manifest.version },
    })));
  }
}
