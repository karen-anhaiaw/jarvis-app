# jarvis-plugin-kanban Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a private JARVIS plugin with a Trello-like personal kanban board, SQLite persistence, LLM tools, and HTML5 drag & drop HUD renderer.

**Architecture:** Single Piece (`KanbanPiece`) owns SQLite via `better-sqlite3`, registers 8 LLM tools, 7 HTTP routes, and publishes to HUD on every write. Frontend renderer (`KanbanRenderer.tsx`) reads state via `useHudPiece` and handles all user interactions via fetch to the backend routes.

**Tech Stack:** TypeScript, better-sqlite3, HTML5 Drag & Drop API, React (injected via `window.__JARVIS_REACT`), `useHudPiece` hook (jarvis-core 2.0+)

---

## File Structure

```
jarvis-plugin-kanban/
├── plugin.json                  ← manifest
├── package.json                 ← better-sqlite3 dep
├── tsconfig.json                ← TypeScript config
├── functional-test.md           ← BDD test scenarios
├── pieces/
│   ├── index.ts                 ← createPieces(ctx) entry point
│   └── kanban-piece.ts          ← KanbanPiece: DB, tools, routes, HUD
└── renderers/
    └── KanbanRenderer.tsx       ← Trello UI: columns, cards, drag&drop
```

**Responsibilities:**
- `kanban-piece.ts` — all backend logic: SQLite schema init, CRUD helpers, 8 capability registrations, 7 HTTP route handlers, HUD publish. Single file, single responsibility.
- `KanbanRenderer.tsx` — all frontend logic: column layout, card compact/expanded views, drag & drop events, inline create form, warning banner. No imports — uses injected globals only.

---

### Task 1: Repository bootstrap

**Files:**
- Create: `plugin.json`
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `pieces/index.ts`

- [ ] **Step 1: Create the GitHub private repo**

```bash
# On GitHub UI: New repo → "jarvis-plugin-kanban" → Private
# Then locally:
mkdir -p ~/dev/personal/jarvis-plugin-kanban
cd ~/dev/personal/jarvis-plugin-kanban
git init
git remote add origin git@github.com:<your-user>/jarvis-plugin-kanban.git
```

- [ ] **Step 2: Create plugin.json**

```json
{
  "name": "jarvis-plugin-kanban",
  "version": "0.1.0",
  "description": "Personal kanban board with SQLite persistence and LLM task management",
  "author": "giovani-barili",
  "entry": "pieces/index.ts",
  "capabilities": {
    "pieces": true,
    "renderers": true
  }
}
```

Save to: `plugin.json`

- [ ] **Step 3: Create package.json**

```json
{
  "name": "jarvis-plugin-kanban",
  "version": "0.1.0",
  "private": true,
  "dependencies": {
    "better-sqlite3": "^9.4.3"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.8"
  }
}
```

Save to: `package.json`

- [ ] **Step 4: Install deps**

```bash
cd ~/dev/personal/jarvis-plugin-kanban
npm install
```

Expected: `node_modules/better-sqlite3/` created, no errors.

- [ ] **Step 5: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist"
  },
  "include": ["pieces/**/*.ts"]
}
```

Save to: `tsconfig.json`

- [ ] **Step 6: Create pieces/index.ts**

```typescript
import type { PluginContext } from "@jarvis/core";
import { KanbanPiece } from "./kanban-piece.js";

export function createPieces(ctx: PluginContext) {
  return [new KanbanPiece(ctx)];
}
```

Save to: `pieces/index.ts`

- [ ] **Step 7: Initial commit**

```bash
cd ~/dev/personal/jarvis-plugin-kanban
echo "node_modules/\ndist/\n*.db" > .gitignore
git add .
git commit -m "chore: bootstrap plugin repo"
git push -u origin main
```

Expected: repo pushed, no errors.

---

### Task 2: SQLite schema + DB helpers in KanbanPiece

**Files:**
- Create: `pieces/kanban-piece.ts`

- [ ] **Step 1: Write the skeleton of KanbanPiece with DB init**

```typescript
// pieces/kanban-piece.ts
import type { Piece, PluginContext, EventBus } from "@jarvis/core";
import Database from "better-sqlite3";
import path from "path";
import os from "os";

// ─── Types ─────────────────────────────────────────────────────

type Column = "todo" | "in_progress" | "done";
type Priority = "low" | "medium" | "high" | "critical";

interface Task {
  id: string;
  title: string;
  description: string | null;
  column: Column;
  priority: Priority;
  delegated_to: string | null;
  due_date: string | null;
  position: number;
  created_at: string;
  updated_at: string;
}

interface TaskWithDeps extends Task {
  blocked_by: string[];   // IDs of tasks this task depends on
  blocks: string[];       // IDs of tasks that depend on this task
  is_blocked: boolean;    // true if any blocked_by task is NOT in 'done'
}

// ─── Helpers ────────────────────────────────────────────────────

function now(): string {
  return new Date().toISOString();
}

function nanoid(): string {
  return "task_" + Math.random().toString(36).slice(2, 10);
}

function sendJson(res: any, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: any): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => { data += chunk.toString(); });
    req.on("end", () => {
      try { resolve(JSON.parse(data || "{}")); }
      catch { resolve({}); }
    });
    req.on("error", reject);
  });
}

const VALID_COLUMNS: Column[] = ["todo", "in_progress", "done"];
const VALID_PRIORITIES: Priority[] = ["low", "medium", "high", "critical"];

function validColumn(v: unknown): Column | null {
  return VALID_COLUMNS.includes(v as Column) ? (v as Column) : null;
}

function validPriority(v: unknown): Priority | null {
  return VALID_PRIORITIES.includes(v as Priority) ? (v as Priority) : null;
}

// ─── Piece ──────────────────────────────────────────────────────

