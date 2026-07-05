// src/core/settings.ts
// Two-layer settings: default (committed) + user (local, gitignored)
// load() merges them: user overrides default. save() writes to user only.
// Uses in-memory cache with mtime check — avoids re-reading disk on every call.
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { log } from "../logger/index.js";
import { jarvisHome } from "./paths.js";

export interface PieceSettings {
  enabled: boolean;
  visible: boolean;
}

export interface PieceConfig {
  [key: string]: unknown;
}

export interface PluginSettings {
  repo: string;
  path: string;
  enabled: boolean;
  branch: string;
}

export interface ProviderSettings {
  apiKey?: string;
  baseUrl?: string;
}

export interface CompactionSettings {
  enabled: boolean;
  thresholdPercent: number;
  instructions: string;
  pauseAfterCompaction: boolean;
  /** Max tokens for the summarizer output, expressed as a percentage of the
   *  context being compacted (tokensBefore). Applied as:
   *    Math.min(tokensBefore * summaryBudgetPercent / 100, getMaxOutput(model))
   *  Default: 10 (10% of context). Increase if summaries are too thin.
   *  The old hardcoded value was 8192 — for a 200K session that was ~4%. */
  summaryBudgetPercent: number;
}

export interface PersistedCronJob {
  cron: string;
  prompt: string;
  target: string;
  recurring: boolean;
  createdAt: number;
  lastRun?: number; // epoch ms of last execution
  // delegate mode fields (optional)
  mode?: "prompt" | "delegate";
  role?: string;
  model?: string;
  reply_to?: string;
  // catch-up: if true, runs immediately when a missed execution is detected on restore
  catchUp?: boolean;
}

export interface CronSettings {
  jobs: Record<string, PersistedCronJob>;
}

export interface Settings {
  pieces: Record<string, PieceSettings & { config?: PieceConfig }>;
  plugins?: Record<string, PluginSettings>;
  providers?: Record<string, ProviderSettings>;
  model?: string;
  compaction?: CompactionSettings;
  theme?: string; // active theme name (maps to ~/.jarvis/themes/<name>/theme.json)
  cron?: CronSettings;
  /** Delegate worker defaults (delegate_read_task, cron delegate mode).
   *  defaultRole: role id from ~/.jarvis/roles/ used when the caller omits
   *  one. Personal/site-specific roles belong in settings.user.json — the
   *  code fallback is the stack-agnostic "generic" role (F3.13: the old
   *  hardcoded default leaked a personal role name into core). */
  delegate?: { defaultRole?: string };
}

const SETTINGS_DIR = jarvisHome();
const DEFAULT_PATH = join(SETTINGS_DIR, "settings.json");
const USER_PATH = join(SETTINGS_DIR, "settings.user.json");

const PROTECTED_PIECES = new Set(["jarvis-core", "capability-executor", "capability-loader", "chat"]);

export function isProtected(pieceId: string): boolean {
  return PROTECTED_PIECES.has(pieceId);
}

export function getDefault(): PieceSettings {
  return { enabled: true, visible: true };
}

// ─── In-memory cache ──────────────────────────────────────────────────────────
// Avoids re-reading and re-parsing JSON on every load() call.
// Validates cache using file mtime — if disk changed, re-reads.

interface SettingsCache {
  settings: Settings;
  defaultMtime: number;
  userMtime: number;
}

let cache: SettingsCache | null = null;

