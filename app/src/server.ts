// src/server.ts
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";
import { homedir } from "node:os";
import { execSync, exec } from "node:child_process";
import type { ChatPiece } from "./input/chat-piece.js";
import { load as loadSettings, save as saveSettings } from "./core/settings.js";
import { log, getLogBuffer, onLogEntry } from "./logger/index.js";

const THEMES_DIR = join(homedir(), ".jarvis", "themes");

const UI_DIST = join(process.cwd(), "ui", "dist");
const UI_DIR = join(process.cwd(), "ui");

/**
 * Verify UI build integrity: parse index.html for asset references and check
 * they exist on disk. If any are missing, automatically rebuild the UI.
 * Call this at startup before serving any requests or launching Electron.
 */
export function ensureUiBuildIntegrity(): void {
  const indexPath = join(UI_DIST, "index.html");

  if (!existsSync(indexPath)) {
    log.warn("UI build integrity: index.html not found — triggering build");
    rebuildUi();
    return;
  }

  const html = readFileSync(indexPath, "utf-8");

  // Extract asset paths from src="/assets/..." and href="/assets/..."
  const assetRefs: string[] = [];
  const regex = /(?:src|href)="(\/assets\/[^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    assetRefs.push(match[1]); // e.g. "/assets/index-18E7RCLu.js"
  }

  if (assetRefs.length === 0) {
    log.warn("UI build integrity: no asset references found in index.html — triggering build");
    rebuildUi();
    return;
  }

  const missing = assetRefs.filter((ref) => {
    // ref is "/assets/filename", resolve relative to UI_DIST
    const absPath = join(UI_DIST, ref);
    return !existsSync(absPath);
  });

  if (missing.length > 0) {
    log.warn({ missing }, "UI build integrity: assets referenced in index.html are missing — triggering rebuild");
    rebuildUi();
  } else {
    log.info({ assets: assetRefs.length }, "UI build integrity: all assets present ✓");
  }
}

