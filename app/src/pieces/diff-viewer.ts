// src/pieces/diff-viewer.ts
// Diff Viewer piece — manages diff/file visualization in the HUD.
// Registers capabilities: hud_show_diff, hud_show_file, hud_compare_files
// Publishes to hud.update with structured data for the DiffViewerRenderer.

import { readFileSync, existsSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { extname, basename, join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { execSync } from "node:child_process";
import type { EventBus } from "../core/bus.js";
import type { Piece } from "../core/piece.js";
import type { CapabilityRegistry } from "../capabilities/registry.js";
import { log } from "../logger/index.js";

// Language detection from file extension
const EXT_LANG: Record<string, string> = {
  ".py": "python", ".js": "javascript", ".ts": "typescript",
  ".tsx": "tsx", ".jsx": "jsx", ".rb": "ruby", ".go": "go",
  ".rs": "rust", ".java": "java", ".kt": "kotlin",
  ".c": "c", ".cpp": "cpp", ".h": "c", ".hpp": "cpp",
  ".cs": "csharp", ".swift": "swift", ".sh": "bash", ".bash": "bash",
  ".json": "json", ".yaml": "yaml", ".yml": "yaml", ".toml": "toml",
  ".xml": "xml", ".html": "html", ".css": "css", ".scss": "scss",
  ".sql": "sql", ".md": "markdown", ".clj": "clojure", ".cljs": "clojure",
  ".cljc": "clojure", ".edn": "clojure", ".ex": "elixir",
  ".tf": "hcl", ".proto": "protobuf", ".graphql": "graphql",
  ".dockerfile": "dockerfile",
};

function detectLanguage(filePath: string): string {
  const base = basename(filePath).toLowerCase();
  if (base === "dockerfile") return "dockerfile";
  if (base === "makefile") return "makefile";
  return EXT_LANG[extname(filePath)] ?? "text";
}

function readFileSafe(path: string): { content: string; error?: string } {
  try {
    const expandedPath = path.replace(/^~/, homedir());
    if (!existsSync(expandedPath)) return { content: "", error: `File not found: ${path}` };
    const stats = statSync(expandedPath);
    if (stats.isDirectory()) return { content: "", error: `Path is a directory: ${path}` };
    if (stats.size > 1024 * 1024) return { content: "", error: `File too large (${Math.round(stats.size / 1024)}KB). Max 1MB.` };
    const content = readFileSync(expandedPath, "utf-8");
    return { content };
  } catch (err: any) {
    return { content: "", error: `Error reading file: ${err.message}` };
  }
}

function generateDiff(oldContent: string, newContent: string, fileName: string): string {
  // Use diff command if available, fallback to simple comparison
  try {
    const { execFileSync } = require("node:child_process");
    // os.tmpdir() is portable (C:\Users\...\AppData\Local\Temp on Windows)
    const ts = Date.now();
    const tmpOld = join(tmpdir(), `jarvis-diff-old-${ts}`);
    const tmpNew = join(tmpdir(), `jarvis-diff-new-${ts}`);
    writeFileSync(tmpOld, oldContent);
    writeFileSync(tmpNew, newContent);
    try {
      const result = execSync(
        `diff -u --label "a/${fileName}" --label "b/${fileName}" "${tmpOld}" "${tmpNew}"`,
        { encoding: "utf-8", timeout: 5000 }
      );
      return result;
    } catch (err: any) {
      // diff returns exit code 1 when files differ — that's normal
      if (err.stdout) return err.stdout;
      return "";
    } finally {
      try { unlinkSync(tmpOld); } catch {}
      try { unlinkSync(tmpNew); } catch {}
    }
  } catch {
    return ""; // fallback: no diff available
  }
}

export interface DiffEntry {
  path: string;
  language: string;
  oldContent: string;
  newContent: string;
  diff: string;
  annotations?: Array<{ line: number; text: string; type?: "info" | "warning" | "error" }>;
}

export interface FileEntry {
  path: string;
  language: string;
  content: string;
  highlightLines?: number[];
  annotations?: Array<{ line: number; text: string; type?: "info" | "warning" | "error" }>;
}

export type DiffViewerMode = "diff" | "file" | "compare";

export interface DiffViewerData {
  mode: DiffViewerMode;
  viewMode: "inline" | "side-by-side";
  activeTab: number;
  title?: string;
  /** When true, show Accept/Reject buttons. Default: false (view-only). */
  interactive?: boolean;
  /** Session that opened this tab — replies (accept/reject/dismiss) route
   *  back to this session. Required for interactive diffs. */
  sessionId?: string;
  // diff mode
  diffs?: DiffEntry[];
  // file mode
  file?: FileEntry;
  // history
  historyCount: number;
}

export class DiffViewerPiece implements Piece {
  readonly id = "diff-viewer";
  readonly name = "Diff Viewer";

  private bus!: EventBus;
  private registry: CapabilityRegistry;
  private history: DiffViewerData[] = [];
  private currentData: DiffViewerData | null = null;
  private addedToHud = false;

  constructor(registry: CapabilityRegistry) {
    this.registry = registry;
  }

  private unsubRemove?: () => void;

  async start(bus: EventBus): Promise<void> {
    this.bus = bus;
    this.registerCapabilities();
    this.hookMultiEdit();

    // When the panel is closed (removed from HUD), reset addedToHud so the
    // next publishToHud uses "add" instead of "update" on a non-existent component.
    this.unsubRemove = this.bus.subscribe("hud.update", (msg: any) => {
      if (msg.action === "remove" && msg.pieceId === this.id && msg.source !== this.id) {
        this.addedToHud = false;
      }
    });

    log.info("DiffViewer: initialized");
  }

  async stop(): Promise<void> {
    this.unsubRemove?.();
    // Remove HUD panel
    this.bus.publish({
      channel: "hud.update",
      source: this.id,
      action: "remove",
      pieceId: this.id,
    });
    log.info("DiffViewer: stopped");
  }

  private publishToHud(data: DiffViewerData): void {
    this.currentData = data;
    this.history.push(data);

    // Cap history at 50 entries
    if (this.history.length > 50) {
      this.history = this.history.slice(-50);
    }

    // Always use "add" — this ensures the panel re-appears even if the user
    // previously closed it. HudState treats "add" on an existing pieceId as
    // an upsert, so there's no duplication.
    this.addedToHud = true;

    this.bus.publish({
      channel: "hud.update",
      source: this.id,
      action: "add",
      pieceId: this.id,
      piece: {
        pieceId: this.id,
        type: "panel",
        name: this.name,
        status: "running",
        data: data as unknown as Record<string, unknown>,
        position: { x: 50, y: 50 },
        size: { width: 900, height: 600 },
        ephemeral: true,
      },
      data: data as unknown as Record<string, unknown>,
      status: "running",
      visible: true,
    });
  }

  /**
   * Hook into multi_edit_file results via the registry's onExecution listener.
   * When multi_edit_file completes with show_diff:true, automatically display
   * the diff in the HUD by intercepting the result on capability.result channel.
   */
  private hookMultiEdit(): void {
    this.bus.subscribe<import("../core/types.js").CapabilityResultMessage>("capability.result", (msg) => {
      for (const result of msg.results) {
        if (result.is_error) continue;
        try {
          const content = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
          const parsed = JSON.parse(content);

          // Detect multi_edit_file output by structure
          if (!parsed?.success || !parsed?.results || !Array.isArray(parsed.results)) continue;
          // Check first result has the expected shape (path, old_content, new_content)
          const first = parsed.results[0];
          if (!first?.path || !first?.old_content && !first?.new_content) continue;

          // Check if show_diff was requested — look for the flag in the result
          // The Python script passes through the input show_diff as part of stdout
          // But we can't access the original input here. Instead, check the __show_diff marker.
          // Alternative: we parse from the original calls. Since we can't easily do that,
          // we add show_diff to the Python output, or we use a simpler approach:
          // Listen on capability.request instead to capture the input, then match on result.

          // Simpler approach: always check if results have diff data and the result indicates show_diff
          // For now, we look for the show_diff field in the parsed output
          if (!parsed.__show_diff) continue;

          const diffs = parsed.results.map((r: any) => ({
            path: r.path,
            language: r.language ?? detectLanguage(r.path),
            oldContent: r.old_content,
            newContent: r.new_content,
            diff: r.diff ?? "",
          }));

          const data: DiffViewerData = {
            mode: "diff",
            viewMode: "side-by-side",
            activeTab: 0,
            title: `Edit: ${diffs.map((d: DiffEntry) => basename(d.path)).join(", ")}`,
            diffs,
            historyCount: this.history.length + 1,
          };

          this.publishToHud(data);
          log.info({ files: diffs.length }, "DiffViewer: auto-displayed multi_edit_file diff");
        } catch {
          // Not JSON or not a multi_edit result — ignore
        }
      }
    });
  }

  private registerCapabilities(): void {
    // hud_show_diff — show diff data in HUD
    this.registry.register({
      name: "hud_show_diff",
      category: "hud",
      description: "Show a before/after diff to the user in the HUD. Each call opens a new tab. Set interactive=true to add Accept/Reject buttons when you want user feedback — you'll receive a [SYSTEM] message with their decision. Without interactive, it's view-only (user can still close the tab). Use for showing changes, code reviews, proposals, or any comparison.",
      input_schema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Title for the diff viewer panel" },
          interactive: { type: "boolean", description: "Show Accept/Reject buttons for user feedback (default: false — view-only)" },
          diffs: {
            type: "array",
            description: "Array of file diffs to display",
            items: {
              type: "object",
              properties: {
                path: { type: "string", description: "File path (for display)" },
                old_content: { type: "string", description: "Original content" },
                new_content: { type: "string", description: "Modified content" },
                annotations: {
                  type: "array",
                  description: "Line annotations",
                  items: {
                    type: "object",
                    properties: {
                      line: { type: "integer", description: "Line number (1-indexed)" },
                      text: { type: "string", description: "Annotation text" },
                      type: { type: "string", enum: ["info", "warning", "error"], description: "Annotation severity" },
                    },
                    required: ["line", "text"],
                  },
                },
              },
              required: ["path", "old_content", "new_content"],
            },
          },
          view_mode: { type: "string", enum: ["inline", "side-by-side"], description: "View mode (default: side-by-side)" },
        },
        required: ["diffs"],
      },
      handler: async (input) => {
        const diffs = (input.diffs as any[]).map(d => ({
          path: d.path,
          language: detectLanguage(d.path),
          oldContent: d.old_content,
          newContent: d.new_content,
          diff: generateDiff(d.old_content, d.new_content, basename(d.path)),
          annotations: d.annotations,
        }));

        const data: DiffViewerData = {
          mode: "diff",
          viewMode: (input.view_mode as "inline" | "side-by-side") ?? "side-by-side",
          activeTab: 0,
          title: input.title as string,
          interactive: input.interactive as boolean | undefined,
          sessionId: input.__sessionId as string | undefined,
          diffs,
          historyCount: this.history.length + 1,
        };

        this.publishToHud(data);
        return { success: true, files: diffs.length, message: "Diff displayed in HUD" };
      },
    });

    // hud_show_file — show a file with syntax highlighting
    this.registry.register({
      name: "hud_show_file",
      category: "hud",
      description: "Display a file to the user with syntax highlighting, line numbers, and optional annotations. Use to show relevant code, highlight important lines, or point out issues. Opens as a tab the user can review and dismiss. Read-only — no Accept/Reject buttons.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path to the file to display" },
          title: { type: "string", description: "Optional title override" },
          highlight_lines: {
            type: "array",
            items: { type: "integer" },
            description: "Line numbers to highlight (1-indexed)",
          },
          annotations: {
            type: "array",
            description: "Line annotations to display",
            items: {
              type: "object",
              properties: {
                line: { type: "integer", description: "Line number (1-indexed)" },
                text: { type: "string", description: "Annotation text" },
                type: { type: "string", enum: ["info", "warning", "error"] },
              },
              required: ["line", "text"],
            },
          },
        },
        required: ["path"],
      },
      handler: async (input) => {
        const filePath = (input.path as string).replace(/^~/, homedir());
        const { content, error } = readFileSafe(filePath);
        if (error) return { success: false, error };

        const file: FileEntry = {
          path: filePath,
          language: detectLanguage(filePath),
          content,
          highlightLines: input.highlight_lines as number[],
          annotations: input.annotations as any[],
        };

        const data: DiffViewerData = {
          mode: "file",
          viewMode: "inline",
          activeTab: 0,
          title: (input.title as string) ?? basename(filePath),
          sessionId: input.__sessionId as string | undefined,
          file,
          historyCount: this.history.length + 1,
        };

        this.publishToHud(data);
        return {
          success: true,
          path: filePath,
          language: file.language,
          lines: content.split("\n").length,
          message: "File displayed in HUD",
        };
      },
    });

    // hud_compare_files — compare two files side by side
    this.registry.register({
      name: "hud_compare_files",
      category: "hud",
      description: "Compare two files side by side in the HUD. Set interactive=true to add Accept/Reject buttons for user feedback. Without it, view-only.",
      input_schema: {
        type: "object",
        properties: {
          path_a: { type: "string", description: "Path to the first file (shown as 'before')" },
          path_b: { type: "string", description: "Path to the second file (shown as 'after')" },
          title: { type: "string", description: "Optional title for the comparison" },
          interactive: { type: "boolean", description: "Show Accept/Reject buttons for user feedback (default: false)" },
        },
        required: ["path_a", "path_b"],
      },
      handler: async (input) => {
        const pathA = (input.path_a as string).replace(/^~/, homedir());
        const pathB = (input.path_b as string).replace(/^~/, homedir());

        const fileA = readFileSafe(pathA);
        if (fileA.error) return { success: false, error: `File A: ${fileA.error}` };

        const fileB = readFileSafe(pathB);
        if (fileB.error) return { success: false, error: `File B: ${fileB.error}` };

        const diff: DiffEntry = {
          path: `${basename(pathA)} → ${basename(pathB)}`,
          language: detectLanguage(pathA),
          oldContent: fileA.content,
          newContent: fileB.content,
          diff: generateDiff(fileA.content, fileB.content, basename(pathA)),
        };

        const data: DiffViewerData = {
          mode: "compare",
          viewMode: "side-by-side",
          activeTab: 0,
          title: (input.title as string) ?? `${basename(pathA)} vs ${basename(pathB)}`,
          interactive: input.interactive as boolean | undefined,
          sessionId: input.__sessionId as string | undefined,
          diffs: [diff],
          historyCount: this.history.length + 1,
        };

        this.publishToHud(data);
        return { success: true, message: "Comparison displayed in HUD" };
      },
    });
  }
}
