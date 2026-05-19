
const { app, BrowserWindow, screen } = require('electron');
const http = require('http');
const url = require('url');

let win;
const detachedWindows = new Map(); // panelId → BrowserWindow

// Grant microphone permission for Web Speech API
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

  // Size: 1920x1080 centered on target display
  const winWidth = Math.min(1920, target.bounds.width);
  const winHeight = Math.min(1080, target.bounds.height);
  const winX = target.bounds.x + Math.floor((target.bounds.width - winWidth) / 2);
  const winY = target.bounds.y + Math.floor((target.bounds.height - winHeight) / 2);

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

  win.loadURL('http://localhost:50052');

  // Capture ALL console messages for debugging
  win.webContents.on('console-message', (event, level, message) => {
    console.log('[E' + level + ']', message.slice(0, 300));
  });

  // Auto-reload when server comes back after restart
  win.webContents.on('did-fail-load', () => {
    setTimeout(() => win.loadURL('http://localhost:50052'), 2000);
  });

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
    child.loadURL('http://localhost:50052?panel=' + encodeURIComponent(panelId));
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
      const http2 = require('http');
      const postData = JSON.stringify({ panelId, x: b.x, y: b.y, width: b.width, height: b.height });
      const req2 = http2.request({ hostname: 'localhost', port: 50052, path: '/hud/detach-layout', method: 'POST',
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
      const http4 = require('http');
      const postData = JSON.stringify({ panelId });
      const req3 = http4.request({ hostname: 'localhost', port: 50052, path: '/hud/reattach', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) } });
      req3.write(postData);
      req3.end();
      req3.on('error', () => {});
    });
    detachedWindows.set(panelId, child);
  }

  // ── Auto-restore detached panels from previous session ──
  setTimeout(() => {
    const http3 = require('http');
    http3.get('http://localhost:50052/hud/detached', (resp) => {
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
    res.writeHead(404);
    res.end();
  }).listen(50053);
});

app.on('window-all-closed', () => app.quit());
