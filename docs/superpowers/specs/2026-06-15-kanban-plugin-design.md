# jarvis-plugin-kanban — MVP0 Design Spec

**Date:** 2026-06-15  
**Status:** Approved  
**Codename:** kanban  
**Repo:** private GitHub repo

---

## Intent

A personal kanban board plugin for JARVIS. Independent of session tasks — tracks Sir's activities (work, Nu, personal). Persists across restarts via SQLite. The LLM can manage tasks via dedicated tools. The user can also interact via the HUD (drag & drop, inline edit, create).

---

## Scope (MVP0)

- Fixed columns: **To Do → In Progress → Done**
- Tasks with: title, description, priority, delegated_to, due_date, dependencies (hard links)
- LLM tools for full CRUD
- HUD renderer: Trello-like, drag & drop (HTML5 native), inline expand/edit
- SQLite persistence (`~/.jarvis/kanban.db`)
- Private GitHub repo

**Out of scope for MVP0:** custom columns, labels/tags, multiple boards, attachments, comments, column WIP limits.

---

## Architecture

```
jarvis-plugin-kanban/
├── plugin.json
├── package.json              ← better-sqlite3 only dep
├── functional-test.md
├── pieces/
│   ├── index.ts              ← createPieces(ctx)
│   └── kanban-piece.ts       ← Piece: SQLite, tools, HTTP routes, HUD publish
└── renderers/
    └── KanbanRenderer.tsx    ← Trello-like UI, drag & drop
```

### Data flow

```
LLM → tool call → KanbanPiece (SQLite) → publishToHud → KanbanRenderer re-render
User → drag card → fetch POST /plugins/kanban/move → KanbanPiece → publishToHud → re-render
User → click card → expand inline → fetch POST /plugins/kanban/update/:id
User → "+ New Task" → inline form → fetch POST /plugins/kanban/create
```

### Persistence

- **Engine:** `better-sqlite3` (synchronous — no async complexity)
- **File:** `~/.jarvis/kanban.db`
- **Init:** `KanbanPiece.start()` runs `db.exec(CREATE TABLE IF NOT EXISTS ...)` on boot
- Survives JARVIS restarts; data is never in-memory only

---

## Data Model

```sql
CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,        -- nanoid, e.g. "task_abc123"
  title         TEXT NOT NULL,
  description   TEXT,
  column        TEXT NOT NULL DEFAULT 'todo',    -- 'todo' | 'in_progress' | 'done'
  priority      TEXT NOT NULL DEFAULT 'medium',  -- 'low' | 'medium' | 'high' | 'critical'
  delegated_to  TEXT,                    -- free text
  due_date      TEXT,                    -- ISO date string, e.g. "2026-06-20"
  position      INTEGER NOT NULL,        -- sort order within column (drag & drop)
  created_at    TEXT NOT NULL,           -- ISO datetime
  updated_at    TEXT NOT NULL            -- ISO datetime
);

CREATE TABLE IF NOT EXISTS dependencies (
  task_id     TEXT NOT NULL,             -- task that has the dependency
  depends_on  TEXT NOT NULL,             -- task that must be completed first
  PRIMARY KEY (task_id, depends_on),
  FOREIGN KEY (task_id)    REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (depends_on) REFERENCES tasks(id) ON DELETE CASCADE
);
```

### Dependency semantics

- Hard dependency: `task_id` is blocked by `depends_on`
- A task is "blocked" if any of its `depends_on` tasks are NOT in column `'done'`
- Moving a blocked task to `in_progress` is **allowed** but triggers a visual warning

---

## LLM Tools (Capabilities)

| Tool | Required params | Optional params | Description |
|------|----------------|-----------------|-------------|
| `kanban_create_task` | `title` | `description`, `priority`, `delegated_to`, `due_date`, `column` | Creates task (default column: todo) |
| `kanban_update_task` | `id` | `title`, `description`, `priority`, `delegated_to`, `due_date` | Partial update of task fields |
| `kanban_move_task` | `id`, `column` | — | Moves task to column |
| `kanban_delete_task` | `id` | — | Deletes task + cascades dependencies |
| `kanban_add_dependency` | `task_id`, `depends_on_id` | — | Creates hard dependency link |
| `kanban_remove_dependency` | `task_id`, `depends_on_id` | — | Removes dependency link |
| `kanban_list_tasks` | — | `column`, `priority` | Lists tasks, optionally filtered |
| `kanban_get_task` | `id` | — | Full task detail including dependencies |