export class KanbanPiece implements Piece {
  readonly id = "kanban-board";
  readonly name = "Kanban Board";

  private bus!: EventBus;
  private ctx: PluginContext;
  private db!: Database.Database;
  private addedToHud = false;
  private unsubRemove?: () => void;

  constructor(ctx: PluginContext) {
    this.ctx = ctx;
  }

  async start(bus: EventBus): Promise<void> {
    this.bus = bus;
    this.initDb();
    this.registerCapabilities();
    this.registerRoutes();
    this.publishToHud();

    // Re-add panel if user closes it
    this.unsubRemove = this.bus.subscribe("hud.update", (msg: any) => {
      if (msg.action === "remove" && msg.pieceId === this.id && msg.source !== this.id) {
        this.addedToHud = false;
      }
    });
  }

  async stop(): Promise<void> {
    this.unsubRemove?.();
    this.db?.close();
    if (this.addedToHud) {
      this.bus.publish({
        channel: "hud.update",
        source: this.id,
        action: "remove",
        pieceId: this.id,
      });
      this.addedToHud = false;
    }
  }

  // ─── DB init ────────────────────────────────────────────────

  private initDb(): void {
    const dbPath = path.join(os.homedir(), ".jarvis", "kanban.db");
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id            TEXT PRIMARY KEY,
        title         TEXT NOT NULL,
        description   TEXT,
        column        TEXT NOT NULL DEFAULT 'todo',
        priority      TEXT NOT NULL DEFAULT 'medium',
        delegated_to  TEXT,
        due_date      TEXT,
        position      INTEGER NOT NULL,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS dependencies (
        task_id     TEXT NOT NULL,
        depends_on  TEXT NOT NULL,
        PRIMARY KEY (task_id, depends_on),
        FOREIGN KEY (task_id)    REFERENCES tasks(id) ON DELETE CASCADE,
        FOREIGN KEY (depends_on) REFERENCES tasks(id) ON DELETE CASCADE
      );
    `);
  }
```

- [ ] **Step 2: Add DB read helpers**

Add to `KanbanPiece` class, after `initDb`:

```typescript
  // ─── DB helpers ─────────────────────────────────────────────

  private getTask(id: string): Task | null {
    return (this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Task) ?? null;
  }

  private getTaskWithDeps(id: string): TaskWithDeps | null {
    const task = this.getTask(id);
    if (!task) return null;
    return this.enrichWithDeps(task);
  }

  private enrichWithDeps(task: Task): TaskWithDeps {
    const blocked_by = (this.db
      .prepare("SELECT depends_on FROM dependencies WHERE task_id = ?")
      .all(task.id) as { depends_on: string }[])
      .map(r => r.depends_on);

    const blocks = (this.db
      .prepare("SELECT task_id FROM dependencies WHERE depends_on = ?")
      .all(task.id) as { task_id: string }[])
      .map(r => r.task_id);

    // blocked if any dependency is NOT done
    const is_blocked = blocked_by.some(depId => {
      const dep = this.getTask(depId);
      return dep && dep.column !== "done";
    });

    return { ...task, blocked_by, blocks, is_blocked };
  }

  private getAllTasks(): TaskWithDeps[] {
    const tasks = this.db.prepare("SELECT * FROM tasks ORDER BY column, position").all() as Task[];
    return tasks.map(t => this.enrichWithDeps(t));
  }

  private nextPosition(column: Column): number {
    const row = this.db
      .prepare("SELECT MAX(position) as maxPos FROM tasks WHERE column = ?")
      .get(column) as { maxPos: number | null };
    return (row.maxPos ?? -1) + 1;
  }

  // Detect dependency cycles using BFS from depends_on upward
  private wouldCreateCycle(taskId: string, dependsOnId: string): boolean {
    // Would creating (taskId → dependsOnId) create a cycle?
    // i.e., is taskId already reachable FROM dependsOnId?
    const visited = new Set<string>();
    const queue = [dependsOnId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === taskId) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      const deps = this.db
        .prepare("SELECT depends_on FROM dependencies WHERE task_id = ?")
        .all(current) as { depends_on: string }[];
      queue.push(...deps.map(d => d.depends_on));
    }
    return false;
  }
```

- [ ] **Step 3: Commit DB layer**

```bash
cd ~/dev/personal/jarvis-plugin-kanban
git add pieces/kanban-piece.ts
git commit -m "feat: sqlite db init and read helpers"
```

---

### Task 3: LLM capabilities (8 tools)

**Files:**
- Modify: `pieces/kanban-piece.ts` — add `registerCapabilities()` method

- [ ] **Step 1: Add `registerCapabilities` skeleton + `kanban_create_task`**

Add to `KanbanPiece` class:

```typescript
  // ─── Capabilities ────────────────────────────────────────────

  private registerCapabilities(): void {
    const reg = this.ctx.capabilityRegistry;

    // ── kanban_create_task ──────────────────────────────────────
    reg.register({
      name: "kanban_create_task",
      description: "Create a new task on the kanban board. Returns the created task.",
      input_schema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Task title (required)." },
          description: { type: "string", description: "Optional task details." },
          priority: { type: "string", enum: ["low", "medium", "high", "critical"], description: "Defaults to 'medium'." },
          delegated_to: { type: "string", description: "Free-text person responsible." },
          due_date: { type: "string", description: "ISO date, e.g. '2026-06-20'." },
          column: { type: "string", enum: ["todo", "in_progress", "done"], description: "Defaults to 'todo'." },
        },
        required: ["title"],
      },
    }, async (args: any) => {
      try {
        const title = String(args.title ?? "").trim();
        if (!title) return { ok: false, error: "title is required" };
        const column: Column = validColumn(args.column) ?? "todo";
        const id = nanoid();
        const ts = now();
        this.db.prepare(`
          INSERT INTO tasks (id, title, description, column, priority, delegated_to, due_date, position, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id,
          title,
          args.description ?? null,
          column,
          validPriority(args.priority) ?? "medium",
          args.delegated_to ?? null,
          args.due_date ?? null,
          this.nextPosition(column),
          ts,
          ts,
        );
        this.publishToHud();
        return { ok: true, task: this.getTaskWithDeps(id) };
      } catch (e) {
        console.error("[kanban] create error", e);
        return { ok: false, error: String(e) };
      }
    });
