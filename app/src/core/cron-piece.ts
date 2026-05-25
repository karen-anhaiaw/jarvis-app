// src/core/cron-piece.ts
// Cron/Scheduling piece — schedule prompts to run on intervals or at specific times.
// Results are published via ai.stream to appear in chat.
//
// Persistence: jobs are stored in settings.user.json under cron.jobs.
// On boot, all persisted jobs are restored. lastRun is tracked per job.
// Smart scheduling: on restore, calculates time until next run (not from zero).

import type { EventBus } from "./bus.js";
import type { Piece } from "./piece.js";
import type { AIRequestMessage, HudUpdateMessage } from "./types.js";
import type { CapabilityRegistry } from "../capabilities/registry.js";
import type { PersistedCronJob } from "./settings.js";
import type { DelegateTaskPiece, DelegateRunOptions } from "../pieces/delegate-task.js";
import { load as loadSettings, save as saveSettings, invalidateCache } from "./settings.js";
import { graphRegistry } from "./graph-registry.js";
import { log } from "../logger/index.js";

// NOTE: PieceManager is responsible for registering this piece as a core graph node.

interface CronJob {
  id: string;
  cron: string;
  prompt: string;
  target: string;
  recurring: boolean;
  nextRun: number;
  interval?: ReturnType<typeof setInterval>;
  timeout?: ReturnType<typeof setTimeout>;
  createdAt: number;
  lastRun?: number;
  runs: number;
  // source tracks where this job came from for persistence decisions
  source: "tool" | "settings";
  // delegate mode (optional)
  mode?: "prompt" | "delegate";
  role?: string;
  model?: string;
  reply_to?: string;
  // catch-up: if true, runs immediately when a missed execution is detected
  catchUp?: boolean;
}

// ─── Cron parsing ─────────────────────────────────────────────────────────────
// Supported formats:
//   "*/N * * * *"       — every N minutes
//   "N * * * *"         — at minute N of every hour
//   "once:Ns/Nm/Nh"     — one-shot in N seconds/minutes/hours
//   "0 H * * *"         — daily at hour H (standard cron, minute must be 0)
//   "M H * * *"         — daily at HH:MM
//   "M H * * DOW"       — weekly (day-of-week: 0=Sun, 1=Mon, ... 6=Sat, also 1-5=weekdays)
//   "HH:MM"             — shorthand for daily at HH:MM

interface ParsedCron {
  type: "interval" | "once" | "daily" | "weekly";
  intervalMs?: number;   // for interval type
  nextMs?: number;       // for once type
  hour?: number;         // for daily/weekly
  minute?: number;       // for daily/weekly
  dow?: number[];        // for weekly: array of days-of-week (0=Sun..6=Sat)
}

function parseDow(dowStr: string): number[] {
  // supports "1-5" ranges and comma-separated values like "1,3,5"
  if (dowStr === "*") return [0, 1, 2, 3, 4, 5, 6];
  const result: number[] = [];
  const parts = dowStr.split(",");
  for (const part of parts) {
    if (part.includes("-")) {
      const [start, end] = part.split("-").map(Number);
      for (let d = start; d <= end; d++) result.push(d);
    } else {
      result.push(Number(part));
    }
  }
  return result;
}

export function parseCron(cron: string): ParsedCron | null {
  const s = cron.trim();

  // once:Ns / once:Nm / once:Nh
  if (s.startsWith("once:")) {
    const val = s.slice(5);
    const num = parseInt(val);
    if (isNaN(num)) return null;
    if (val.endsWith("s")) return { type: "once", nextMs: num * 1000 };
    if (val.endsWith("m")) return { type: "once", nextMs: num * 60_000 };
    if (val.endsWith("h")) return { type: "once", nextMs: num * 3_600_000 };
    return { type: "once", nextMs: num * 1000 };
  }

  // HH:MM shorthand — daily
  if (/^\d{1,2}:\d{2}$/.test(s)) {
    const [h, m] = s.split(":").map(Number);
    if (h >= 0 && h < 24 && m >= 0 && m < 60) {
      return { type: "daily", hour: h, minute: m, dow: [0, 1, 2, 3, 4, 5, 6] };
    }
    return null;
  }

  // standard cron: "M H dow_or_star ..."
  const parts = s.split(" ");
  if (parts.length >= 2) {
    const minPart = parts[0];
    const hourPart = parts[1];
    const dowPart = parts[4] ?? "*";

    // */N * * * * — every N minutes
    if (minPart.startsWith("*/")) {
      const every = parseInt(minPart.slice(2));
      if (!isNaN(every) && every > 0) return { type: "interval", intervalMs: every * 60_000 };
    }

    // M H * * DOW — daily or weekly
    const min = parseInt(minPart);
    const hour = parseInt(hourPart);
    if (!isNaN(min) && !isNaN(hour) && min >= 0 && min < 60 && hour >= 0 && hour < 24) {
      const dow = parseDow(dowPart);
      const type = (dowPart === "*" || dow.length === 7) ? "daily" : "weekly";
      return { type, hour, minute: min, dow };
    }
  }

  return null;
}

