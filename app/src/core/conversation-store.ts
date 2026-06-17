// src/core/conversation-store.ts
// Persists conversation message history to disk for session recovery across restarts.
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, readdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { log } from "../logger/index.js";
import { jarvisPath } from "./paths.js";

export interface StoredConversation {
  /** Stable label for this session (e.g. "main" or any plugin-owned sessionId). */
  sessionId: string;
  /** Stable UUID for this session — sent as X-Claude-Code-Session-Id on every API call.
   *  Generated once on first save, preserved across restarts. */
  instanceId: string;
  provider: string;
  model: string;
  messages: unknown[];
  savedAt: string;
  messageCount: number;
}

const SESSIONS_DIR = jarvisPath("sessions");
const MAX_MESSAGES = 200; // Keep last N messages to avoid context overflow

function ensureDir(): void {
  if (!existsSync(SESSIONS_DIR)) {
    mkdirSync(SESSIONS_DIR, { recursive: true });
  }
}

function filePath(sessionLabel: string): string {
  // Sanitize label for filename
  const safe = sessionLabel.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(SESSIONS_DIR, `${safe}.json`);
}

/** Save conversation messages to disk */
export function saveConversation(
  sessionLabel: string,
  messages: unknown[],
  provider: string,
  model: string,
  instanceId?: string,
): void {
  try {
    ensureDir();
    // Trim to max messages (keep most recent), ensuring we start on a user message
    // to avoid orphaned assistant/tool_result messages at the start
    let trimmed = messages;
    if (messages.length > MAX_MESSAGES) {
      trimmed = messages.slice(messages.length - MAX_MESSAGES);
      // Walk forward to find the first user message to ensure valid conversation start
      const firstUserIdx = trimmed.findIndex((m: any) => m.role === "user");
      if (firstUserIdx > 0) {
        trimmed = trimmed.slice(firstUserIdx);
      }
    }

    // Preserve existing instanceId from disk if caller didn't provide one.
    // This ensures the UUID survives auto-saves that don't re-supply it.
    let stableId = instanceId;
    if (!stableId) {
      try {
        const existing = JSON.parse(readFileSync(filePath(sessionLabel), "utf-8")) as StoredConversation;
        stableId = existing.instanceId ?? (existing as any).apiSessionId; // migrate old field
      } catch { /* no existing file */ }
    }
    if (!stableId) stableId = crypto.randomUUID();

    const data: StoredConversation = {
      sessionId: sessionLabel,
      instanceId: stableId,
      provider,
      model,
      messages: trimmed,
      savedAt: new Date().toISOString(),
      messageCount: trimmed.length,
    };

    writeFileSync(filePath(sessionLabel), JSON.stringify(data, null, 2), "utf-8");
    log.debug({ sessionLabel, messageCount: trimmed.length }, "ConversationStore: saved");
  } catch (err) {
    log.error({ sessionLabel, err }, "ConversationStore: save failed");
  }
}

/** Load conversation messages from disk. Returns null if not found or incompatible. */
export function loadConversation(
  sessionLabel: string,
  expectedProvider: string,
): StoredConversation | null {
  try {
    const path = filePath(sessionLabel);
    if (!existsSync(path)) return null;

    const raw = readFileSync(path, "utf-8");
    const data: StoredConversation = JSON.parse(raw);

    // Don't restore if provider changed (message format differs between Anthropic/OpenAI)
    if (data.provider !== expectedProvider) {
      log.info(
        { sessionLabel, savedProvider: data.provider, currentProvider: expectedProvider },
        "ConversationStore: provider mismatch, discarding saved conversation",
      );
      return null;
    }

    log.info(
      { sessionLabel, messageCount: data.messageCount, savedAt: data.savedAt },
      "ConversationStore: loaded",
    );
    return data;
  } catch (err) {
    log.error({ sessionLabel, err }, "ConversationStore: load failed");
    return null;
  }
}

/** Clear saved conversation for a session */
export function clearConversation(sessionLabel: string): void {
  try {
    const path = filePath(sessionLabel);
    if (existsSync(path)) {
      unlinkSync(path);
      log.info({ sessionLabel }, "ConversationStore: cleared");
    }
  } catch (err) {
    log.error({ sessionLabel, err }, "ConversationStore: clear failed");
  }
}

// ─── Pre-compaction backup ──────────────────────────────────────────────

/** Newest backups kept per session label — older ones are pruned. */
const PRECOMPACT_KEEP = 5;

