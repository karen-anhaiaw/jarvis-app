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
  /** Root of the jarvis-app source tree (where app/.jarvis/ and jarvis-system.md live). */
  sourceRoot: string;
}

export async function bootstrap({ jarvisHome, sourceRoot }: BootstrapOptions): Promise<void> {
  // ── 1. Create core directory structure ──────────────────────────────────
  for (const dir of ["sessions", "logs", "certs", "oauth", "plugins"]) {
    mkdirSync(join(jarvisHome, dir), { recursive: true });
  }

  // ── 2. Shipped defaults — overwrite on every boot (upgrade propagation) ─
  const shippedSettingsSrc = join(sourceRoot, ".jarvis", "settings.json");
  const shippedSettingsDst = join(jarvisHome, "settings.json");
  if (existsSync(shippedSettingsSrc)) {
    copyFileSync(shippedSettingsSrc, shippedSettingsDst);
  }

  const systemPromptSrc = join(sourceRoot, "jarvis-system.md");
  const systemPromptDst = join(jarvisHome, "jarvis-system.md");
  if (existsSync(systemPromptSrc)) {
    copyFileSync(systemPromptSrc, systemPromptDst);
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
}