function rebuildUi(): void {
  log.info("UI build: running 'npm run build' in ui/ ...");
  try {
    execSync("npm run build", {
      cwd: UI_DIR,
      stdio: "inherit",
      timeout: 120_000, // 2 minute timeout
    });
    log.info("UI build: completed successfully ✓");
  } catch (err) {
    log.fatal({ err: String(err) }, "UI build: FAILED — HUD will not render correctly");
    // Don't crash the process — JARVIS can still operate via gRPC/chat
    // but the HUD will show a blank/broken page
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

type HudStateProvider = () => Record<string, unknown>;
type HudStreamHandler = (req: IncomingMessage, res: ServerResponse) => void;
type CapabilitiesProvider = () => Array<{ name: string; description: string; category?: string }>;
type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void;

export class HttpServer {
  private server: ReturnType<typeof createServer>;
  private port: number;
  private chatPiece: ChatPiece;
  private getHudState: HudStateProvider;
  private handleHudStream?: HudStreamHandler;
  private getCapabilities?: CapabilitiesProvider;
  private rendererCache = new Map<string, { js: string; mtime: number }>();
  private pluginRoutes = new Map<string, RouteHandler>();
  private onAbort?: (sessionId: string) => void;
  private onClearSession?: (sessionId: string) => void;
  private onCompact?: (sessionId: string) => Promise<void>;
  private onHudRemove?: (pieceId: string) => void;
  private onHudShow?: (pieceId: string) => void;
  private onHudHide?: (pieceId: string) => void;

  constructor(port: number, chatPiece: ChatPiece, getHudState: HudStateProvider, onAbort?: (sessionId: string) => void, getCapabilities?: CapabilitiesProvider) {
    this.port = port;
    this.chatPiece = chatPiece;
    this.getHudState = getHudState;
    this.getCapabilities = getCapabilities;
    this.onAbort = onAbort;
    this.server = createServer(this.handle.bind(this));
    this.server.listen(port, () => log.info({ port }, "HttpServer: listening"));
  }

  setOnClearSession(handler: (sessionId: string) => void): void {
    this.onClearSession = handler;
  }

  setOnCompact(handler: (sessionId: string) => Promise<void>): void {
    this.onCompact = handler;
  }

  setHudStreamHandler(handler: HudStreamHandler): void {
    this.handleHudStream = handler;
  }

  setOnHudRemove(handler: (pieceId: string) => void): void {
    this.onHudRemove = handler;
  }

  setOnHudShow(handler: (pieceId: string) => void): void {
    this.onHudShow = handler;
  }

  setOnHudHide(handler: (pieceId: string) => void): void {
    this.onHudHide = handler;
  }

  registerRoute(method: string, path: string, handler: RouteHandler): void {
    const key = `${method.toUpperCase()} ${path}`;
    this.pluginRoutes.set(key, handler);
    log.info({ method, path }, "HttpServer: plugin route registered");
  }

  get url(): string {
    return `http://localhost:${this.port}`;
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    // Required for ONNX Runtime WASM (SharedArrayBuffer)
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");

    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    // ─── Chat endpoints — sessionId required on every call ───
    if (req.url === "/chat/send" && req.method === "POST") {
      log.info("HttpServer: POST /chat/send");
      this.chatPiece.handleSend(req, res);
      return;
    }

    if (req.url === "/chat/abort" && req.method === "POST") {
      log.info("HttpServer: POST /chat/abort");
      this.handleSessionScopedAction(req, res, (sid) => {
        if (this.onAbort) this.onAbort(sid);
      });
      return;
    }

    if (req.url === "/chat/clear-session" && req.method === "POST") {
      log.info("HttpServer: POST /chat/clear-session");
      this.handleSessionScopedAction(req, res, (sid) => {
        if (this.onClearSession) this.onClearSession(sid);
      });
      return;
    }

    if (req.url === "/chat/compact" && req.method === "POST") {
      log.info("HttpServer: POST /chat/compact");
      this.handleSessionScopedAction(req, res, async (sid) => {
        if (this.onCompact) await this.onCompact(sid);
      });
      return;
    }

    if (req.url === "/chat/bash" && req.method === "POST") {
      log.info("HttpServer: POST /chat/bash");
      this.handleBash(req, res);
      return;
    }

    if (req.url?.startsWith("/chat-stream") && req.method === "GET") {
      this.chatPiece.handleStream(req, res);
      return;
    }

    if (req.url?.startsWith("/chat/history") && req.method === "GET") {
      this.chatPiece.handleHistory(req, res);
      return;
    }

    if (req.url?.startsWith("/chat/session-info") && req.method === "GET") {
      this.chatPiece.handleSessionInfo(req, res);
      return;
    }

    if (req.url === "/hud/hide" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try {
          const { pieceId } = JSON.parse(body);
          const settings = loadSettings();
          if (!settings.pieces[pieceId]) settings.pieces[pieceId] = { enabled: true, visible: true };
          settings.pieces[pieceId].visible = false;
          saveSettings(settings);
          this.onHudHide?.(pieceId);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400); res.end();
        }
      });
      return;
    }

    if (req.url === "/hud/show" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try {
          const { pieceId } = JSON.parse(body);
          const settings = loadSettings();
          if (!settings.pieces[pieceId]) settings.pieces[pieceId] = { enabled: true, visible: true };
          settings.pieces[pieceId].visible = true;
          saveSettings(settings);
          this.onHudShow?.(pieceId);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400); res.end();
        }
      });
      return;
    }

    // Remove an ephemeral panel from HudState (no settings persistence).
    // The piece can re-add itself with a new "add" action to reappear.
    if (req.url === "/hud/remove" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try {
          const { pieceId } = JSON.parse(body);
          this.onHudRemove?.(pieceId);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400); res.end();
        }
      });
      return;
    }

    // ── Detach / Reattach: proxy to Electron on :50053 + persist state ──
    if (req.url === "/hud/detach" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", async () => {
        try {
          const parsed = JSON.parse(body);
          const upstream = await fetch("http://localhost:50053/detach", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
          });
          const result = await upstream.text();
          // Persist detached state in settings
          if (upstream.ok && parsed.panelId) {
            const settings = loadSettings();
            const pid = parsed.panelId;
            if (!settings.pieces[pid]) settings.pieces[pid] = { enabled: true, visible: true };
            settings.pieces[pid].config = {
              ...settings.pieces[pid].config,
              detached: true,
              detachedLayout: parsed.width || parsed.height ? {
                width: parsed.width ?? 600,
                height: parsed.height ?? 400,
              } : settings.pieces[pid].config?.detachedLayout,
            };
            saveSettings(settings);
          }
          res.writeHead(upstream.status, { "Content-Type": "application/json" });
          res.end(result);
        } catch (e) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(e) }));
        }
      });
      return;
    }

    if (req.url === "/hud/reattach" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", async () => {
        try {
          const parsed = JSON.parse(body);
          const upstream = await fetch("http://localhost:50053/reattach", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
          });
          const result = await upstream.text();
          // Clear detached state in settings
          if (upstream.ok && parsed.panelId) {
            const settings = loadSettings();
            const pid = parsed.panelId;
            if (settings.pieces[pid]?.config) {
              settings.pieces[pid].config.detached = false;
              saveSettings(settings);
            }
          }
          res.writeHead(upstream.status, { "Content-Type": "application/json" });
          res.end(result);
        } catch (e) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(e) }));
        }
      });
      return;
    }

    // Save detached window position/size
    if (req.url === "/hud/detach-layout" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try {
          const { panelId, x, y, width, height } = JSON.parse(body);
          const settings = loadSettings();
          if (!settings.pieces[panelId]) settings.pieces[panelId] = { enabled: true, visible: true };
          settings.pieces[panelId].config = {
            ...settings.pieces[panelId].config,
            detachedLayout: { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) },
          };
          saveSettings(settings);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400); res.end();
        }
      });
      return;
    }

    // List detached panels (for Electron startup)
    if (req.url === "/hud/detached" && req.method === "GET") {
      const settings = loadSettings();
      const detached: Array<{ panelId: string; title: string; x?: number; y?: number; width?: number; height?: number }> = [];
      for (const [pid, piece] of Object.entries(settings.pieces)) {
        const cfg = piece.config as any;
        if (cfg?.detached) {
          detached.push({
            panelId: pid,
            title: piece.config?.detachedTitle as string ?? pid.toUpperCase(),
            ...cfg.detachedLayout,
          });
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(detached));
      return;
    }

    if (req.url === "/hud/layout" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try {
          const { pieceId, x, y, width, height } = JSON.parse(body);
          const settings = loadSettings();
          if (!settings.pieces[pieceId]) settings.pieces[pieceId] = { enabled: true, visible: true };
          settings.pieces[pieceId].config = {
            ...settings.pieces[pieceId].config,
            layout: { x, y, width, height },
          };
          saveSettings(settings);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400); res.end();
        }
      });
      return;
    }

    // ── Theme API ─────────────────────────────────────────────────────────────

    // GET /theme/active — returns active theme CSS vars as JSON
    if (req.url === "/theme/active" && req.method === "GET") {
      const settings = loadSettings();
      const themeName = settings.theme;
      if (!themeName) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ theme: null, vars: {} }));
        return;
      }
      const themePath = join(THEMES_DIR, themeName, "theme.json");
      if (!existsSync(themePath)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ theme: themeName, vars: {}, error: "theme file not found" }));
        return;
      }
      try {
        const theme = JSON.parse(readFileSync(themePath, "utf-8"));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ theme: themeName, vars: theme.vars ?? {} }));
      } catch {
        res.writeHead(500); res.end();
      }
      return;
    }

    // GET /theme/list — list all installed themes
    if (req.url === "/theme/list" && req.method === "GET") {
      const themes: Array<{ name: string; displayName?: string; description?: string; author?: string }> = [];
      if (existsSync(THEMES_DIR)) {
        for (const entry of readdirSync(THEMES_DIR, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const themePath = join(THEMES_DIR, entry.name, "theme.json");
          if (!existsSync(themePath)) continue;
          try {
            const theme = JSON.parse(readFileSync(themePath, "utf-8"));
            themes.push({
              name: entry.name,
              displayName: theme.name ?? entry.name,
              description: theme.description,
              author: theme.author,
            });
          } catch {
            themes.push({ name: entry.name });
          }
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ themes }));
      return;
    }

    // POST /theme/set — { name: string } — set active theme
    if (req.url === "/theme/set" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try {
          const { name } = JSON.parse(body);
          const settings = loadSettings();
          settings.theme = name ?? null;
          saveSettings(settings);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, theme: name }));
        } catch {
          res.writeHead(400); res.end();
        }
      });
      return;
    }

    if (req.url === "/capabilities") {
      const data = this.getCapabilities ? this.getCapabilities() : [];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
      return;
    }

    if (req.url === "/hud") {
      const data = this.getHudState();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
      return;
    }

    if (req.url === "/hud-stream") {
      if (this.handleHudStream) {
        this.handleHudStream(req, res);
      } else {
        res.writeHead(501, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "HUD stream not configured" }));
      }
      return;
    }

    if (req.url === "/logs") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
      for (const entry of getLogBuffer()) res.write(`data: ${JSON.stringify(entry)}\n\n`);
      const unsub = onLogEntry((entry) => res.write(`data: ${JSON.stringify(entry)}\n\n`));
      req.on("close", unsub);
      return;
    }

    // Plugin-registered routes (prefix match)
    for (const [key, handler] of this.pluginRoutes) {
      const spaceIdx = key.indexOf(" ");
      const method = key.slice(0, spaceIdx);
      const path = key.slice(spaceIdx + 1);
      if (req.method === method && req.url?.startsWith(path)) {
        handler(req, res);
        return;
      }
    }

    // Plugin renderer compilation endpoint
    // URL: /plugins/{name}/renderers/{file}.js[?v=cache-buster]
    // Strip query string before matching — the ?v= cache-buster must not
    // prevent the route from being recognised (endsWith(".js") fails otherwise).
    const reqPath = req.url?.split("?")[0] ?? "";
    if (reqPath.startsWith("/plugins/") && reqPath.endsWith(".js")) {
      const parts = reqPath.split("/");
      // parts = ["", "plugins", name, "renderers", "file.js"]
      if (parts.length === 5 && parts[3] === "renderers") {
        const pluginName = parts[2];
        const fileName = parts[4].replace(".js", ".tsx");
        this.servePluginRenderer(pluginName, fileName, res);
        return;
      }
    }

    // Static files
    const filePath = req.url === "/" || req.url === "" ? join(UI_DIST, "index.html") : join(UI_DIST, req.url!);
    if (existsSync(filePath)) {
      const ext = extname(filePath);
      res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
      res.end(readFileSync(filePath));
      return;
    }

    // SPA fallback
    const indexPath = join(UI_DIST, "index.html");
    if (existsSync(indexPath)) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(readFileSync(indexPath));
      return;
    }

    res.writeHead(404); res.end();
  }

  private async servePluginRenderer(pluginName: string, fileName: string, res: ServerResponse): Promise<void> {
    // "core" is a special plugin name — resolves to the built-in renderers directory.
    let filePath: string;
    if (pluginName === "core") {
      const coreRenderersDir = join(new URL(".", import.meta.url).pathname, "..", "ui", "src", "renderers");
      filePath = join(coreRenderersDir, fileName);
    } else {
      const settings = (await import("./core/settings.js")).load();
      const pluginPath = settings.plugins?.[pluginName]?.path;

      if (!pluginPath) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Plugin not found: ${pluginName}` }));
        return;
      }
      filePath = join(pluginPath, "renderers", fileName);
    }
    if (!existsSync(filePath)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Renderer not found: ${fileName}` }));
      return;
    }

    const cacheKey = `${pluginName}/${fileName}`;
    // Use the latest mtime across ALL files in the renderers dir so that
    // changes to imported sub-components (e.g. MemoryCard.tsx imported by
    // MnemosynePanel.tsx) invalidate the bundle for the entrypoint too.
    const rendererDir = filePath.replace(/[^/\\]+$/, "");
    let maxMtime = statSync(filePath).mtimeMs;
    try {
      const { readdirSync } = await import("fs");
      for (const f of readdirSync(rendererDir)) {
        try { const m = statSync(join(rendererDir, f)).mtimeMs; if (m > maxMtime) maxMtime = m; } catch { /* skip */ }
      }
    } catch { /* non-critical */ }
    const cached = this.rendererCache.get(cacheKey);

    if (cached && cached.mtime === maxMtime) {
      res.writeHead(200, { "Content-Type": "application/javascript", "Cache-Control": "no-store" });
      res.end(cached.js);
      return;
    }

    try {
      const esbuild = await import("esbuild");
      // Externalize React — the app exposes it via window globals
      const result = await esbuild.build({
        entryPoints: [filePath],
        bundle: true,
        format: "esm",
        target: "esnext",
        jsx: "transform",
        jsxFactory: "__jarvis_jsx",
        jsxFragment: "__jarvis_Fragment",
        write: false,
        external: ["@jarvis/core"],
        banner: {
          // The banner exposes React + HUD hooks as top-level identifiers
          // so plugin renderer code can use bare names (`createElement`,
          // `useState`, etc.). PROBLEM: when a renderer pulls in a heavy
          // third-party lib (e.g. neovis.js → vis-network), the bundled
          // output may itself contain a top-level `var createElement` from
          // that lib, which collides with our `const createElement` and
          // throws "Identifier 'createElement' has already been declared".
          //
          // Mitigation: use `var` (function-scoped, hoisted, redeclarable)
          // instead of `const`. If a bundled dep also declares a top-level
          // `var createElement`, both are merged into a single binding
          // hoisted to the top of the module — the dep's later assignment
          // wins for its internal scope, but the dep typically only uses
          // its own local references, not our bare `createElement`.
          //
          // For our own JSX factory we use a scoped alias `__jarvis_jsx`
          // captured BEFORE any later code runs (set as a `var` too, so
          // it survives any subsequent reassignment).
          js: `var __JARVIS_REACT__ = window.__JARVIS_REACT;\nvar __JARVIS_HUD__ = window.__JARVIS_HUD_HOOKS || {};\nvar createElement = __JARVIS_REACT__.createElement;\nvar Fragment = __JARVIS_REACT__.Fragment;\nvar useEffect = __JARVIS_REACT__.useEffect;\nvar useRef = __JARVIS_REACT__.useRef;\nvar useState = __JARVIS_REACT__.useState;\nvar useCallback = __JARVIS_REACT__.useCallback;\nvar useMemo = __JARVIS_REACT__.useMemo;\nvar useSyncExternalStore = __JARVIS_REACT__.useSyncExternalStore;\nvar __jarvis_jsx = __JARVIS_REACT__.createElement;\nvar __jarvis_Fragment = __JARVIS_REACT__.Fragment;\nvar useHudState = __JARVIS_HUD__.useHudState;\nvar useHudPiece = __JARVIS_HUD__.useHudPiece;\nvar useHudReactor = __JARVIS_HUD__.useHudReactor;`,
        },
      });

      const js = result.outputFiles[0].text;
      this.rendererCache.set(cacheKey, { js, mtime: maxMtime });

      res.writeHead(200, { "Content-Type": "application/javascript", "Cache-Control": "no-store" });
      res.end(js);
    } catch (err) {
      log.error({ pluginName, fileName, err: String(err) }, "HttpServer: renderer compilation failed");
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Compilation failed: ${err}` }));
    }
  }

  private handleBash(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => { chunks.push(Buffer.from(chunk)); });
    req.on("end", () => {
      let command = "";
      try {
        const body = Buffer.concat(chunks).toString("utf-8");
        const parsed = JSON.parse(body);
        command = String(parsed.command ?? "").trim();
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON body" }));
        return;
      }

      if (!command) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing command" }));
        return;
      }

      log.info({ command }, "HttpServer: running bash command");
      const startMs = Date.now();

      exec(command, { timeout: 30_000, shell: "/bin/bash" }, (err, stdout, stderr) => {
        const ms = Date.now() - startMs;
        const output = [stdout, stderr].filter(Boolean).join("\n").trimEnd();
        const exitCode = err?.code != null ? Number(err.code) : (err ? 1 : 0);

        log.info({ command, exitCode, ms }, "HttpServer: bash command done");

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, output, exitCode, ms }));

        // Bash is a global side-effect — broadcast to the root session only.
        // Actor/other-session bash would need its own endpoint carrying sessionId.
        this.chatPiece.broadcastEvent("main", {
          type: "bash_result",
          command,
          output,
          exitCode,
          ms,
          session: "main",
        });
      });
    });
  }

  /**
   * Helper for endpoints that take { sessionId } body and forward to a callback.
   * Returns 400 if sessionId is missing/empty. Accepts sync or async callbacks.
   */
  private handleSessionScopedAction(
    req: IncomingMessage,
    res: ServerResponse,
    action: (sessionId: string) => void | Promise<void>,
  ): void {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      let parsed: any;
      try { parsed = body ? JSON.parse(body) : {}; }
      catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Invalid JSON: ${e}` }));
        return;
      }
      const sid = typeof parsed.sessionId === "string" ? parsed.sessionId.trim() : "";
      if (!sid) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "sessionId is required" }));
        return;
      }
      try {
        await action(sid);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err?.message ?? String(err) }));
      }
    });
  }

  stop(): void { this.server.close(); }
}