/**
 * Archive the FULL in-memory message history before compaction replaces it.
 *
 * WHY: compaction is the only operation that destroys history irreversibly.
 * On 2026-06-10 a forced compaction received an empty summary and replaced
 * 734k tokens of context with nothing — unrecoverable because nothing was
 * archived first. This backup makes that class of loss impossible.
 *
 * Contract:
 * - Does NOT trim to MAX_MESSAGES (unlike saveConversation) — the whole point
 *   is preserving exactly what compaction is about to discard.
 * - Returns false on any write failure. doCompact ABORTS compaction in that
 *   case: an oversized context is recoverable, destroyed history is not.
 * - Paths resolved lazily (no module-level const) so JARVIS_HOME set at
 *   runtime (tests) is respected.
 * - Prunes to the newest PRECOMPACT_KEEP backups per label (ISO timestamps
 *   sort lexicographically = chronologically).
 */
export function archivePreCompactBackup(sessionLabel: string, messages: unknown[]): boolean {
  try {
    const archiveDir = jarvisPath("sessions", "archive");
    if (!existsSync(archiveDir)) {
      mkdirSync(archiveDir, { recursive: true });
    }
    const safe = sessionLabel.replace(/[^a-zA-Z0-9_-]/g, "_");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = join(archiveDir, `${safe}_precompact_${stamp}.json`);
    writeFileSync(
      path,
      JSON.stringify(
        {
          sessionId: sessionLabel,
          archivedAt: new Date().toISOString(),
          reason: "pre-compaction backup",
          messageCount: messages.length,
          messages,
        },
        null,
        2,
      ),
      "utf-8",
    );

    // Prune older backups for this label only.
    const prefix = `${safe}_precompact_`;
    const backups = readdirSync(archiveDir)
      .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
      .sort();
    for (const f of backups.slice(0, Math.max(0, backups.length - PRECOMPACT_KEEP))) {
      try {
        unlinkSync(join(archiveDir, f));
      } catch {
        /* best-effort prune — never fail the backup over it */
      }
    }

    log.info({ sessionLabel, path, messageCount: messages.length }, "ConversationStore: pre-compaction backup written");
    return true;
  } catch (err) {
    log.error({ sessionLabel, err }, "ConversationStore: pre-compaction backup FAILED");
    return false;
  }
}

// ─── Route state (ModelRouter sticky per session) ──────────────────────
// Stored separately from the conversation file. Conversation gets trimmed
// to MAX_MESSAGES, archived, restored across providers — route state has
// different lifecycle. Filename: <label>.route.json.

interface StoredRoute {
  sessionId: string;
  sticky: string;
  switchCount: number;
  lastSwitchAt?: number;
  lastReason?: string;
  savedAt: string;
}

function routeFilePath(sessionLabel: string): string {
  const safe = sessionLabel.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(SESSIONS_DIR, `${safe}.route.json`);
}

/**
 * Save the ModelRouter route state for a session.
 * Idempotent. Failures are swallowed — never break a turn because of route I/O.
 */
export function saveRouteState(
  sessionLabel: string,
  route: { sticky: string; switchCount: number; lastSwitchAt?: number; lastReason?: string },
): void {
  try {
    ensureDir();
    const data: StoredRoute = {
      sessionId: sessionLabel,
      sticky: route.sticky,
      switchCount: route.switchCount,
      lastSwitchAt: route.lastSwitchAt,
      lastReason: route.lastReason,
      savedAt: new Date().toISOString(),
    };
    writeFileSync(routeFilePath(sessionLabel), JSON.stringify(data, null, 2), "utf-8");
    log.debug({ sessionLabel, sticky: route.sticky }, "ConversationStore: route saved");
  } catch (err) {
    log.warn({ sessionLabel, err }, "ConversationStore: route save failed");
  }
}

/** Load the ModelRouter route state. Returns null if not found. */
export function loadRouteState(sessionLabel: string): StoredRoute | null {
  try {
    const path = routeFilePath(sessionLabel);
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf-8");
    const data: StoredRoute = JSON.parse(raw);
    if (!data.sticky) return null;
    return data;
  } catch (err) {
    log.warn({ sessionLabel, err }, "ConversationStore: route load failed");
    return null;
  }
}

