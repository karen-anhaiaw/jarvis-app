// src/capabilities/loader.ts
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, delimiter as pathDelimiter } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { EventBus } from "../core/bus.js";
import type { Piece } from "../core/piece.js";
import type { HudUpdateMessage } from "../core/types.js";
import type { CapabilityRegistry } from "./registry.js";
import { abortRegistry } from "./abort-registry.js";
import { stripExecutorContext } from "./executor.js";
import { log } from "../logger/index.js";
import { jarvisPath } from "../core/paths.js";

const execFileAsync = promisify(execFile);

interface CapabilityConfig {
  name: string;
  description: string;
  /** "script"/"executable" → local handler. "server" → Anthropic-executed. */
  type: "script" | "executable" | "server";
  command?: string;
  args?: string[];
  stdin?: string;
  input_schema?: Record<string, unknown>;
  /** Slash-menu category, declared in the tool's JSON definition (F3.15).
   *  Lives WITH the tool definition so the registry stays name-agnostic. */
  category?: string;
  /** Anthropic server-tool type id (e.g. "web_search_20260209"). Required
   *  when type === "server". The capability name must match what Anthropic
   *  expects for that type (e.g. "web_search" for web_search_*). */
  serverToolType?: string;
}

// capabilities/ lives next to the compiled loader (source or bundle).
// ESM __dirname equivalent via import.meta.url.
// Override with JARVIS_CAPABILITIES_DIR env var for custom layouts.
const _loaderDir = fileURLToPath(new URL(".", import.meta.url));
// Resolve capabilities/ relative to this file, searching upward if needed.
// Works in both dev (tsx: src/capabilities/) and bundle (app/) layouts.
function _findCapsDir(): string {
  // Walk up from _loaderDir until we find a directory named "capabilities"
  // that contains at least one .json file — that's the real one.
  let dir = _loaderDir;
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, "capabilities");
    try {
      const entries = require("node:fs").readdirSync(candidate);
      if (entries.some((f: string) => f.endsWith(".json"))) return candidate;
    } catch { /* not found, keep going */ }
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  // Last resort: cwd/capabilities (original behaviour)
  return join(process.cwd(), "capabilities");
}
const _capsDir = _findCapsDir();
const getCapabilitiesDir = () => process.env.JARVIS_CAPABILITIES_DIR ?? _capsDir;

const SPAWN_TIMEOUT_MS = 600000;

/** Grace period after SIGTERM before we escalate to SIGKILL on the tree. */
const KILL_ESCALATION_MS = 2000;

/**
 * Kill a spawned child AND its descendants on abort.
 *
 * The direct child (e.g. bash) often spawns grandchildren (`bash -c "sleep 300"`
 * → a `sleep` grandchild). child.kill("SIGTERM") signals ONLY the direct child,
 * leaving the grandchild running as an orphan — the exact leak the user hit when
 * aborting a running bash. When the child was spawned detached (POSIX process
 * group leader), we signal the whole group with a NEGATIVE pid, then escalate to
 * SIGKILL after a grace period for processes that ignore SIGTERM.
 *
 * Windows / non-detached: fall back to child.kill(), which is the best a single
 * handle offers there (no POSIX process groups).
 *
 * All kills are wrapped in try/catch — a race where the process already exited
 * (ESRCH) must never throw out of the abort handler.
 *
 * NOTE — capabilities that wrap with `timeout`: killTree signals the DIRECT
 * child's process group. `timeout` (coreutils) runs its target in its OWN group,
 * so killTree alone does NOT reach a grandchild launched under `timeout`. Such
 * capabilities need their own signal trap that targets the timeout's group — see
 * capabilities/scripts/bash-exec.sh and docs/features/bdd/abort-process-tree.feature.
 */
export function killTree(
  child: { pid?: number; kill: (sig?: NodeJS.Signals | number) => boolean },
  detached: boolean,
): void {
  const pid = child.pid;
  if (detached && typeof pid === "number") {
    // Negative pid = process group. Take the whole tree.
    try { process.kill(-pid, "SIGTERM"); } catch { /* already gone */ }
    // Escalate for anything that ignored SIGTERM. unref so this timer never
    // keeps the event loop (or a test) alive on its own.
    const t = setTimeout(() => {
      try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
    }, KILL_ESCALATION_MS);
    (t as { unref?: () => void }).unref?.();
    return;
  }
  // Fallback: direct child only (Windows, or no pid available).
  try { child.kill("SIGTERM"); } catch { /* already gone */ }
}

export interface SpawnPlan {
  file: string;
  args: string[];
  options: { shell: boolean; timeout: number; windowsVerbatimArguments?: boolean; detached?: boolean };
}