```

- [ ] **Step 2: Add `kanban_update_task`**

```typescript
    // ── kanban_update_task ─────────────────────────────────────
    reg.register({
      name: "kanban_update_task",
      description: "Update task fields (title, description, priority, delegated_to, due_date). Does NOT move between columns — use kanban_move_task for that.",
      input_schema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Task ID." },
          title: { type: "string" },
          description: { type: "string" },
          priority: { type: "string", enum: ["low", "medium", "high", "critical"] },
          delegated_to: { type: "string" },
          due_date: { type: "string" },
        },
        required: ["id"],
      },
    }, async (args: any) => {
      try {
        const task = this.getTask(args.id);
        if (!task) return { ok: false, error: `Task ${args.id} not found` };
        const fields: string[] = [];
        const values: any[] = [];
        if (args.title !== undefined) { fields.push("title = ?"); values.push(String(args.title).trim()); }
        if (args.description !== undefined) { fields.push("description = ?"); values.push(args.description); }
        if (validPriority(args.priority)) { fields.push("priority = ?"); values.push(args.priority); }
        if (args.delegated_to !== undefined) { fields.push("delegated_to = ?"); values.push(args.delegated_to); }
        if (args.due_date !== undefined) { fields.push("due_date = ?"); values.push(args.due_date); }
        if (fields.length === 0) return { ok: false, error: "No fields to update" };
        fields.push("updated_at = ?"); values.push(now());
        values.push(args.id);
        this.db.prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`).run(...values);
        this.publishToHud();
        return { ok: true, task: this.getTaskWithDeps(args.id) };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    });
```

- [ ] **Step 3: Add `kanban_move_task`**

```typescript
    // ── kanban_move_task ───────────────────────────────────────
    reg.register({
      name: "kanban_move_task",
      description: "Move a task to a different column (todo, in_progress, done).",
      input_schema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Task ID." },
          column: { type: "string", enum: ["todo", "in_progress", "done"], description: "Target column." },
        },
        required: ["id", "column"],
      },
    }, async (args: any) => {
      try {
        const task = this.getTask(args.id);
        if (!task) return { ok: false, error: `Task ${args.id} not found` };
        const column = validColumn(args.column);
        if (!column) return { ok: false, error: `Invalid column: ${args.column}` };
        const position = this.nextPosition(column);
        this.db.prepare("UPDATE tasks SET column = ?, position = ?, updated_at = ? WHERE id = ?")
          .run(column, position, now(), args.id);
        this.publishToHud();
        const updated = this.getTaskWithDeps(args.id)!;
        return { ok: true, task: updated, warning: updated.is_blocked && column === "in_progress"
          ? "Task has open dependencies" : undefined };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    });
```

- [ ] **Step 4: Add `kanban_delete_task`, `kanban_add_dependency`, `kanban_remove_dependency`**

```typescript
    // ── kanban_delete_task ─────────────────────────────────────
    reg.register({
      name: "kanban_delete_task",
      description: "Delete a task and all its dependency links.",
      input_schema: {
        type: "object",
        properties: { id: { type: "string", description: "Task ID." } },
        required: ["id"],
      },
    }, async (args: any) => {
      try {
        const task = this.getTask(args.id);
        if (!task) return { ok: false, error: `Task ${args.id} not found` };
        this.db.prepare("DELETE FROM tasks WHERE id = ?").run(args.id);
        this.publishToHud();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    });

    // ── kanban_add_dependency ──────────────────────────────────
    reg.register({
      name: "kanban_add_dependency",
      description: "Add a hard dependency: task_id is blocked by depends_on_id (depends_on must be done first).",
      input_schema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "The task that will be blocked." },
          depends_on_id: { type: "string", description: "The task that must complete first." },
        },
        required: ["task_id", "depends_on_id"],
      },
    }, async (args: any) => {
      try {
        if (!this.getTask(args.task_id)) return { ok: false, error: `Task ${args.task_id} not found` };
        if (!this.getTask(args.depends_on_id)) return { ok: false, error: `Task ${args.depends_on_id} not found` };
        if (args.task_id === args.depends_on_id) return { ok: false, error: "A task cannot depend on itself" };
        if (this.wouldCreateCycle(args.task_id, args.depends_on_id)) return { ok: false, error: "This dependency would create a cycle" };
        this.db.prepare("INSERT OR IGNORE INTO dependencies (task_id, depends_on) VALUES (?, ?)")
          .run(args.task_id, args.depends_on_id);
        this.publishToHud();
        return { ok: true, task: this.getTaskWithDeps(args.task_id) };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    });

    // ── kanban_remove_dependency ───────────────────────────────
    reg.register({
      name: "kanban_remove_dependency",
      description: "Remove a dependency link between two tasks.",
      input_schema: {
        type: "object",
        properties: {
          task_id: { type: "string" },
          depends_on_id: { type: "string" },
        },
        required: ["task_id", "depends_on_id"],
      },
    }, async (args: any) => {
      try {
        this.db.prepare("DELETE FROM dependencies WHERE task_id = ? AND depends_on = ?")
          .run(args.task_id, args.depends_on_id);
        this.publishToHud();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    });
```

- [ ] **Step 5: Add `kanban_list_tasks` and `kanban_get_task`**

```typescript
    // ── kanban_list_tasks ──────────────────────────────────────
    reg.register({
      name: "kanban_list_tasks",
      description: "List all kanban tasks, optionally filtered by column or priority.",
      input_schema: {
        type: "object",
        properties: {
          column: { type: "string", enum: ["todo", "in_progress", "done"], description: "Filter by column." },
          priority: { type: "string", enum: ["low", "medium", "high", "critical"], description: "Filter by priority." },
        },
      },
    }, async (args: any) => {
      try {
        let tasks = this.getAllTasks();
        if (args.column) tasks = tasks.filter(t => t.column === args.column);
        if (args.priority) tasks = tasks.filter(t => t.priority === args.priority);
        return { ok: true, tasks, total: tasks.length };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    });

    // ── kanban_get_task ────────────────────────────────────────
    reg.register({
      name: "kanban_get_task",
      description: "Get full details of a specific task including dependencies.",
      input_schema: {
        type: "object",
        properties: { id: { type: "string", description: "Task ID." } },
        required: ["id"],
      },
    }, async (args: any) => {
      try {
        const task = this.getTaskWithDeps(args.id);
        if (!task) return { ok: false, error: `Task ${args.id} not found` };
        return { ok: true, task };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    });
  } // end registerCapabilities
```

- [ ] **Step 6: Verify TypeScript compiles**

```bash
cd ~/dev/personal/jarvis-plugin-kanban
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add pieces/kanban-piece.ts
git commit -m "feat: register 8 LLM capability tools"
```

---

### Task 4: HTTP routes + HUD publish

**Files:**
- Modify: `pieces/kanban-piece.ts` — add `registerRoutes()` and `publishToHud()`

- [ ] **Step 1: Add `publishToHud` method**

```typescript
  // ─── HUD publish ────────────────────────────────────────────

  private publishToHud(): void {
    const tasks = this.getAllTasks();
    const byColumn = {
      todo: tasks.filter(t => t.column === "todo"),
      in_progress: tasks.filter(t => t.column === "in_progress"),
      done: tasks.filter(t => t.column === "done"),
    };
    const data = {
      tasks,
      summary: {
        total: tasks.length,
        todo: byColumn.todo.length,
        in_progress: byColumn.in_progress.length,
        done: byColumn.done.length,
      },
    };

    this.addedToHud = true;
    this.bus.publish({
      channel: "hud.update",
      source: this.id,
      action: "add",          // always "add" — HUD treats it as upsert
      pieceId: this.id,
      piece: {
        pieceId: this.id,
        type: "panel",
        name: "Kanban Board",
        status: "running",
        data,
        position: { x: 20, y: 20 },
        size: { width: 960, height: 620 },
        renderer: { plugin: "jarvis-plugin-kanban", file: "KanbanRenderer" },
      },
    });
  }
```

- [ ] **Step 2: Add `registerRoutes` — GET /tasks**

```typescript
  // ─── HTTP routes ─────────────────────────────────────────────

  private registerRoutes(): void {
    // GET /plugins/kanban/tasks — full board state
    this.ctx.registerRoute("GET", "/plugins/kanban/tasks", (_req: any, res: any) => {
      try {
        const tasks = this.getAllTasks();
        sendJson(res, 200, { ok: true, tasks });
      } catch (e) {
        sendJson(res, 500, { ok: false, error: String(e) });
      }
    });
```

- [ ] **Step 3: Add POST routes (create, update, move, delete)**

```typescript
    // POST /plugins/kanban/create
    this.ctx.registerRoute("POST", "/plugins/kanban/create", async (req: any, res: any) => {
      try {
        const body = await readJsonBody(req);
        const title = String(body.title ?? "").trim();
        if (!title) return sendJson(res, 400, { ok: false, error: "title is required" });
        const column: Column = validColumn(body.column) ?? "todo";
        const id = nanoid();
        const ts = now();
        this.db.prepare(`
          INSERT INTO tasks (id, title, description, column, priority, delegated_to, due_date, position, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, title, body.description ?? null, column,
          validPriority(body.priority) ?? "medium",
          body.delegated_to ?? null, body.due_date ?? null,
          this.nextPosition(column), ts, ts);
        this.publishToHud();
        sendJson(res, 200, { ok: true, task: this.getTaskWithDeps(id), tasks: this.getAllTasks() });
      } catch (e) {
        sendJson(res, 500, { ok: false, error: String(e) });
      }
    });

    // POST /plugins/kanban/update/:id
    this.ctx.registerRoute("POST", "/plugins/kanban/update/", async (req: any, res: any) => {
      const id = req.url?.split("/plugins/kanban/update/")[1]?.split("?")[0];
      if (!id) return sendJson(res, 400, { ok: false, error: "Missing task id" });
      try {
        const task = this.getTask(id);
        if (!task) return sendJson(res, 404, { ok: false, error: `Task ${id} not found` });
        const body = await readJsonBody(req);
        const fields: string[] = [];
        const values: any[] = [];
        if (body.title !== undefined) { fields.push("title = ?"); values.push(String(body.title).trim()); }
        if (body.description !== undefined) { fields.push("description = ?"); values.push(body.description); }
        if (validPriority(body.priority)) { fields.push("priority = ?"); values.push(body.priority); }
        if (body.delegated_to !== undefined) { fields.push("delegated_to = ?"); values.push(body.delegated_to); }
        if (body.due_date !== undefined) { fields.push("due_date = ?"); values.push(body.due_date); }
        if (fields.length > 0) {
          fields.push("updated_at = ?"); values.push(now()); values.push(id);
          this.db.prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`).run(...values);
        }
        this.publishToHud();
        sendJson(res, 200, { ok: true, task: this.getTaskWithDeps(id), tasks: this.getAllTasks() });
      } catch (e) {
        sendJson(res, 500, { ok: false, error: String(e) });
      }
    });

    // POST /plugins/kanban/move
    this.ctx.registerRoute("POST", "/plugins/kanban/move", async (req: any, res: any) => {
      try {
        const body = await readJsonBody(req);
        const task = this.getTask(body.id);
        if (!task) return sendJson(res, 404, { ok: false, error: `Task ${body.id} not found` });
        const column = validColumn(body.column);
        if (!column) return sendJson(res, 400, { ok: false, error: `Invalid column: ${body.column}` });
        const position = typeof body.position === "number" ? body.position : this.nextPosition(column);
        this.db.prepare("UPDATE tasks SET column = ?, position = ?, updated_at = ? WHERE id = ?")
          .run(column, position, now(), body.id);
        this.publishToHud();
        const updated = this.getTaskWithDeps(body.id)!;
        sendJson(res, 200, {
          ok: true,
          task: updated,
          tasks: this.getAllTasks(),
          warning: updated.is_blocked && column === "in_progress"
            ? "Task has open dependencies — move allowed but not recommended" : undefined,
        });
      } catch (e) {
        sendJson(res, 500, { ok: false, error: String(e) });
      }
    });

    // POST /plugins/kanban/delete/:id
    this.ctx.registerRoute("POST", "/plugins/kanban/delete/", async (req: any, res: any) => {
      const id = req.url?.split("/plugins/kanban/delete/")[1]?.split("?")[0];
      if (!id) return sendJson(res, 400, { ok: false, error: "Missing task id" });
      try {
        if (!this.getTask(id)) return sendJson(res, 404, { ok: false, error: `Task ${id} not found` });
        this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
        this.publishToHud();
        sendJson(res, 200, { ok: true, tasks: this.getAllTasks() });
      } catch (e) {
        sendJson(res, 500, { ok: false, error: String(e) });
      }
    });
```

- [ ] **Step 4: Add dependency routes**

```typescript
    // POST /plugins/kanban/dependency/add
    this.ctx.registerRoute("POST", "/plugins/kanban/dependency/add", async (req: any, res: any) => {
      try {
        const body = await readJsonBody(req);
        if (!this.getTask(body.task_id)) return sendJson(res, 404, { ok: false, error: `Task ${body.task_id} not found` });
        if (!this.getTask(body.depends_on_id)) return sendJson(res, 404, { ok: false, error: `Task ${body.depends_on_id} not found` });
        if (body.task_id === body.depends_on_id) return sendJson(res, 400, { ok: false, error: "A task cannot depend on itself" });
        if (this.wouldCreateCycle(body.task_id, body.depends_on_id)) return sendJson(res, 400, { ok: false, error: "Dependency would create a cycle" });
        this.db.prepare("INSERT OR IGNORE INTO dependencies (task_id, depends_on) VALUES (?, ?)").run(body.task_id, body.depends_on_id);
        this.publishToHud();
        sendJson(res, 200, { ok: true, tasks: this.getAllTasks() });
      } catch (e) {
        sendJson(res, 500, { ok: false, error: String(e) });
      }
    });

    // POST /plugins/kanban/dependency/remove
    this.ctx.registerRoute("POST", "/plugins/kanban/dependency/remove", async (req: any, res: any) => {
      try {
        const body = await readJsonBody(req);
        this.db.prepare("DELETE FROM dependencies WHERE task_id = ? AND depends_on = ?").run(body.task_id, body.depends_on_id);
        this.publishToHud();
        sendJson(res, 200, { ok: true, tasks: this.getAllTasks() });
      } catch (e) {
        sendJson(res, 500, { ok: false, error: String(e) });
      }
    });
  } // end registerRoutes
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add pieces/kanban-piece.ts
git commit -m "feat: http routes and hud publish"
```

---

### Task 5: KanbanRenderer — layout, columns, card compact view

**Files:**
- Create: `renderers/KanbanRenderer.tsx`

- [ ] **Step 1: Create renderer skeleton with types and CSS**

```tsx
// renderers/KanbanRenderer.tsx
// Trello-like kanban board renderer.
// React + hooks injected via window.__JARVIS_REACT and window.__JARVIS_HUD_HOOKS.
// No imports — all globals.

declare const useHudPiece: ((id: string) => any) | undefined;

// ─── Types ─────────────────────────────────────────────────────

interface Task {
  id: string;
  title: string;
  description: string | null;
  column: "todo" | "in_progress" | "done";
  priority: "low" | "medium" | "high" | "critical";
  delegated_to: string | null;
  due_date: string | null;
  position: number;
  created_at: string;
  updated_at: string;
  blocked_by: string[];
  blocks: string[];
  is_blocked: boolean;
}

interface BoardData {
  tasks: Task[];
  summary: { total: number; todo: number; in_progress: number; done: number };
}

// ─── Constants ─────────────────────────────────────────────────

const COLUMNS = [
  { id: "todo",        label: "To Do",       color: "#6b7280" },
  { id: "in_progress", label: "In Progress", color: "#6366f1" },
  { id: "done",        label: "Done",        color: "#22c55e" },
] as const;

const PRIORITY_BADGE: Record<string, { bg: string; color: string; label: string }> = {
  critical: { bg: "#7f1d1d", color: "#fca5a5", label: "CRIT" },
  high:     { bg: "#78350f", color: "#fcd34d", label: "HIGH" },
  medium:   { bg: "#1e3a5f", color: "#93c5fd", label: "MED"  },
  low:      { bg: "#1e293b", color: "#94a3b8", label: "LOW"  },
};

// ─── HTTP helpers ───────────────────────────────────────────────

async function postJson(path: string, body?: unknown): Promise<any> {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.json().catch(() => ({}));
  } catch (e) {
    console.error("[kanban-renderer] HTTP failed:", path, e);
    return { ok: false, error: String(e) };
  }
}
```

- [ ] **Step 2: Write main export component with header + columns layout**

```tsx
// ─── Root component ─────────────────────────────────────────────

export default function KanbanRenderer({ state }: { state: any }) {
  const { useState, useMemo, useCallback } = window.__JARVIS_REACT;
  const piece = typeof useHudPiece !== "undefined" ? useHudPiece(state.id) : null;
  const data: BoardData = ((piece?.data ?? state.data) as BoardData) ?? { tasks: [], summary: { total: 0, todo: 0, in_progress: 0, done: 0 } };
  const tasks = data.tasks ?? [];
  const summary = data.summary;

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [dragOverCol, setDragOverCol] = useState<string | null>(null);

  const tasksByColumn = useMemo(() => ({
    todo:        tasks.filter(t => t.column === "todo").sort((a, b) => a.position - b.position),
    in_progress: tasks.filter(t => t.column === "in_progress").sort((a, b) => a.position - b.position),
    done:        tasks.filter(t => t.column === "done").sort((a, b) => a.position - b.position),
  }), [tasks]);

  const showWarning = useCallback((msg: string) => {
    setWarning(msg);
    setTimeout(() => setWarning(null), 3000);
  }, []);

  const handleMove = useCallback(async (taskId: string, column: string) => {
    const result = await postJson("/plugins/kanban/move", { id: taskId, column });
    if (result.warning) showWarning(result.warning);
  }, [showWarning]);

  return (
    <div style={{ background: "#0f1117", color: "#e2e8f0", fontFamily: "'Inter', -apple-system, sans-serif", minHeight: "100%", display: "flex", flexDirection: "column" }}>
      {/* CSS */}
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        .k-card { background: #252836; border-radius: 8px; border: 1px solid #2d3148; padding: 11px 12px; cursor: pointer; transition: border-color 0.15s; margin-bottom: 8px; }
        .k-card:hover { border-color: #6366f1; }
        .k-card.expanded { border-color: #6366f1; background: #1e2130; }
        .k-card.done-card { opacity: 0.6; }
        .k-card.dragging { opacity: 0.4; }
        .k-col { transition: border-color 0.15s; }
        .k-col.drag-over { border-color: #6366f1 !important; background: #1a1d35; }
        .k-btn { padding: 5px 10px; border-radius: 5px; border: none; font-size: 11px; font-weight: 500; cursor: pointer; font-family: inherit; }
        .k-btn-primary { background: #6366f1; color: white; }
        .k-btn-ghost { background: transparent; color: #9ca3af; border: 1px solid #2d3148; }
        .k-btn-danger { background: transparent; color: #f87171; border: 1px solid #7f1d1d; }
        .k-input { background: #1a1d27; border: 1px solid #4b5563; border-radius: 6px; color: #e2e8f0; font-size: 13px; padding: 6px 8px; font-family: inherit; outline: none; width: 100%; }
        .k-input:focus { border-color: #6366f1; }
      `}</style>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", background: "#1a1d27", borderBottom: "1px solid #2d3148", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 16 }}>📋</span>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Sir's Kanban Board</div>
            <div style={{ fontSize: 11, color: "#6b7280" }}>{summary.total} tasks · {summary.in_progress} in progress</div>
          </div>
        </div>
        <button className="k-btn k-btn-primary" onClick={() => setShowAddForm(true)}>+ New Task</button>
      </div>

      {/* Warning banner */}
      {warning && (
        <div style={{ background: "#78350f", color: "#fcd34d", padding: "8px 16px", fontSize: 12, textAlign: "center", borderBottom: "1px solid #92400e" }}>
          ⚠️ {warning}
        </div>
      )}

      {/* Board */}
      <div style={{ display: "flex", gap: 14, padding: 16, overflowX: "auto", flex: 1, alignItems: "flex-start" }}>
        {COLUMNS.map(col => (
          <Column
            key={col.id}
            col={col}
            tasks={(tasksByColumn as any)[col.id]}
            allTasks={tasks}
            expandedId={expandedId}
            setExpandedId={setExpandedId}
            onMove={handleMove}
            isDragOver={dragOverCol === col.id}
            setDragOverCol={setDragOverCol}
            showAddForm={showAddForm && col.id === "todo"}
            onAddFormClose={() => setShowAddForm(false)}
            onAddFormOpen={() => setShowAddForm(true)}
          />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Write Column component**

```tsx
function Column({ col, tasks, allTasks, expandedId, setExpandedId, onMove, isDragOver, setDragOverCol, showAddForm, onAddFormClose, onAddFormOpen }: any) {
  const { useState } = window.__JARVIS_REACT;

  const handleDragOver = (e: any) => {
    e.preventDefault();
    setDragOverCol(col.id);
  };

  const handleDragLeave = () => setDragOverCol(null);

  const handleDrop = async (e: any) => {
    e.preventDefault();
    setDragOverCol(null);
    const taskId = e.dataTransfer.getData("text/plain");
    if (taskId) await onMove(taskId, col.id);
  };

  return (
    <div
      className={`k-col${isDragOver ? " drag-over" : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      style={{ width: 280, flexShrink: 0, background: "#1a1d27", borderRadius: 10, border: "1px solid #2d3148", display: "flex", flexDirection: "column", maxHeight: "calc(100vh - 130px)" }}
    >
      {/* Column header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px", borderBottom: "1px solid #2d3148" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: col.color }} />
          <span style={{ fontSize: 12, fontWeight: 600 }}>{col.label}</span>
          <span style={{ fontSize: 10, background: "#2d3148", color: "#9ca3af", padding: "1px 6px", borderRadius: 20 }}>{tasks.length}</span>
        </div>
        {col.id === "todo" && (
          <button onClick={onAddFormOpen} style={{ background: "none", border: "none", color: "#6b7280", cursor: "pointer", fontSize: 15, padding: "0 2px" }}>+</button>
        )}
      </div>

      {/* Cards */}
      <div style={{ padding: "8px", overflowY: "auto", flex: 1, display: "flex", flexDirection: "column" }}>
        {showAddForm && <AddTaskForm onClose={onAddFormClose} />}
        {tasks.length === 0 && !showAddForm && (
          <div style={{ textAlign: "center", color: "#374151", fontSize: 12, padding: "20px 0" }}>No tasks</div>
        )}
        {tasks.map((task: Task) => (
          <Card
            key={task.id}
            task={task}
            allTasks={allTasks}
            expanded={expandedId === task.id}
            onToggle={() => setExpandedId(expandedId === task.id ? null : task.id)}
            onMove={onMove}
          />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Write Card component (compact + expanded)**

```tsx
function Card({ task, allTasks, expanded, onToggle, onMove }: any) {
  const { useState } = window.__JARVIS_REACT;
  const badge = PRIORITY_BADGE[task.priority] ?? PRIORITY_BADGE.medium;
  const isDone = task.column === "done";
  const [dragging, setDragging] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(task.title);

  const handleDragStart = (e: any) => {
    e.dataTransfer.setData("text/plain", task.id);
    e.dataTransfer.effectAllowed = "move";
    setDragging(true);
  };
  const handleDragEnd = () => setDragging(false);

  const saveEdit = async () => {
    if (editTitle.trim() && editTitle !== task.title) {
      await postJson(`/plugins/kanban/update/${task.id}`, { title: editTitle.trim() });
    }
    setEditing(false);
  };

  const handleDelete = async (e: any) => {
    e.stopPropagation();
    if (confirm(`Delete "${task.title}"?`)) {
      await postJson(`/plugins/kanban/delete/${task.id}`);
    }
  };

  const blockedByTasks = allTasks.filter((t: Task) => task.blocked_by.includes(t.id));
  const blocksTasks = allTasks.filter((t: Task) => task.blocks.includes(t.id));

  return (
    <div
      draggable
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onClick={onToggle}
      className={`k-card${expanded ? " expanded" : ""}${isDone ? " done-card" : ""}${dragging ? " dragging" : ""}`}
      style={{ cursor: dragging ? "grabbing" : "grab" }}
    >
      {/* Compact row: title + badge */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 6, marginBottom: 4 }}>
        <span style={{ fontSize: 12, fontWeight: 500, flex: 1, lineHeight: 1.4, textDecoration: isDone ? "line-through" : "none", color: isDone ? "#6b7280" : "#e2e8f0" }}>
          {task.title}
        </span>
        <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 5px", borderRadius: 4, background: badge.bg, color: badge.color, flexShrink: 0 }}>
          {badge.label}
        </span>
      </div>

      {/* Meta row */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 4 }}>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
          {task.delegated_to && (
            <span style={{ fontSize: 10, padding: "1px 5px", borderRadius: 4, background: "#1a2e1a", color: "#86efac" }}>👤 {task.delegated_to}</span>
          )}
          {task.is_blocked && (
            <span style={{ fontSize: 10, padding: "1px 5px", borderRadius: 4, background: "#2d1515", color: "#f87171" }}>
              ⛔ blocked by {task.blocked_by.length}
            </span>
          )}
          {task.blocks.length > 0 && !task.is_blocked && (
            <span style={{ fontSize: 10, padding: "1px 5px", borderRadius: 4, background: "#1e1a2e", color: "#c4b5fd" }}>
              🔒 blocks {task.blocks.length}
            </span>
          )}
        </div>
        {task.due_date && (
          <span style={{ fontSize: 10, color: "#4b5563" }}>{task.due_date.slice(5)}</span>
        )}
      </div>

      {/* Expanded section */}
      {expanded && (
        <div onClick={(e: any) => e.stopPropagation()} style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid #2d3148" }}>
          {task.description && (
            <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 8, lineHeight: 1.5 }}>{task.description}</div>
          )}
          {blockedByTasks.length > 0 && (
            <div style={{ marginBottom: 6 }}>
              <div style={{ fontSize: 10, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 3 }}>Blocked by</div>
              {blockedByTasks.map((t: Task) => (
                <div key={t.id} style={{ fontSize: 11, color: t.column === "done" ? "#22c55e" : "#f87171" }}>
                  {t.column === "done" ? "✅" : "⛔"} {t.title}
                </div>
              ))}
            </div>
          )}
          {blocksTasks.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 10, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 3 }}>Blocks</div>
              {blocksTasks.map((t: Task) => (
                <div key={t.id} style={{ fontSize: 11, color: "#c4b5fd" }}>🔒 {t.title}</div>
              ))}
            </div>
          )}
          {/* Action buttons */}
          <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
            {task.column !== "todo"        && <button className="k-btn k-btn-ghost" onClick={() => onMove(task.id, "todo")}>← To Do</button>}
            {task.column !== "in_progress" && <button className="k-btn k-btn-ghost" onClick={() => onMove(task.id, "in_progress")}>▶ In Progress</button>}
            {task.column !== "done"        && <button className="k-btn k-btn-ghost" onClick={() => onMove(task.id, "done")}>✓ Done</button>}
            <button className="k-btn k-btn-danger" onClick={handleDelete}>🗑 Delete</button>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Write AddTaskForm component**

```tsx
function AddTaskForm({ onClose }: any) {
  const { useState } = window.__JARVIS_REACT;
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState("medium");
  const [delegated_to, setDelegatedTo] = useState("");

  const submit = async () => {
    if (!title.trim()) return;
    await postJson("/plugins/kanban/create", { title: title.trim(), priority, delegated_to: delegated_to || null });
    onClose();
  };

  const handleKeyDown = (e: any) => {
    if (e.key === "Enter") submit();
    if (e.key === "Escape") onClose();
  };

  return (
    <div style={{ background: "#1a1d27", border: "1px dashed #4b5563", borderRadius: 8, padding: 10, marginBottom: 8 }} onClick={(e: any) => e.stopPropagation()}>
      <input autoFocus className="k-input" placeholder="Task title..." value={title} onChange={(e: any) => setTitle(e.target.value)} onKeyDown={handleKeyDown} style={{ marginBottom: 6 }} />
      <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
        <select className="k-input" value={priority} onChange={(e: any) => setPriority(e.target.value)} style={{ width: "auto" }}>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
          <option value="critical">Critical</option>
        </select>
        <input className="k-input" placeholder="Delegate to..." value={delegated_to} onChange={(e: any) => setDelegatedTo(e.target.value)} onKeyDown={handleKeyDown} />
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <button className="k-btn k-btn-primary" onClick={submit}>Add</button>
        <button className="k-btn k-btn-ghost" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Commit renderer**

```bash
git add renderers/KanbanRenderer.tsx
git commit -m "feat: kanban renderer with drag&drop, expand, add form"
```

---

### Task 6: functional-test.md

**Files:**
- Create: `functional-test.md`

- [ ] **Step 1: Write functional-test.md**

```markdown
# jarvis-plugin-kanban — Functional Tests

## Scenario 1: Plugin installs and HUD panel appears

Given JARVIS is running
When I install jarvis-plugin-kanban
Then the Kanban Board panel appears in the HUD
And the board shows 3 columns: To Do, In Progress, Done
And all columns are empty

## Scenario 2: LLM creates a task

Given the plugin is installed
When I call kanban_create_task with title "Buy groceries" and priority "low"
Then the tool returns { ok: true, task: { id: "task_...", column: "todo" } }
And the card "Buy groceries" appears in the To Do column with LOW badge

## Scenario 3: LLM moves a task to In Progress

Given a task exists in To Do
When I call kanban_move_task with id and column "in_progress"
Then the task moves to the In Progress column in the HUD

## Scenario 4: LLM updates task fields

Given a task exists
When I call kanban_update_task with id and priority "high" and delegated_to "Gabriel"
Then the badge updates to HIGH and "👤 Gabriel" tag appears on the card

## Scenario 5: LLM adds a dependency

Given task A and task B exist
When I call kanban_add_dependency with task_id=A and depends_on_id=B
Then task A shows "⛔ blocked by 1" tag
And task B shows "🔒 blocks 1" tag

## Scenario 6: Warning banner on blocked move

Given task A depends on task B (B is in To Do)
When I drag task A to the In Progress column
Then the yellow warning banner appears: "Task has open dependencies — move allowed but not recommended"
And task A is now in In Progress (move is NOT blocked)
And the banner auto-dismisses after 3 seconds

## Scenario 7: LLM deletes a task — cascade

Given task A depends on task B
When I call kanban_delete_task with id=B
Then task B disappears from the board
And task A no longer shows the blocked tag (dependency was cascaded)

## Scenario 8: Drag card via UI

Given a task exists in To Do
When I drag the card to the In Progress column
Then the column highlights (indigo border) during drag
And on drop the card appears in In Progress
And the HUD re-renders without page refresh

## Scenario 9: Inline create via "+ New Task" button

Given the board is visible
When I click "+ New Task" in the header
Then an inline form appears at the top of the To Do column
When I type a title and press Enter
Then a new card appears in To Do with the typed title

## Scenario 10: Inline card expand

Given a task exists with description, delegated_to, and a dependency
When I click the card
Then it expands inline showing: full description, delegated_to, blocked-by / blocks lists
And action buttons appear: ← To Do, ▶ In Progress, ✓ Done, 🗑 Delete
When I click the card again
Then it collapses

## Scenario 11: Persistence after restart

Given 3 tasks exist across columns
When JARVIS restarts
Then the board re-appears with the same 3 tasks in the same columns

## Scenario 12: kanban_list_tasks filtering

Given tasks exist in multiple columns and priorities
When I call kanban_list_tasks with column "todo"
Then only tasks in the To Do column are returned
When I call kanban_list_tasks with priority "critical"
Then only critical-priority tasks are returned

## Scenario 13: Cycle detection

Given task A exists and task B exists
When I call kanban_add_dependency with task_id=A depends_on_id=B (success)
And I call kanban_add_dependency with task_id=B depends_on_id=A
Then the second call returns { ok: false, error: "Dependency would create a cycle" }
```

- [ ] **Step 2: Commit**

```bash
git add functional-test.md
git commit -m "test: add functional-test.md with 13 BDD scenarios"
```

---

### Task 7: Install in JARVIS and run functional tests

- [ ] **Step 1: Push to GitHub**

```bash
cd ~/dev/personal/jarvis-plugin-kanban
git push origin main
```

- [ ] **Step 2: Install in JARVIS**

In JARVIS chat:
```
Install plugin: github.com/<your-user>/jarvis-plugin-kanban
```

Expected: plugin installs, JARVIS loads, Kanban Board panel appears in HUD.

- [ ] **Step 3: Run ALL scenarios from functional-test.md**

Execute each scenario one by one — use JARVIS chat to trigger LLM tool calls, and UI to test drag & drop, inline forms, expand.

- [ ] **Step 4: Fix any failures and commit**

```bash
git add -A
git commit -m "fix: <describe what was fixed>"
git push
```

- [ ] **Step 5: Re-run affected scenarios until all 13 pass**

**Installation is NOT complete until all 13 scenarios pass.**
