// src/core/bootstrap.ts
//
// Runtime bootstrap — runs on every JARVIS boot.
//
// INVARIANT (Sir, 2026-07-29): ~/.jarvis/ holds ALL runtime state.
// jarvis-app/ is source code only. Nothing here touches process.cwd()
// or process.env.HOME — only os.homedir() and explicit arguments.
//
// Two categories of files:
//   SHIPPED DEFAULTS  — overwritten on every boot so upgrades propagate.
//                       (settings.json, jarvis-system.md)
//   USER-OWNED        — created once as template; never overwritten.
//                       (settings.user.json, mcp.json, secrets/)
//
// All I/O uses node:fs APIs only — no shell, no cp, no openssl.
// Safe to call multiple times (idempotent).

import { mkdirSync, existsSync, copyFileSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface BootstrapOptions {
  /** Target ~/.jarvis directory (or JARVIS_HOME override). */
  jarvisHome: string;
  /** Root of the jarvis-app source tree (where .jarvis/ and jarvis-system.md live). */
  sourceRoot: string;
}

export interface BootstrapReport {
  /** Shipped defaults that could not be found under sourceRoot. */
  missing: string[];
}

/** File whose presence identifies the source root. */
const SOURCE_ROOT_MARKER = "jarvis-system.md";

/**
 * Walks up from `startDir` looking for the directory that actually contains
 * SOURCE_ROOT_MARKER. Returns null when no ancestor has it.
 *
 * WHY THIS EXISTS
 *   main.ts previously derived the source root with a hardcoded depth:
 *     pathJoin(__dirname, "..", "..")   // "two levels up from src/core/"
 *   but main.ts lives in src/, not src/core/ — so it resolved to the repository
 *   root, one level above app/, where jarvis-system.md actually lives. The copy
 *   in bootstrap() is guarded by existsSync, so it silently did nothing and
 *   ~/.jarvis/jarvis-system.md was never created, on any platform.
 *
 *   Hardcoded depths break whenever a file moves and fail quietly. Searching
 *   for the marker cannot drift: it is correct from src/, from src/core/, and
 *   from the root itself.
 */
export function resolveSourceRoot(startDir: string, maxLevels = 6): string | null {
  let dir = startDir;
  for (let i = 0; i < maxLevels; i++) {
    if (existsSync(join(dir, SOURCE_ROOT_MARKER))) return dir;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export async function bootstrap({ jarvisHome, sourceRoot }: BootstrapOptions): Promise<BootstrapReport> {
  const missing: string[] = [];
  // ── 1. Create core directory structure ──────────────────────────────────
  for (const dir of ["sessions", "logs", "certs", "oauth", "plugins"]) {
    mkdirSync(join(jarvisHome, dir), { recursive: true });
  }

  // ── 2. Shipped defaults — overwrite on every boot (upgrade propagation) ─
  // A shipped default that cannot be found is recorded, never swallowed —
  // silent skipping is what hid the broken sourceRoot for so long.
  const shipped: Array<{ label: string; src: string; dst: string }> = [
    {
      label: "settings.json",
      src: join(sourceRoot, ".jarvis", "settings.json"),
      dst: join(jarvisHome, "settings.json"),
    },
    {
      label: SOURCE_ROOT_MARKER,
      src: join(sourceRoot, SOURCE_ROOT_MARKER),
      dst: join(jarvisHome, SOURCE_ROOT_MARKER),
    },
  ];

  for (const { label, src, dst } of shipped) {
    if (existsSync(src)) copyFileSync(src, dst);
    else missing.push(label);
  }

  // ── 3. User-owned files — create template only if absent ─────────────────
  const mcpPath = join(jarvisHome, "mcp.json");
  if (!existsSync(mcpPath)) {
    writeFileSync(mcpPath, JSON.stringify({ servers: {} }, null, 2) + "\n", "utf-8");
  }

  const userSettingsPath = join(jarvisHome, "settings.user.json");
  if (!existsSync(userSettingsPath)) {
    const template = {
      providers: {
        anthropic: { apiKey: "YOUR_ANTHROPIC_API_KEY" },
        openai: { baseUrl: "https://api.openai.com/v1", apiKey: "YOUR_OPENAI_API_KEY" },
      },
      model: "claude-sonnet-4-6",
    };
    writeFileSync(userSettingsPath, JSON.stringify(template, null, 2) + "\n", "utf-8");
  }

  return { missing };
}