// ─── Next-run calculation ──────────────────────────────────────────────────────

/**
 * Calculate ms until the next scheduled run.
 * For interval jobs: uses lastRun to compute remaining time.
 * For daily/weekly jobs: finds the next calendar slot after now (or lastRun).
 */
/**
 * Returns true if a daily/weekly job missed its last expected slot.
 * Used to detect catch-up scenarios on restore.
 */
export function hasMissedSlot(parsed: ParsedCron, lastRun?: number, createdAt?: number): boolean {
  if (parsed.type !== "daily" && parsed.type !== "weekly") return false;

  const now = Date.now();
  const hours = parsed.hour != null ? [parsed.hour] : [0];
  const minute = parsed.minute ?? 0;
  const dow = parsed.dow ?? [0, 1, 2, 3, 4, 5, 6];

  // Walk backwards up to 7 days × all hours to find the most recent expected slot
  let mostRecent = -Infinity;
  for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
    for (const hour of hours) {
      const candidate = new Date(now);
      candidate.setSeconds(0, 0);
      candidate.setHours(hour, minute);
      candidate.setTime(candidate.getTime() - dayOffset * 86_400_000);
      if (candidate.getTime() <= now && dow.includes(candidate.getDay())) {
        if (candidate.getTime() > mostRecent) mostRecent = candidate.getTime();
      }
    }
  }

  if (mostRecent === -Infinity) return false;

  // Never ran: catch-up if the most recent slot is after job was created
  if (!lastRun) {
    const anchor = createdAt ?? 0;
    return mostRecent > anchor;
  }

  return mostRecent > lastRun;
}

export function msUntilNextRun(parsed: ParsedCron, lastRun?: number): number {
  const now = Date.now();

  if (parsed.type === "once") {
    return parsed.nextMs ?? 0;
  }

  if (parsed.type === "interval") {
    const interval = parsed.intervalMs ?? 60_000;
    if (!lastRun) return interval;
    const elapsed = now - lastRun;
    const remaining = interval - (elapsed % interval);
    // If remaining is very small (< 1s), run immediately in 1s
    return remaining < 1000 ? 1000 : remaining;
  }

  // daily / weekly
  const hour = parsed.hour ?? 0;
  const minute = parsed.minute ?? 0;
  const dow = parsed.dow ?? [0, 1, 2, 3, 4, 5, 6];

  const candidate = new Date();
  candidate.setSeconds(0, 0);
  candidate.setHours(hour, minute);

  // Find the next matching slot (today or future days)
  for (let offset = 0; offset <= 7; offset++) {
    const d = new Date(candidate.getTime() + offset * 86_400_000);
    if (dow.includes(d.getDay()) && d.getTime() > now) {
      return d.getTime() - now;
    }
  }

  // Fallback: 24h
  return 86_400_000;
}

// ─── CronPiece ────────────────────────────────────────────────────────────────

export class CronPiece implements Piece {
  readonly id = "cron";
  readonly name = "Scheduler";

  private bus!: EventBus;
  private registry: CapabilityRegistry;
  private jobs = new Map<string, CronJob>();
  private counter = 0;
  private delegatePiece?: DelegateTaskPiece;

  constructor(registry: CapabilityRegistry) {
    this.registry = registry;
  }

  /** Inject delegate piece after both are started. Called from main.ts. */
  setDelegatePiece(piece: DelegateTaskPiece): void {
    this.delegatePiece = piece;
  }

  systemContext(): string {
    return [
      "## Scheduler",
      "Tools: cron_create, cron_list, cron_delete",
      "",
      "### cron_create modes",
      "- `mode: \"prompt\"` (default) — fires the prompt into the calling session's LLM at each trigger.",
      "- `mode: \"delegate\"` — spawns an ephemeral Haiku/Sonnet worker directly (no LLM in the loop); result is posted to `reply_to` session as `[CRON delegate \"<id>\"] <summary>`. Use for background checks, monitoring, or any autonomous task that shouldn't consume main session tokens.",
      "",
      "### catch_up",
      "- Only for daily/weekly jobs. If `catch_up: true` and JARVIS restarts after a missed slot, the job fires immediately (1s) instead of waiting for the next scheduled time.",
      "",
      "### Supported cron formats",
      "- `*/N * * * *` — every N minutes",
      "- `once:Ns / once:Nm / once:Nh` — one-shot in N seconds/minutes/hours",
      "- `HH:MM` — daily at HH:MM",
      "- `0 H * * *` — daily at hour H",
      "- `M H * * 1-5` — weekdays only",
    ].join("\n");
  }