All tools return `{ ok: true, task? }` or `{ ok: false, error: string }`.

---

## HTTP Routes (HUD → Backend)

| Method | Path | Body | Description |
|--------|------|------|-------------|
| `GET` | `/plugins/kanban/tasks` | — | Full board state (all tasks + deps) |
| `POST` | `/plugins/kanban/create` | `{ title, description?, priority?, delegated_to?, due_date?, column? }` | Create task |
| `POST` | `/plugins/kanban/update/:id` | partial task fields | Update task |
| `POST` | `/plugins/kanban/move` | `{ id, column, position }` | Move + reorder |
| `POST` | `/plugins/kanban/delete/:id` | — | Delete task |
| `POST` | `/plugins/kanban/dependency/add` | `{ task_id, depends_on_id }` | Add dependency |
| `POST` | `/plugins/kanban/dependency/remove` | `{ task_id, depends_on_id }` | Remove dependency |

All write routes respond with the updated full board state so the renderer can re-render atomically.

---

## UI/UX — KanbanRenderer

### Layout

```
┌─────────────────────────────────────────────────────┐
│ 📋 Kanban — Sir's Board   6 tasks · 2 in progress  [+ New Task] │
├──────────────┬──────────────┬───────────────────────┤
│   To Do (3)  │ In Progress  │      Done (1)         │
│              │     (2)      │                       │
│  [card]      │  [card exp.] │  [card faded]         │
│  [card]      │  [card]      │                       │
│  [card]      │              │                       │
│  [+ add]     │              │                       │
└──────────────┴──────────────┴───────────────────────┘
```

### Card — compact view

```
┌──────────────────────────────┐
│ Title of task         [HIGH] │
│ Short description...         │
│ 👤 Gabriel  ⛔ blocked by #4  Jun 20 │
└──────────────────────────────┘
```

### Card — expanded (click to toggle)

Inline expansion within the column:
- Full description
- Delegated to
- Dependencies list (blocked by / blocks)
- Action buttons: Edit | Move ▾ | Delete

### Card states

| State | Visual |
|-------|--------|
| Normal | compact card |
| Hover | indigo border |
| Dragging | opacity 0.4, cursor: grabbing |
| Expanded | click toggles; indigo border, dark bg |
| Blocked (in_progress) | `⛔ blocked by #X` tag |
| Done | opacity 0.6, title strikethrough |

### Drag & Drop (HTML5 native)

```
dragstart  → store task ID in dataTransfer; add .dragging class (opacity 0.4)
dragover   → column highlights (indigo border); prevent default to allow drop
drop       → POST /plugins/kanban/move { id, column, position }
             → if task is blocked AND target column = 'in_progress':
                show yellow warning banner for 3s:
                "⚠️ Task has open dependencies — move allowed"
             → KanbanPiece updates SQLite → publishToHud → renderer re-renders
dragend    → remove .dragging and column highlight classes
```

Position is calculated as `max(position in target column) + 1` on drop (append to bottom). Reordering within same column is supported by the position field but not required in MVP0 UI.

### Inline task creation

- `+ New Task` button (header) OR `+` button on column header → opens mini-form inline at top of To Do column
- Fields: title (required), priority dropdown, delegated_to text
- Submit: Enter key or "Add" button
- Cancel: Escape key

### Warning banner

Yellow dismissible banner, auto-dismiss after 3s:
```
⚠️ Task has open dependencies — move allowed but not recommended
```

---

## Plugin manifest

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

---

## Error handling

- Tool calls: return `{ ok: false, error: "..." }` — never throw
- HTTP routes: respond `{ ok: false, error: "..." }` with appropriate status
- SQLite errors: catch + log via `ctx.log` or `console.error`; never crash the piece
- Dependency cycles: detect before insert (`WITH RECURSIVE` CTE or BFS in JS); return error
- Missing task ID: return `{ ok: false, error: "Task not found" }`

---

## Testing (functional-test.md scenarios)

1. Plugin installs and HUD panel appears
2. LLM creates a task via `kanban_create_task` → appears in To Do
3. LLM moves task to In Progress via `kanban_move_task`
4. LLM updates task fields via `kanban_update_task`
5. LLM adds dependency between two tasks
6. Moving blocked task to In Progress shows warning banner
7. LLM deletes task → disappears from board, dependency cascade works
8. Drag card from To Do to In Progress via UI
9. Inline create via "+ New Task" button
10. Inline expand card shows full details
11. Board state persists after JARVIS restart
12. `kanban_list_tasks` returns correct filtered results
