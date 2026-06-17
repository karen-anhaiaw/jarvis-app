// src/core/paths.ts
// Single source of truth for all ~/.jarvis/ paths.
//
// Override via JARVIS_HOME env var (useful for tests or multi-instance setups).
// Default: ~/.jarvis/
//
// Usage:
//   import { jarvisHome, jarvisPath } from "./paths.js";
//   const settingsDir = jarvisHome();          // ~/.jarvis
//   const logDir = jarvisPath("logs");         // ~/.jarvis/logs

import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Returns the root JARVIS config directory.
 * Defaults to ~/.jarvis — override with JARVIS_HOME env var.
 */
export function jarvisHome(): string {
  return process.env.JARVIS_HOME ?? join(homedir(), ".jarvis");
}

/**
 * Returns a path inside the JARVIS config directory.
 * Equivalent to join(jarvisHome(), ...segments).
 */
export function jarvisPath(...segments: string[]): string {
  return join(jarvisHome(), ...segments);
}