  async start(bus: EventBus): Promise<void> {
    this.bus = bus;
    this.registerTools();
    this.restoreJobs();

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
        data: this.getData(),
        position: { x: 10, y: 160 },
        size: { width: 150, height: 40 },
      },
    } as any);

    graphRegistry.setChildren(this.id, () => [...this.jobs.values()].map(j => ({
      id: `cron-${j.id}`,
      label: j.id,
      status: j.recurring ? "running" : "waiting",
      meta: { prompt: j.prompt.slice(0, 40), runs: j.runs },
    })));

    log.info({ restoredJobs: this.jobs.size }, "CronPiece: started");
  }

  async stop(): Promise<void> {
    for (const job of this.jobs.values()) {
      if (job.interval) clearInterval(job.interval);
      if (job.timeout) clearTimeout(job.timeout);
    }
    this.jobs.clear();
    graphRegistry.setChildren(this.id, undefined);
    this.bus.publish({
      channel: "hud.update",
      source: this.id,
      action: "remove",
      pieceId: this.id,
    } as any);
  }

  // ─── Persistence ────────────────────────────────────────────────────────────

  private restoreJobs(): void {
    const settings = loadSettings();
    const persisted = settings.cron?.jobs ?? {};
    let restored = 0;

    for (const [id, p] of Object.entries(persisted)) {
      // Extract highest counter to avoid ID collisions
      const num = parseInt(id.replace("job-", ""));
      if (!isNaN(num) && num > this.counter) this.counter = num;

      const parsed = parseCron(p.cron);
      if (!parsed) {
        log.warn({ id, cron: p.cron }, "CronPiece: skipping persisted job with invalid cron");
        continue;
      }

      // One-shot jobs that already ran are not restored
      if (!p.recurring && p.lastRun) {
        log.debug({ id }, "CronPiece: skipping completed one-shot job");
        continue;
      }

      const job: CronJob = {
        id,
        cron: p.cron,
        prompt: p.prompt,
        target: p.target,
        recurring: p.recurring,
        nextRun: 0,
        createdAt: p.createdAt,
        lastRun: p.lastRun,
        runs: 0,
        source: "tool",
        mode: p.mode,
        role: p.role,
        model: p.model,
        reply_to: p.reply_to,
        catchUp: p.catchUp,
      };

      // Catch-up: if enabled and a slot was missed, fire immediately (1s delay)
      const shouldCatchUp = p.catchUp && hasMissedSlot(parsed, p.lastRun, p.createdAt);
      if (shouldCatchUp) {
        log.info({ id, lastRun: p.lastRun }, "CronPiece: catch-up detected, scheduling immediate execution");
      }

      this.jobs.set(id, job);
      this.scheduleJob(job, parsed, shouldCatchUp ? 1000 : undefined);
      restored++;
    }

    if (restored > 0) {
      log.info({ restored }, "CronPiece: restored persisted jobs");
    }
  }

  private persistJob(job: CronJob): void {
    // Only persist jobs created via tool (not transient/in-memory only)
    const settings = loadSettings();
    if (!settings.cron) settings.cron = { jobs: {} };

    const persisted: PersistedCronJob = {
      cron: job.cron,
      prompt: job.prompt,
      target: job.target,
      recurring: job.recurring,
      createdAt: job.createdAt,
      lastRun: job.lastRun,
      mode: job.mode,
      role: job.role,
      model: job.model,
      reply_to: job.reply_to,
      catchUp: job.catchUp,
    };
    settings.cron.jobs[job.id] = persisted;
    saveSettings(settings);
    invalidateCache();
  }

  private removePersistedJob(id: string): void {
    const settings = loadSettings();
    if (!settings.cron?.jobs) return;
    delete settings.cron.jobs[id];
    saveSettings(settings);
    invalidateCache();
  }

  private updateLastRun(job: CronJob): void {
    const settings = loadSettings();
    if (!settings.cron?.jobs?.[job.id]) return;
    settings.cron.jobs[job.id].lastRun = job.lastRun;
    saveSettings(settings);
    invalidateCache();
  }

  // ─── Scheduling ─────────────────────────────────────────────────────────────

  private executeJob(job: CronJob): void {
    job.runs++;
    job.lastRun = Date.now();
    log.info(
      { jobId: job.id, mode: job.mode ?? "prompt", prompt: job.prompt.slice(0, 50), runs: job.runs, lastRun: new Date(job.lastRun).toISOString() },
      "CronPiece: executing job",
    );

    if (job.mode === "delegate") {
      this.executeDelegateJob(job);
    } else {
      this.bus.publish({
        channel: "ai.request",
        source: "cron",
        target: job.target,
        text: `[CRON job "${job.id}"] ${job.prompt}`,
      } as any);
    }

    // Persist lastRun immediately
    this.updateLastRun(job);
    this.updateHud();

    if (!job.recurring) {
      // One-shot: remove from memory and settings (no need to keep history)
      if (job.interval) clearInterval(job.interval);
      if (job.timeout) clearTimeout(job.timeout);
      this.jobs.delete(job.id);
      this.removePersistedJob(job.id);
      this.updateHud();
    }
  }

  private executeDelegateJob(job: CronJob): void {
    if (!this.delegatePiece) {
      log.warn({ jobId: job.id }, "CronPiece: delegate mode but DelegateTaskPiece not injected — skipping");
      return;
    }

    const replyTo = job.reply_to ?? job.target;

    this.delegatePiece.runDelegate({
      task: job.prompt,
      role: job.role,
      model: job.model,
    }).then(({ summary, error }) => {
      const text = error
        ? `[CRON delegate "${job.id}" ERROR] ${error}`
        : `[CRON delegate "${job.id}"] ${summary}`;

      this.bus.publish({
        channel: "ai.request",
        source: "cron",
        target: replyTo,
        text,
      } as any);

      log.info({ jobId: job.id, replyTo, chars: summary.length, error }, "CronPiece: delegate job completed");
    }).catch((err: unknown) => {
      log.error({ jobId: job.id, err }, "CronPiece: delegate job crashed");
    });
  }

  private scheduleJob(job: CronJob, parsed?: ParsedCron, catchUpDelayMs?: number): void {
    const p = parsed ?? parseCron(job.cron);
    if (!p) return;

    if (p.type === "interval") {
      // Smart: account for time already elapsed since last run
      const firstDelay = msUntilNextRun(p, job.lastRun);
      job.nextRun = Date.now() + firstDelay;

      // Initial delayed run, then setInterval from there
      job.timeout = setTimeout(() => {
        this.executeJob(job);
        if (job.recurring && this.jobs.has(job.id)) {
          job.interval = setInterval(() => this.executeJob(job), p.intervalMs!);
          job.nextRun = Date.now() + p.intervalMs!;
        }
      }, firstDelay);

    } else if (p.type === "once") {
      const delay = p.nextMs ?? 0;
      job.nextRun = Date.now() + delay;
      job.timeout = setTimeout(() => this.executeJob(job), delay);

    } else {
      // daily / weekly — schedule next occurrence, then re-schedule after each run
      const scheduleNext = (overrideDelayMs?: number) => {
        const delay = overrideDelayMs ?? msUntilNextRun(p, job.lastRun);
        job.nextRun = Date.now() + delay;
        job.timeout = setTimeout(() => {
          this.executeJob(job);
          if (job.recurring && this.jobs.has(job.id)) {
            scheduleNext(); // subsequent runs use normal schedule
          }
        }, delay);
      };
      scheduleNext(catchUpDelayMs);
    }
  }

  // ─── Tool registration ───────────────────────────────────────────────────────

  private registerTools(): void {
    this.registry.register({
      name: "cron_create",
      description: "Schedule a prompt to run on a timer. Two modes: 'prompt' (default) sends the prompt to the calling session's LLM; 'delegate' spawns a cheap ephemeral worker (Haiku/Sonnet) directly with no LLM in the loop and posts the result to reply_to. Supports '*/N * * * *' (interval), 'once:Ns/Nm' (one-shot), 'HH:MM' or '0 H * * *' (daily), 'M H * * 1-5' (weekly). Target is always the calling session — never passed by the LLM. Use catch_up:true for daily/weekly jobs that must not miss executions across restarts.",
      input_schema: {
        type: "object",
        properties: {
          cron: { type: "string", description: "Schedule: '*/N * * * *' for every N minutes, 'once:Ns' or 'once:Nm' for one-shot" },
          prompt: { type: "string", description: "The prompt or task description to execute at each trigger" },
          recurring: { type: "boolean", description: "true for recurring (default), false for one-shot" },
          mode: { type: "string", enum: ["prompt", "delegate"], description: "'prompt' (default): sends prompt to the calling session's LLM. 'delegate': runs an ephemeral worker (DelegateTaskPiece) directly — no LLM in the loop, result posted to reply_to session." },
          role: { type: "string", description: "delegate mode only: role for the worker (default: nu-discovery-agent)" },
          model: { type: "string", description: "delegate mode only: model override for the worker (e.g. 'haiku', 'sonnet')" },
          reply_to: { type: "string", description: "delegate mode only: session to receive the result (default: calling session)" },
          catch_up: { type: "boolean", description: "If true, runs immediately on restore if a scheduled slot was missed (daily/weekly only). Default: false." },
        },
        required: ["cron", "prompt"],
      },
      handler: async (input) => {
        const cron = String(input.cron);
        const prompt = String(input.prompt);
        const recurring = input.recurring !== false;
        const mode = (input.mode === "delegate") ? "delegate" : "prompt";
        const role = input.role ? String(input.role) : undefined;
        const model = input.model ? String(input.model) : undefined;
        const reply_to = input.reply_to ? String(input.reply_to) : undefined;
        const catchUp = input.catch_up === true;

        // target is always derived from the calling session — never accepted from the LLM.
        // This prevents cross-session leakage and keeps the API simple.
        const target = typeof input.__sessionId === "string" ? input.__sessionId.trim() : "";
        if (!target) {
          return { ok: false, error: "internal: missing __sessionId; CronPiece could not determine calling session" };
        }

        if (mode === "delegate" && !this.delegatePiece) {
          return { ok: false, error: "delegate mode requires DelegateTaskPiece — not yet available" };
        }

        const parsed = parseCron(cron);
        if (!parsed) {
          return { ok: false, error: `Invalid cron expression: ${cron}. Use '*/N * * * *', 'once:Ns/Nm/Nh', 'HH:MM', or '0 H * * *'` };
        }

        const id = `job-${++this.counter}`;

        const job: CronJob = {
          id, cron, prompt, target, recurring,
          nextRun: 0, createdAt: Date.now(), runs: 0, source: "tool",
          mode, role, model, reply_to, catchUp,
        };
        this.jobs.set(id, job);
        this.scheduleJob(job, parsed);
        // Only persist recurring jobs — one-shots are transient by nature.
        if (recurring) this.persistJob(job);
        this.updateHud();

        const msUntil = msUntilNextRun(parsed);
        log.info({ id, cron, mode, prompt: prompt.slice(0, 50), recurring, msUntil }, "CronPiece: job created");
        return { ok: true, id, cron, mode, recurring, nextRunIn: msUntil };
      },
    });

    this.registry.register({
      name: "cron_list",
      description: "List all scheduled cron jobs.",
      input_schema: { type: "object", properties: {} },
      handler: async () => ({
        jobs: [...this.jobs.values()].map(j => ({
          id: j.id,
          cron: j.cron,
          prompt: j.prompt.slice(0, 100),
          recurring: j.recurring,
          runs: j.runs,
          createdAt: new Date(j.createdAt).toISOString(),
          lastRun: j.lastRun ? new Date(j.lastRun).toISOString() : null,
          nextRun: new Date(j.nextRun).toISOString(),
        })),
      }),
    });

    this.registry.register({
      name: "cron_delete",
      description: "Delete a scheduled cron job by ID.",
      input_schema: {
        type: "object",
        properties: { id: { type: "string", description: "Job ID (e.g. 'job-1')" } },
        required: ["id"],
      },
      handler: async (input) => {
        const id = String(input.id);
        const job = this.jobs.get(id);
        if (!job) return { ok: false, error: `Job not found: ${id}` };
        if (job.interval) clearInterval(job.interval);
        if (job.timeout) clearTimeout(job.timeout);
        this.jobs.delete(id);
        this.removePersistedJob(id);
        this.updateHud();
        return { ok: true };
      },
    });
  }

  // ─── HUD ────────────────────────────────────────────────────────────────────

  private getData(): Record<string, unknown> {
    return {
      jobs: this.jobs.size,
      active: [...this.jobs.values()].filter(j => j.recurring).length,
    };
  }

  private updateHud(): void {
    this.bus.publish({
      channel: "hud.update",
      source: this.id,
      action: "update",
      pieceId: this.id,
      data: this.getData(),
      status: this.jobs.size > 0 ? "running" : "idle",
    } as any);
  }
}