/**
 * Quotes a single argument for a Windows command line handed to cmd.exe
 * verbatim (windowsVerbatimArguments), so Node performs no quoting of its own.
 *
 * Rules: wrap in double quotes, escape embedded quotes as \", and double any
 * run of backslashes that precedes a quote or terminates the argument —
 * otherwise a trailing backslash would escape our closing quote.
 */
export function quoteWindowsArg(arg: string): string {
  if (arg === "") return '""';
  const escaped = arg
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\*)$/, "$1$1");
  return `"${escaped}"`;
}

/**
 * Locates an executable on Windows by walking PATH against PATHEXT.
 * Returns an absolute path, or null when nothing matches.
 */
function resolveOnWindowsPath(command: string): string | null {
  // Already an explicit path — trust it if it exists.
  if (/[\\/]/.test(command)) return existsSync(command) ? command : null;

  const dirs = (process.env.PATH ?? "").split(pathDelimiter).filter(Boolean);
  const exts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);

  for (const dir of dirs) {
    // A bare name may already carry its extension (e.g. "bash.exe").
    const direct = join(dir, command);
    if (existsSync(direct)) return direct;
    for (const ext of exts) {
      const lower = join(dir, command + ext.toLowerCase());
      if (existsSync(lower)) return lower;
      const upper = join(dir, command + ext);
      if (existsSync(upper)) return upper;
    }
  }
  return null;
}

/**
 * Builds the spawn invocation for a capability.
 *
 * WHY THIS EXISTS — the bug it replaces
 *   The previous implementation passed shell:true on win32. With shell:true,
 *   Node does not forward `args` as a vector: it concatenates them into one
 *   command line for cmd.exe WITHOUT quoting arguments that contain spaces,
 *   and cmd.exe then re-tokenizes on whitespace. A capability invoked with
 *   command "echo OK" reached bash-exec.sh as $1="echo", $2="OK",
 *   $3=<timeout> — every argument shifted by one. Observed in production on
 *   Windows as "Working directory not found: 10". It affected every capability
 *   receiving an argument containing a space, which in practice is all of them.
 *
 * THE FIX
 *   Never let cmd.exe re-tokenize. Resolve the command to an absolute path and
 *   spawn it with shell:false, which makes Node quote the argv vector properly.
 *
 *   shell:true had a legitimate purpose: finding .cmd/.bat shims (npx, npm).
 *   Those genuinely require cmd.exe to interpret them, so for that case we
 *   invoke cmd.exe explicitly and build the command line ourselves with
 *   quoteWindowsArg + windowsVerbatimArguments, keeping Node out of it.
 *
 * Exported for unit tests. `resolver` is injectable so Windows behaviour can be
 * tested without a Windows host.
 */
export function buildSpawnPlan(
  command: string,
  args: string[],
  platform: string = process.platform,
  resolver: (command: string, platform: string) => string | null = resolveOnWindowsPath,
): SpawnPlan {
  // detached:true makes the child the leader of a NEW process group on POSIX,
  // so an abort can signal the whole group (process.kill(-pid, ...)) and take
  // any grandchildren with it — e.g. `bash -c "sleep 300"` spawns a `sleep`
  // grandchild that child.kill() alone would orphan. Windows has no POSIX
  // process groups; detached there changes console semantics, so we keep it off
  // and fall back to child.kill() (see execWithProgress abort handler).
  const detached = platform !== "win32";
  const options = { shell: false, timeout: SPAWN_TIMEOUT_MS, detached };

  if (platform !== "win32") {
    return { file: command, args, options };
  }

  const resolved = resolver(command, platform);
  if (!resolved) {
    throw new Error(
      `Cannot resolve executable "${command}" on Windows. Searched PATH against ` +
        `PATHEXT. If this is bash, install Git for Windows and ensure its bin ` +
        `directory is on PATH.`,
    );
  }

  // .cmd / .bat are scripts, not images — only cmd.exe can execute them.
  if (/\.(cmd|bat)$/i.test(resolved)) {
    const line = [resolved, ...args].map(quoteWindowsArg).join(" ");
    return {
      file: process.env.COMSPEC ?? "cmd.exe",
      args: ["/d", "/s", "/c", line],
      options: { ...options, windowsVerbatimArguments: true },
    };
  }

  // Real executable — Node quotes the argv vector correctly with shell:false.
  return { file: resolved, args, options };
}

export class CapabilityLoaderPiece implements Piece {
  readonly id = "capability-loader";
  readonly name = "Capability Loader";

  private bus!: EventBus;
  private registry: CapabilityRegistry;
  private loaded: string[] = [];