function getMtime(path: string): number {
  try {
    if (!existsSync(path)) return 0;
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function loadFile(path: string): Settings {
  try {
    if (!existsSync(path)) return { pieces: {} };
    const content = readFileSync(path, "utf-8");
    return JSON.parse(content) as Settings;
  } catch {
    return { pieces: {} };
  }
}

const DEFAULT_COMPACTION: CompactionSettings = {
  enabled: true,
  thresholdPercent: 83.5,
  instructions: [
    "Produce a structured summary with the following sections:",
    "## Current State",
    "What is being worked on RIGHT NOW and where it stands (branch, PR, last action taken).",
    "## Key Decisions",
    "Architecture choices, approach decisions, and rationale made during this session.",
    "## Code & Outputs",
    "Exact file paths modified, function/variable names, key code snippets, and relevant tool outputs (command results, API responses, error messages). Preserve these verbatim — do NOT paraphrase code.",
    "## Open Issues",
    "Bugs, blockers, warnings, or unresolved questions that came up.",
    "## Next Steps",
    "What the user asked to do next or what logically follows from the current state.",
    "Be as specific and dense as possible. Prefer concrete details over narrative prose. Omit pleasantries and meta-commentary.",
  ].join("\n"),
  pauseAfterCompaction: true,
  summaryBudgetPercent: 10,
};

function mergeSections<T>(
  base: Record<string, T> | undefined,
  override: Record<string, T> | undefined,
): Record<string, T> {
  const result = { ...base } as Record<string, T>;
  for (const [key, val] of Object.entries(override ?? {})) {
    result[key] = { ...result[key] as any, ...val as any } as T;
  }
  return result;
}

/**
 * FIELD-EXPLICIT merge of the two settings layers (default + user).
 *
 * ⚠️ MAINTENANCE TRAP: this is NOT a generic deep merge — every top-level
 * Settings field MUST be listed here explicitly or it is silently DROPPED
 * from load() even when present in the JSON files. Proven in production:
 * `delegate` was added to the interface (F3.13) but not here, so the user's
 * settings.user.json value vanished (caught in F3 live validation,
 * 2026-06-11). When adding a field to `Settings`, add it here AND to
 * settings-merge.test.ts.
 *
 * Exported for unit tests only — not part of any public plugin API.
 */
export function deepMerge(base: Settings, override: Settings): Settings {
  return {
    pieces: mergeSections(base.pieces, override.pieces),
    plugins: mergeSections(base.plugins, override.plugins),
    providers: { ...base.providers, ...override.providers },
    model: override.model ?? base.model,
    compaction: override.compaction
      ? { ...DEFAULT_COMPACTION, ...base.compaction, ...override.compaction }
      : base.compaction,
    theme: override.theme ?? base.theme,
    cron: {
      jobs: { ...base.cron?.jobs, ...override.cron?.jobs },
    },
    delegate: override.delegate ?? base.delegate,
  };
}

export function load(): Settings {
  const defaultMtime = getMtime(DEFAULT_PATH);
  const userMtime = getMtime(USER_PATH);

  if (cache && cache.defaultMtime === defaultMtime && cache.userMtime === userMtime) {
    return cache.settings;
  }

  const defaults = loadFile(DEFAULT_PATH);
  const user = loadFile(USER_PATH);
  const merged = deepMerge(defaults, user);

  cache = { settings: merged, defaultMtime, userMtime };

  log.debug({
    defaultPath: DEFAULT_PATH,
    userPath: USER_PATH,
    hasUser: existsSync(USER_PATH),
    pieceCount: Object.keys(merged.pieces).length,
    cacheHit: false,
  }, "Settings: loaded from disk");

  return merged;
}

/** Invalidate in-memory cache — forces next load() to re-read from disk */
export function invalidateCache(): void {
  cache = null;
}

export function save(settings: Settings): void {
  try {
    if (!existsSync(SETTINGS_DIR)) {
      mkdirSync(SETTINGS_DIR, { recursive: true });
    }
    // Always save to user file — default is committed to repo
    writeFileSync(USER_PATH, JSON.stringify(settings, null, 2) + "\n");
    // Update cache immediately so subsequent load() sees the new state
    // without waiting for the next mtime check
    const defaultMtime = getMtime(DEFAULT_PATH);
    const userMtime = getMtime(USER_PATH);
    cache = { settings, defaultMtime, userMtime };
    log.debug({ path: USER_PATH }, "Settings: saved (user)");
  } catch (err) {
    log.error({ err }, "Settings: failed to save");
  }
}

/**
 * Remove a key from a specific section in BOTH settings files (default + user).
 * Use for destructive operations like plugin_remove that must not survive a merge.
 */
export function removeKey(section: "plugins" | "pieces", key: string): void {
  try {
    // Remove from default file
    if (existsSync(DEFAULT_PATH)) {
      const defaults = loadFile(DEFAULT_PATH);
      const sectionObj = defaults[section] as Record<string, unknown> | undefined;
      if (sectionObj && key in sectionObj) {
        delete sectionObj[key];
        writeFileSync(DEFAULT_PATH, JSON.stringify(defaults, null, 2) + "\n");
        log.debug({ path: DEFAULT_PATH, section, key }, "Settings: removed key from defaults");
      }
    }

    // Remove from user file
    if (existsSync(USER_PATH)) {
      const user = loadFile(USER_PATH);
      const sectionObj = user[section] as Record<string, unknown> | undefined;
      if (sectionObj && key in sectionObj) {
        delete sectionObj[key];
        writeFileSync(USER_PATH, JSON.stringify(user, null, 2) + "\n");
        log.debug({ path: USER_PATH, section, key }, "Settings: removed key from user");
      }
    }

    // Invalidate cache so next load() re-reads from disk
    cache = null;
  } catch (err) {
    log.error({ err, section, key }, "Settings: failed to remove key");
  }
}

export function getCompactionSettings(settings: Settings): CompactionSettings {
  return { ...DEFAULT_COMPACTION, ...settings.compaction };
}

export function getPieceSettings(settings: Settings, pieceId: string): PieceSettings {
  return settings.pieces[pieceId] ?? getDefault();
}

export function setPieceSettings(settings: Settings, pieceId: string, update: Partial<PieceSettings>): Settings {
  const current = getPieceSettings(settings, pieceId);
  settings.pieces[pieceId] = { ...current, ...update };
  return settings;
}
