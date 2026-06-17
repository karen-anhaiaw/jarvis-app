# CapabilityRegistry — `app/src/capabilities/registry.ts`

## Responsibility

Single source of truth for AI-callable tools (capabilities) and chat slash
commands. Stores definitions, executes calls (parallel, with progress
streaming), and derives slash-menu metadata for the UI.

## Key types

| Type | Purpose |
|---|---|
| `CapabilityDefinition` | `name`, `description`, `input_schema`, `handler`, `supportsProgress?`, `category?` |
| `CapabilityHandler` | `(input, onProgress?) => Promise<unknown>` |
| `SlashCommand` / `SlashCommandResult` | plugin-registered `/commands` with `inject`/`message`/`dispatch` outcomes |
| `SlashCommandContext` | carries `sessionId` of the session that typed the slash |
| `CapabilityExecutionListener` | `(toolName, isError, timeMs)` — metrics hook |

## Methods

- `register(def)` — upsert a tool by name.
- `getDefinitions()` — name/description/schema projection sent to the LLM API.
- `execute(calls, onProgress?)` — runs all calls via `Promise.all`. Content-block
  arrays (image/text/document) pass through untouched; everything else is
  JSON-stringified. Errors become `{ error }` results with `is_error: true`.
- `registerSlashCommand` / `unregisterSlashCommand` / `getSlashCommand`.
- `getSlashCommands()` — UI metadata: plugin slash commands (category = `source`)
  + capability-derived commands (category = declarative, see below).
- `onExecution(listener)` — subscribe to execution metrics.
- `names` / `size` — introspection getters.

## Invariants

1. **Declarative categories (F3.15).** `category` is declared by the tool's
   OWNER at registration. The registry must NOT maintain per-tool name lists —
   it only applies two STRUCTURAL fallbacks in `getSlashCommands()`:
   `name.startsWith("mcp__")` → `"mcp"`, else `"general"`. Adding a tool name
   list back into the registry is a regression.
2. **Tool names are globally unique** — `register` overwrites silently by name;
   registrars own collision avoidance (MCP prefixes with `mcp__<server>__`).
3. The registry never inspects `input.__sessionId` / `__toolUseId` — executor
   context fields are a contract between CapabilityExecutor and handlers.
4. `CapabilityDefinition` mirrors the public interface in
   `packages/core/src/tools.ts` — changes there follow COMPATIBILITY.md semver
   (category added in 0.7.0, MINOR).

## Category declaration sites (core)

| Registrar | Category |
|---|---|
| `capabilities/*.json` (loader) | per-file `"category"` field (filesystem/web/system/hud) |
| `core/cron-piece.ts` | `cron` |
| `core/piece-manager.ts` | `hud` |
| `core/plugin-manager.ts` (plugin_*) | `plugins` |
| `core/plugin-manager.ts` (plugin JSON tools) | pass-through from tool config |
| `input/grpc-piece.ts` | `grpc` |
| `mcp/manager.ts` | `mcp` (explicit; prefix fallback would also apply) |
| `pieces/diff-viewer.ts` | `hud` |
| `main.ts` (clear_session) | `system` |
| `main.ts` (model_set/model_get) | `model` |
| `main.ts` (jarvis_eval), session-inspector, choice-prompt, delegate-task | none → `general` |

## BDD / Tests

- BDD: `docs/features/bdd/declarative-tool-categories.feature`
- Tests: `app/src/capabilities/registry.test.ts`