/** List all saved session labels from disk */
export function listSavedSessions(): string[] {
  try {
    if (!existsSync(SESSIONS_DIR)) return [];
    return readdirSync(SESSIONS_DIR)
      .filter(f => f.endsWith(".json") && !f.endsWith(".route.json"))
      .map(f => f.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}

// --- Startup Prompt ---
// A one-shot message file that JARVIS reads on boot and sends as first ai.request.
// Written by jarvis_reset or manually. Deleted after reading.

const STARTUP_PROMPT_PATH = jarvisPath("startup-prompt.txt");

/** Save a startup prompt to be sent on next boot */
export function saveStartupPrompt(text: string): void {
  try {
    ensureDir();
    writeFileSync(STARTUP_PROMPT_PATH, text, "utf-8");
    log.info({ length: text.length }, "ConversationStore: startup prompt saved");
  } catch (err) {
    log.error({ err }, "ConversationStore: startup prompt save failed");
  }
}

// In-memory flag: set on boot, cleared after first history request.
// Tells handleHistory to prepend a greeting to the returned messages.
let pendingGreeting: string | null = null;

/** Returns and clears the pending greeting (consumed once by handleHistory). */
export function consumePendingGreeting(): string | null {
  const g = pendingGreeting;
  pendingGreeting = null;
  return g;
}

/** Load and consume (delete) the startup prompt. Returns null if none. */
export function consumeStartupPrompt(): string | null {
  // Set the in-memory greeting flag so handleHistory appends it on the
  // next call — no file I/O, no race with autosave.
  pendingGreeting = "Back online, Sir.";

  log.info({ path: STARTUP_PROMPT_PATH }, "ConversationStore: consumeStartupPrompt called");

  try {
    const exists = existsSync(STARTUP_PROMPT_PATH);
    log.info({ exists, path: STARTUP_PROMPT_PATH }, "ConversationStore: startup prompt file check");

    if (!exists) {
      log.info("ConversationStore: no startup prompt file found — returning null");
      return null;
    }

    const text = readFileSync(STARTUP_PROMPT_PATH, "utf-8").trim();
    log.info({ length: text.length, preview: text.slice(0, 80) }, "ConversationStore: startup prompt read");

    unlinkSync(STARTUP_PROMPT_PATH);
    log.info("ConversationStore: startup prompt file deleted");

    if (!text) {
      log.warn("ConversationStore: startup prompt file was empty");
      return null;
    }

    log.info({ length: text.length }, "ConversationStore: startup prompt consumed successfully");
    return text;
  } catch (err) {
    log.error({ err }, "ConversationStore: startup prompt consume failed");
    return null;
  }
}

const ARCHIVE_DIR = join(SESSIONS_DIR, "archive");
const MAX_ARCHIVES_PER_LABEL = 10;

/** Archive and clear all saved conversations.
 *  Sessions are rolled to sessions/archive/<label>_<YYYYMMDD_HHMMSS>.json
 *  with up to MAX_ARCHIVES_PER_LABEL kept per label (oldest pruned). */
export function clearAllConversations(): void {
  try {
    if (!existsSync(SESSIONS_DIR)) return;
    mkdirSync(ARCHIVE_DIR, { recursive: true });

    const now = new Date();
    const timestamp = now.getFullYear().toString()
      + String(now.getMonth() + 1).padStart(2, "0")
      + String(now.getDate()).padStart(2, "0")
      + "_"
      + String(now.getHours()).padStart(2, "0")
      + String(now.getMinutes()).padStart(2, "0")
      + String(now.getSeconds()).padStart(2, "0");

    const files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith(".json"));
    let archived = 0;
    for (const f of files) {
      const label = f.replace(/\.json$/, "");
      const src = join(SESSIONS_DIR, f);
      const dest = join(ARCHIVE_DIR, `${label}_${timestamp}.json`);
      renameSync(src, dest);
      archived++;
    }

    // Prune old archives: keep only last N per label
    pruneArchives();

    log.info({ archived, timestamp }, "ConversationStore: archived and cleared all");
  } catch (err) {
    log.error({ err }, "ConversationStore: clearAll failed");
  }
}

function pruneArchives(): void {
  if (!existsSync(ARCHIVE_DIR)) return;
  const archiveFiles = readdirSync(ARCHIVE_DIR).filter(f => f.endsWith(".json"));

  // Group by label (everything before _YYYYMMDD_HHMMSS.json)
  const byLabel = new Map<string, string[]>();
  for (const f of archiveFiles) {
    const match = f.match(/^(.+)_\d{8}_\d{6}\.json$/);
    if (!match) continue;
    const label = match[1];
    if (!byLabel.has(label)) byLabel.set(label, []);
    byLabel.get(label)!.push(f);
  }

  for (const [, files] of byLabel) {
    // Sort by name descending (newest first since timestamps sort lexicographically)
    files.sort((a, b) => b.localeCompare(a));
    // Remove excess
    for (const f of files.slice(MAX_ARCHIVES_PER_LABEL)) {
      unlinkSync(join(ARCHIVE_DIR, f));
      log.debug({ file: f }, "ConversationStore: pruned old archive");
    }
  }
}