  systemContext(): string {
    // homedir() is portable (Windows, macOS, Linux). Never use process.env.HOME
    // — on Windows native (cmd.exe / PowerShell) HOME is undefined, which would
    // make the model believe the home directory is the string "undefined".
    return `## Capability Loader Piece
You have ${this.loaded.length} file-system capabilities loaded: ${this.loaded.join(', ')}.
These capabilities let you interact with the user's filesystem — read, write, edit files, search content, list directories, and run shell commands.
The user's home directory is ${homedir()}. Current working directory is ${process.cwd()}.`;
  }

  constructor(registry: CapabilityRegistry) {
    this.registry = registry;
  }

  async start(bus: EventBus): Promise<void> {
    this.bus = bus;
    this.loadCapabilities();

    // Abort wiring lives in the shared AbortRegistry (wired once in main.ts).
    // This piece only registers/releases per-tool controllers in handlers.

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
        data: { capabilities: this.loaded },
        position: { x: 10, y: 70 },
        size: { width: 150, height: 40 },
      },
    });

    log.info({ count: this.loaded.length, capabilities: this.loaded }, "CapabilityLoader: loaded");
  }

  async stop(): Promise<void> {
    this.bus.publish({
      channel: "hud.update",
      source: this.id,
      action: "remove",
      pieceId: this.id,
    });
  }

  private loadCapabilities(): void {
    const capsDir = getCapabilitiesDir();
    if (!existsSync(capsDir)) {
      log.info({ dir: capsDir }, "CapabilityLoader: capabilities directory not found, skipping");
      return;
    }

    const files = readdirSync(capsDir).filter(f => f.endsWith(".json"));

    for (const file of files) {
      try {
        const content = readFileSync(join(capsDir, file), "utf-8");
        const config: CapabilityConfig = JSON.parse(content);
        this.registerCapability(config);
        this.loaded.push(config.name);
      } catch (err) {
        log.error({ file, err }, "CapabilityLoader: failed to load capability");
      }
    }
  }

  /**
   * Unified spawn-based executor. Replaces both `execWithStdin` and
   * `execFileAsync` paths so ALL capabilities get live stdout streaming
   * via the optional `onProgress` callback.
   *
   * Throttle: progress events are emitted at most every PROGRESS_THROTTLE_MS
   * to avoid flooding the SSE channel on very chatty tools (e.g. npm install).
   */
  private execWithProgress(
    command: string,
    args: string[],
    stdinData: string | undefined,
    signal: AbortSignal | undefined,
    onProgress: ((chunk: string) => void) | undefined,
  ): Promise<{ stdout: string; stderr: string }> {
    const PROGRESS_THROTTLE_MS = 100;
    return new Promise((resolve, reject) => {
      const plan = buildSpawnPlan(command, args);
      const child = spawn(plan.file, plan.args, plan.options);
      let stdout = "";
      let stderr = "";
      let pendingChunk = "";
      let flushTimer: ReturnType<typeof setTimeout> | undefined;

      const flushProgress = () => {
        if (pendingChunk && onProgress) {
          onProgress(pendingChunk);
          pendingChunk = "";
        }
        flushTimer = undefined;
      };

      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        if (onProgress) {
          pendingChunk += text;
          if (!flushTimer) {
            flushTimer = setTimeout(flushProgress, PROGRESS_THROTTLE_MS);
          }
        }
      });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

      child.on("error", reject);
      child.on("close", (code) => {
        // Flush any remaining buffered progress
        if (flushTimer) clearTimeout(flushTimer);
        flushProgress();

        if (code !== 0 && code !== null) {
          const err: any = new Error(`Process exited with code ${code}`);
          err.stderr = stderr;
          err.code = code;
          reject(err);
        } else {
          resolve({ stdout, stderr });
        }
      });

      if (stdinData !== undefined) {
        child.stdin.write(stdinData);
      }
      child.stdin.end();

      signal?.addEventListener("abort", () => {
        if (flushTimer) clearTimeout(flushTimer);
        killTree(child, plan.options.detached === true);
        reject(new Error("aborted"));
      });
    });
  }

  /** @deprecated Use execWithProgress instead. Kept for backward compat with any external callers. */
  private execWithStdin(command: string, args: string[], stdinData: string, signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
    return this.execWithProgress(command, args, stdinData, signal, undefined);
  }

  private parseOutput(stdout: string, stderr: string): unknown {
    const output = stdout;
    if (output.startsWith("__TYPE__:image\n")) {
      const lines = output.split("\n").filter(l => l.trim());
      const mimeLine = lines.find(l => l.startsWith("__MIME__:"));
      const mime = mimeLine?.replace("__MIME__:", "") ?? "image/png";

      // Check if next line is a file path (starts with /)
      const dataLine = lines.find(l => !l.startsWith("__TYPE__:") && !l.startsWith("__MIME__:"));
      let base64Data: string;

      if (dataLine && dataLine.startsWith("/")) {
        // It's a file path — read and encode (readFileSync imported at top)
        try {
          const buf = readFileSync(dataLine.trim());
          base64Data = buf.toString("base64");
          // Detect mime from extension
          const ext = dataLine.trim().split(".").pop()?.toLowerCase();
          const mimeMap: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
          const detectedMime = mimeMap[ext ?? ""] ?? mime;
          return [
            { type: "image" as const, source: { type: "base64" as const, media_type: detectedMime, data: base64Data } },
          ];
        } catch (err: any) {
          return { error: `Failed to read image file: ${err.message}` };
        }
      }

      // Otherwise it's inline base64
      base64Data = lines.slice(lines.findIndex(l => l.startsWith("__MIME__:")) + 1).join("\n").trim();
      return [
        { type: "image" as const, source: { type: "base64" as const, media_type: mime, data: base64Data } },
      ];
    }

    if (output.startsWith("__TYPE__:error\n")) {
      return { error: output.split("\n").slice(1).join("\n").trim() };
    }

    const text = output.startsWith("__TYPE__:text\n")
      ? output.split("\n").slice(1).join("\n").trim()
      : output.trim();

    // If the output is valid JSON, return it parsed so capabilities like
    // multi_edit_file return structured data instead of a wrapped string.
    if (text.startsWith("{") || text.startsWith("[")) {
      try {
        return JSON.parse(text);
      } catch {
        // Not valid JSON — fall through to text return
      }
    }

    return { stdout: text, stderr: stderr.trim() || undefined };
  }

  private registerCapability(config: CapabilityConfig): void {
    // Server-side tool: executed by the Anthropic API. No local handler — we
    // just declare type + name; Anthropic owns the schema and execution.
    if (config.type === "server") {
      if (!config.serverToolType) {
        log.error({ name: config.name }, "CapabilityLoader: server capability missing serverToolType — skipping");
        return;
      }
      this.registry.register({
        name: config.name,
        description: config.description,
        input_schema: config.input_schema ?? {},
        category: config.category,
        execution: "server",
        serverToolType: config.serverToolType,
      });
      return;
    }

    this.registry.register({
      name: config.name,
      description: config.description,
      input_schema: config.input_schema ?? {},
      category: config.category,
      supportsProgress: true,
      handler: async (input, onProgress) => {
        const sessionId = input.__sessionId as string | undefined;
        const toolUseId = input.__toolUseId as string | undefined;
        // Per-tool abort: keyed (sessionId, toolUseId) so parallel tools in
        // the same turn each get their own controller (ESC aborts ALL).
        const signal = sessionId ? abortRegistry.register(sessionId, toolUseId) : new AbortController().signal;
        // Expand ~ and substitute ${param} in args
        // homedir() is portable — never process.env.HOME (undefined on Windows native)
        const expand = (s: string) => s.replace(/^~/, homedir());
        const args = (config.args ?? []).map(arg =>
          expand(arg.replace(/\$\{(\w+)\}/g, (_, key) => expand(String(input[key] ?? ""))))
        );

        // Resolve stdin template if defined
        // Special case: ${__json_input__} sends the entire input as JSON —
        // minus executor context fields (__sessionId/__toolUseId/__traceId):
        // scripts receive only declared tool arguments (F4.17; verified no
        // script in capabilities/scripts reads the __ fields).
        const stdinData = config.stdin
          ? config.stdin === "${__json_input__}"
            ? JSON.stringify(stripExecutorContext(input))
            : config.stdin.replace(/\$\{(\w+)\}/g, (_, key) => String(input[key] ?? ""))
          : undefined;

        try {
          // Always use spawn so we can stream stdout via onProgress.
          // For stdin-based configs (execWithStdin path) the logic is the same.
          // command is guaranteed present for local (script/executable) tools.
          const { stdout, stderr } = await this.execWithProgress(
            config.command!, args, stdinData, signal, onProgress,
          );
          return this.parseOutput(stdout, stderr);
        } catch (err: any) {
          if (signal.aborted || err.message === "aborted") {
            return { error: "aborted", stdout: "", stderr: "" };
          }
          return {
            error: err.message,
            stderr: err.stderr?.trim(),
            exitCode: err.code,
          };
        } finally {
          if (sessionId) abortRegistry.release(sessionId, toolUseId);
        }
      },
    });
  }
}
