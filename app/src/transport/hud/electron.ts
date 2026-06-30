import { spawn } from "node:child_process";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../../logger/index.js";

export function launchHud(statusUrl: string): void {
  const electronMain = join(process.cwd(), "ui", "electron-main.cjs");

  writeFileSync(electronMain, `
const { app, BrowserWindow, screen, globalShortcut } = require('electron');
const http = require('http');
const https = require('https');
const url = require('url');
// Protocol-aware helpers — server uses HTTPS/h2 with self-signed cert.
// rejectUnauthorized:false is required for self-signed localhost cert.
const _tlsOpts = { rejectUnauthorized: false };
const nuGet = (u, cb) => (u.startsWith('https:') ? https : http).get(u, _tlsOpts, cb);
const nuRequest = (opts, cb) => {
  const mod = (opts.protocol === 'https:' || opts.port === 50052) ? https : http;
  return mod.request(Object.assign({}, opts, _tlsOpts), cb);
};

/**
 * Global hotkey for voice push-to-talk (toggle on/off).
 * Lives in main process — globalShortcut is unreachable from renderer.
 * Default: Shift+Space. Override via JARVIS_VOICE_HOTKEY env var.
 */
const VOICE_HOTKEY = process.env.JARVIS_VOICE_HOTKEY || 'Shift+Space';

let win;
const detachedWindows = new Map(); // panelId → BrowserWindow
const browserWindows = new Map(); // id → { win, partition }

function createBrowserWindow(id, url, partition) {
  const { session: electronSession } = require('electron');
  const ses = electronSession.fromPartition(partition || 'persist:jarvis-browser');

  // Grant all permissions for browser sessions
  ses.setPermissionRequestHandler((wc, permission, callback) => callback(true));

  const bwin = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    title: 'JARVIS Browser — ' + id,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      session: ses,
    },
  });

  bwin.once('ready-to-show', () => bwin.show());
  if (url) bwin.loadURL(url);

  bwin.on('closed', () => {
    browserWindows.delete(id);
    // notify Node server that window was closed
    const body = JSON.stringify({ id, event: 'closed' });
    const req = nuRequest({
      hostname: 'localhost', port: 50052,
      path: '/plugins/browser/event', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    });
    req.write(body); req.end(); req.on('error', () => {});
  });

  browserWindows.set(id, { win: bwin, partition: partition || 'persist:jarvis-browser' });
  return bwin;
}

// Set app name before ready so macOS Dock shows "JARVIS" instead of "Electron"
app.setName('JARVIS');

// Grant microphone permission for Web Speech API
app.commandLine.appendSwitch('ignore-certificate-errors');
app.commandLine.appendSwitch('enable-speech-dispatcher');

app.whenReady().then(() => {
  // Set dock icon
  const path = require('path');
  const iconPath = path.join(process.cwd(), 'ui', 'public', 'jarvis-icon.png');
  if (require('fs').existsSync(iconPath) && app.dock) {
    const { nativeImage } = require('electron');
    app.dock.setIcon(nativeImage.createFromPath(iconPath));
  }

  // Auto-grant media permissions (microphone)
  const { session } = require('electron');
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media' || permission === 'microphone') {
      callback(true);
    } else {
      callback(true);
    }
  });
  // Select display: JARVIS_DISPLAY env (index) or first external, or primary
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  const displayIndex = parseInt(process.env.JARVIS_DISPLAY ?? '', 10);
  const target = !isNaN(displayIndex) && displays[displayIndex]
    ? displays[displayIndex]
    : displays.find(d => d.id !== primary.id) ?? primary;

  // Restore saved window bounds if available; otherwise center on target display.
  let savedBounds = null;
  try {
    const savedResp = require('fs').readFileSync(require('path').join(require('os').homedir(), '.jarvis', 'settings.user.json'), 'utf-8');
    const savedSettings = JSON.parse(savedResp);
    if (savedSettings.window && typeof savedSettings.window.x === 'number') {
      savedBounds = savedSettings.window;
    }
  } catch (e) { /* no saved bounds */ }

  const winWidth  = savedBounds ? savedBounds.width  : Math.min(1920, target.bounds.width);
  const winHeight = savedBounds ? savedBounds.height : Math.min(1080, target.bounds.height);
  const winX = savedBounds ? savedBounds.x : target.bounds.x + Math.floor((target.bounds.width  - winWidth)  / 2);
  const winY = savedBounds ? savedBounds.y : target.bounds.y + Math.floor((target.bounds.height - winHeight) / 2);

  win = new BrowserWindow({
    x: winX,
    y: winY,
    width: winWidth,
    height: winHeight,
    frame: false,
    transparent: true,
    alwaysOnTop: false,
    resizable: true,
    show: false,               // hidden until ready-to-show — prevents transparent flash
    titleBarStyle: 'hidden',
    backgroundColor: '#0c1020', // matches --bg-body; fallback while CSS loads
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  // Show only when fully painted — eliminates the transparent-window flash on startup
  win.once('ready-to-show', () => {
    win.show();
  });

  // Persist main window position/size on move or resize (debounced 500ms).
  let saveWinBoundsTimer = null;
  const saveMainWindowBounds = () => {
    clearTimeout(saveWinBoundsTimer);
    saveWinBoundsTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      const b = win.getBounds();
      const postData = JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height });
      const req2 = nuRequest({ hostname: 'localhost', port: 50052, path: '/hud/window-bounds', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) } });
      req2.write(postData);
      req2.end();
      req2.on('error', () => {});
    }, 500);
  };
  win.on('moved', saveMainWindowBounds);
  win.on('resized', saveMainWindowBounds);

  // Hide instead of close — keeps the backend alive on macOS.
  // Cmd+Q still quits fully via the app menu.
  win.on('close', (e) => {
    if (!app.isQuiting) {
      e.preventDefault();
      win.hide();
    }
  });

  win.loadURL('${statusUrl}');

  // ── Global voice hotkey ──
  // Dispatches DOM CustomEvent 'jarvis:voice-toggle' inside the HUD when the
  // user presses VOICE_HOTKEY anywhere on the system. The VoiceRenderer
  // listens for this event and starts/stops MediaRecorder capture.
  try {
    const registered = globalShortcut.register(VOICE_HOTKEY, () => {
      if (!win || win.isDestroyed()) return;
      win.webContents.executeJavaScript(
        "window.dispatchEvent(new CustomEvent('jarvis:voice-toggle', { detail: { source: 'hotkey' } }));",
        true,
      ).catch(() => {});
    });
    if (registered) console.log('[hotkey] voice toggle registered:', VOICE_HOTKEY);
    else console.warn('[hotkey] failed to register', VOICE_HOTKEY, '— another app may own it');
  } catch (err) {
    console.error('[hotkey] register error:', err);
  }

  // Capture ALL renderer console messages — log via console so they appear in
  // the Electron process stdout (captured by the parent TS process below).
  // level: 0=verbose, 1=info, 2=warning, 3=error.
  win.webContents.on('console-message', (event, level, message) => {
    const msg = message.slice(0, 500);
    if (level >= 3)      console.error('[renderer]', msg);
    else if (level >= 2) console.warn('[renderer]', msg);
    else                 console.log('[renderer]', msg);
  });

  // Auto-reload when server comes back after restart
  win.webContents.on('did-fail-load', () => {
    setTimeout(() => win.loadURL('${statusUrl}'), 2000);
  });

  // ── Open external links in the default browser, not in Electron ──
  // Intercepts target="_blank" anchor clicks (setWindowOpenHandler) and any
  // navigation away from the local dev server (will-navigate). Both delegate
  // to shell.openExternal so the OS default browser handles the URL.
  // Applied to the main window here AND to every detached panel window
  // so links work identically wherever a panel lives.
  function attachExternalLinks(wc) {
    wc.setWindowOpenHandler(({ url: openUrl }) => {
      if (!openUrl.startsWith('https://localhost') && !openUrl.startsWith('http://localhost') && !openUrl.startsWith('file://')) {
        const { shell } = require('electron');
        shell.openExternal(openUrl).catch(() => {});
      }
      return { action: 'deny' };
    });
    wc.on('will-navigate', (event, navUrl) => {
      if (!navUrl.startsWith('https://localhost') && !navUrl.startsWith('http://localhost') && !navUrl.startsWith('file://')) {
        event.preventDefault();
        const { shell } = require('electron');
        shell.openExternal(navUrl).catch(() => {});
      }
    });
  }
  attachExternalLinks(win.webContents);

  // ── Detach panel: create a child BrowserWindow for a single panel ──
  function detachPanel(panelId, title, x, y, width, height) {
    if (detachedWindows.has(panelId)) {
      detachedWindows.get(panelId).focus();
      return;
    }

    // Position: center on the same display as main window
    const mainBounds = win.getBounds();
    const display = screen.getDisplayMatching(mainBounds);
    const w = width || 600;
    const h = height || 500;
    const cx = display.bounds.x + Math.floor((display.bounds.width - w) / 2);
    const cy = display.bounds.y + Math.floor((display.bounds.height - h) / 2);

    const child = new BrowserWindow({
      x: x ?? cx,
      y: y ?? cy,
      width: w,
      height: h,
      frame: false,
      transparent: false,
      alwaysOnTop: false,
      resizable: true,
      title: title || panelId,
      show: false,
      titleBarStyle: 'hidden',
      backgroundColor: '#0d1117',
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    child.loadURL('${statusUrl}?panel=' + encodeURIComponent(panelId));
    attachExternalLinks(child.webContents);
    child.once('ready-to-show', () => {
      child.show();
      // On macOS, child windows open behind transparent fullscreen parents.
      // Briefly set alwaysOnTop to force it in front, then release.
      child.setAlwaysOnTop(true, 'floating');
      child.focus();
      setTimeout(() => {
        if (!child.isDestroyed()) child.setAlwaysOnTop(false);
      }, 300);
    });
    // Save position/size on move or resize
    const saveDetachedLayout = () => {
      if (child.isDestroyed()) return;
      const b = child.getBounds();
      const postData = JSON.stringify({ panelId, x: b.x, y: b.y, width: b.width, height: b.height });
      const req2 = nuRequest({ hostname: 'localhost', port: 50052, path: '/hud/detach-layout', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) } });
      req2.write(postData);
      req2.end();
      req2.on('error', () => {});
    };
    child.on('moved', saveDetachedLayout);
    child.on('resized', saveDetachedLayout);

    child.on('closed', () => {
      detachedWindows.delete(panelId);
      // Notify main window so it can re-show the panel
      if (win && !win.isDestroyed()) {
        win.webContents.executeJavaScript(
          'window.dispatchEvent(new CustomEvent("panel-reattach", { detail: { panelId: "' + panelId + '" } }))'
        ).catch(() => {});
      }
      // Persist detached=false in settings so it won't auto-restore on next launch
        const postData = JSON.stringify({ panelId });
      const req3 = nuRequest({ hostname: 'localhost', port: 50052, path: '/hud/reattach', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) } });
      req3.write(postData);
      req3.end();
      req3.on('error', () => {});
    });
    detachedWindows.set(panelId, child);
  }

  // ── Auto-restore detached panels from previous session ──
  setTimeout(() => {
    nuGet('https://localhost:50052/hud/detached', (resp) => {
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => {
        try {
          const panels = JSON.parse(data);
          for (const p of panels) {
            detachPanel(p.panelId, p.title, p.x, p.y, p.width, p.height);
          }
        } catch (e) { /* ignore */ }
      });
    }).on('error', () => {});
  }, 2000); // Wait for server to be ready

  // Screenshot + info + detach server on port 50053
  http.createServer(async (req, res) => {
    const parsed = url.parse(req.url, true);

    if (parsed.pathname === '/info' && win) {
      const bounds = win.getBounds();
      const size = win.getContentSize();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ bounds, contentSize: size }));
      return;
    }
    if (parsed.pathname === '/screenshot' && win) {
      try {
        const image = await win.webContents.capturePage();
        const png = image.toPNG();
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
        res.end(png);
      } catch (err) {
        res.writeHead(500);
        res.end(String(err));
      }
      return;
    }
    if (parsed.pathname === '/reload' && win) {
      win.webContents.reload();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (parsed.pathname === '/detach' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const { panelId, title, x, y, width, height } = JSON.parse(body);
          detachPanel(panelId, title, x, y, width, height);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, panelId }));
        } catch (e) {
          res.writeHead(400);
          res.end(String(e));
        }
      });
      return;
    }
    if (parsed.pathname === '/reattach' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const { panelId } = JSON.parse(body);
          const child = detachedWindows.get(panelId);
          if (child && !child.isDestroyed()) child.close();
          detachedWindows.delete(panelId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, panelId }));
        } catch (e) {
          res.writeHead(400);
          res.end(String(e));
        }
      });
      return;
    }
    // ── Browser window management ──────────────────────────────────────

    // POST /browser/open  { id, url, partition? }
    if (parsed.pathname === '/browser/open' && req.method === 'POST') {
      let body = ''; req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const { id, url: burl, partition } = JSON.parse(body);
          if (browserWindows.has(id)) {
            const existing = browserWindows.get(id).win;
            if (!existing.isDestroyed()) existing.focus();
          } else {
            createBrowserWindow(id, burl, partition);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, id }));
        } catch(e) { res.writeHead(400); res.end(String(e)); }
      }); return;
    }

    // POST /browser/navigate  { id, url }
    if (parsed.pathname === '/browser/navigate' && req.method === 'POST') {
      let body = ''; req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const { id, url: burl } = JSON.parse(body);
          const entry = browserWindows.get(id);
          if (!entry || entry.win.isDestroyed()) throw new Error('Window not found: ' + id);
          entry.win.loadURL(burl);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch(e) { res.writeHead(400); res.end(String(e)); }
      }); return;
    }

    // GET /browser/screenshot/:id
    if (parsed.pathname.startsWith('/browser/screenshot/') && req.method === 'GET') {
      const id = decodeURIComponent(parsed.pathname.replace('/browser/screenshot/', ''));
      try {
        const entry = browserWindows.get(id);
        if (!entry || entry.win.isDestroyed()) throw new Error('Window not found: ' + id);
        const image = await entry.win.webContents.capturePage();
        // Resize to max 800px wide to keep base64 payload under ~100KB (≈1.3k tokens).
        // JPEG at quality 60 gives good readability with minimal size.
        const MAX_W = 800;
        const resized = image.getSize().width > MAX_W
          ? image.resize({ width: MAX_W })
          : image;
        const jpeg = resized.toJPEG(60);
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': jpeg.length });
        res.end(jpeg);
      } catch(e) { res.writeHead(400); res.end(String(e)); }
      return;
    }

    // POST /browser/eval  { id, js }
    if (parsed.pathname === '/browser/eval' && req.method === 'POST') {
      let body = ''; req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          const { id, js } = JSON.parse(body);
          const entry = browserWindows.get(id);
          if (!entry || entry.win.isDestroyed()) throw new Error('Window not found: ' + id);
          const result = await entry.win.webContents.executeJavaScript(js, true);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, result }));
        } catch(e) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: String(e) })); }
      }); return;
    }

    // GET /browser/list
    if (parsed.pathname === '/browser/list' && req.method === 'GET') {
      const list = [];
      for (const [id, entry] of browserWindows) {
        if (!entry.win.isDestroyed()) {
          list.push({ id, url: entry.win.webContents.getURL(), title: entry.win.getTitle() });
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, windows: list })); return;
    }

    // POST /browser/close  { id }
    if (parsed.pathname === '/browser/close' && req.method === 'POST') {
      let body = ''; req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const { id } = JSON.parse(body);
          const entry = browserWindows.get(id);
          if (entry && !entry.win.isDestroyed()) entry.win.close();
          browserWindows.delete(id);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch(e) { res.writeHead(400); res.end(String(e)); }
      }); return;
    }

    // POST /browser/cookies  { id, filter? }
    if (parsed.pathname === '/browser/cookies' && req.method === 'POST') {
      let body = ''; req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          const { id, filter } = JSON.parse(body);
          const entry = browserWindows.get(id);
          if (!entry || entry.win.isDestroyed()) throw new Error('Window not found: ' + id);
          const { session: es } = require('electron');
          const ses = es.fromPartition(entry.partition);
          const cookies = await ses.cookies.get(filter || {});
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, cookies }));
        } catch(e) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: String(e) })); }
      }); return;
    }

    // POST /browser/cookies-set  { partition, cookies: [{url, name, value, domain, path, secure, httpOnly, expirationDate}] }
    // Injects cookies directly into a partition's session (no window needed).
    if (parsed.pathname === '/browser/cookies-set' && req.method === 'POST') {
      let body = ''; req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          const { partition, cookies } = JSON.parse(body);
          const { session: es } = require('electron');
          const ses = es.fromPartition(partition || 'persist:jarvis-browser');
          let ok = 0, fail = 0;
          for (const cookie of cookies) {
            try {
              await ses.cookies.set(cookie);
              ok++;
            } catch(e) { fail++; }
          }
          await ses.cookies.flushStore();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, imported: ok, failed: fail }));
        } catch(e) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: String(e) })); }
      }); return;
    }

    // GET /open-url?url=<encoded> — open a URL in the OS default browser.
    // Used by plugin renderers that can't call shell.openExternal directly
    // (contextIsolation:true blocks Electron APIs from the renderer process).
    if (parsed.pathname === '/open-url' && req.method === 'GET') {
      // url.parse(req.url, true) exposes query params under .query (legacy API),
      // NOT .searchParams (WHATWG URL API). Using searchParams here always
      // yielded undefined -> empty target -> spurious 400 "invalid url".
      const rawUrl = parsed.query?.url;
      const target = Array.isArray(rawUrl) ? (rawUrl[0] ?? '') : (rawUrl ?? '');
      if (target.startsWith('http://') || target.startsWith('https://')) {
        const { shell } = require('electron');
        shell.openExternal(target).catch(() => {});
        res.writeHead(204); res.end();
      } else {
        res.writeHead(400); res.end('invalid url');
      }
      return;
    }

    res.writeHead(404);
    res.end();
  }).listen(50053);
});

app.on('before-quit', () => {
  app.isQuiting = true;
});

app.on('will-quit', () => {
  try { globalShortcut.unregisterAll(); } catch {}
});

// On macOS, closing the main window hides it instead of quitting the app.
// This keeps the Node backend alive so SSE connections, plugin sessions, cron jobs,
// and Slack hooks survive a "close". The user can reopen via the dock icon.
// To fully quit, use Cmd+Q or the app menu.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
  // On macOS: do nothing — keeps the process alive.
});

app.on('activate', () => {
  // Reopen/show the main window when the user clicks the dock icon.
  if (win && !win.isDestroyed()) {
    win.show();
  }
});
`);

  // Resolve the real Electron binary via path.txt (avoids spawning the node wrapper
  // script at node_modules/.bin/electron, which would create a second Dock icon).
  // The electron npm package always ships a path.txt with the relative path to the
  // actual binary inside Electron.app (e.g. "Electron.app/Contents/MacOS/Electron").
  const resolveElectronBinary = (): string => {
    const candidates = [
      join(process.cwd(), "node_modules", "electron"),
      join(process.cwd(), "..", "node_modules", "electron"),
    ];
    for (const dir of candidates) {
      const pathTxt = join(dir, "path.txt");
      const distDir = join(dir, "dist");
      if (existsSync(pathTxt) && existsSync(distDir)) {
        const relativeBin = readFileSync(pathTxt, "utf8").trim();
        return join(distDir, relativeBin);
      }
    }
    // Fallback: node wrapper (will show two Dock icons but still works)
    const localWrapper = join(process.cwd(), "node_modules", ".bin", "electron");
    const rootWrapper = join(process.cwd(), "..", "node_modules", ".bin", "electron");
    return existsSync(localWrapper) ? localWrapper : rootWrapper;
  };
  const electronPath = resolveElectronBinary();

  const child = spawn(electronPath, [electronMain], {
    // Pipe stdout/stderr so we can forward renderer logs to pino (log file).
    // stdin stays inherited (not needed but harmless to pipe too).
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Forward Electron stdout/stderr lines to pino so renderer console messages
  // (and any native Electron errors) land in the persistent log file.
  child.stdout?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      const t = line.trim();
      if (t) log.info({ electron: true }, t);
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      const t = line.trim();
      if (t) log.warn({ electron: true }, t);
    }
  });

  // Kill Electron when Node process exits
  process.on("exit", () => child.kill());
  process.on("SIGINT", () => child.kill());
  process.on("SIGTERM", () => child.kill());

  // Kill Node when Electron exits (user closed the window)
  child.on("exit", () => {
    log.info("Electron exited — shutting down JARVIS");
    process.exit(0);
  });

  log.info("HUD window launched (screenshot on :50053)");
}
