# @jarvis/core — Changelog

All notable changes to this package will be documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.1] — 2026-05-27

### Added
- `PluginLogger` interface and `PluginContext.log` field — plugins receive the core
  pino logger as a child scoped to `{ plugin: name }`. Entries land in `jarvis.log`
  without bundling pino. Use `ctx.log.info(...)` instead of `console.*` in plugins.

## [0.3.0] — 2026-05-08

### Added

- **`registerContextInjector(fn)`** in `PluginContext`. Plugins can register an ephemeral context injector that runs per-turn before `sendAndStream`. The callback receives `sessionId` and returns `string[] | Promise<string[]>`. Each returned string becomes a user-message block with `cache_control:ephemeral` — keeps the system-prompt cache warm while still letting plugins inject mutable per-turn context (e.g. Mnemosyne memory). Multiple plugins compose via an aggregator that runs them in parallel (`Promise.allSettled`).
- **`ChatTimelineEntry` + `ChatTimelineMessage` types** and the `chat.timeline` bus channel. New `PluginContext.addChatTimelineEntry()` API lets plugins push structured, plugin-rendered entries into the chat timeline (loaded lazily on the frontend from `/plugins/<plugin>/renderers/<file>.js`).

### Changed

- `ContextInjectorFn` signature simplified: returns `string[] | Promise<string[]>` (was `InjectedContext[]`). `role` and `cache_control` are fixed by the core — callers no longer specify them. The session no longer pushes synthetic `Understood.` assistant turns; injected content is concatenated as ephemeral blocks into the actual user message. Removes the `_injected` marker scheme, `removeInjectedContext()` scans, `stripInjectedMarkers()`, and `hasPendingToolUse()` guards.
- Version aligned with app release cadence. `@jarvis/core` now tracks `app` major.minor (0.3.x); patch increments for additive API changes within a release.

### Fixed

- Async injectors no longer silently dropped. Previously the aggregator filtered with `Array.isArray`, discarding any `Promise<string[]>` result and producing an empty injection. Aggregator now awaits via `Promise.allSettled` before collecting.

### Notes for plugin authors

- Prefer `registerContextInjector` over `Piece.systemContext` for any context that mutates per-turn — `systemContext` rebuilds the system prompt and invalidates prompt cache; injectors don't.

---

## [0.6.0] — 2026-04-29

### Added — Optional `traceId` on `BusMessage`

`BusMessage` (and every channel message that extends it) gained an optional
`traceId?: string` field. Producers MAY set a short hex id (e.g. `"a3f10b9c"`)
on the originating publish; downstream pieces propagate it on every follow-up
publish so a single conversation turn can be filtered end-to-end in the logs
(`grep traceId=a3f10b9c jarvis.log`).

Backward compatible:
- Plugins that don't set `traceId` continue to work — the bus auto-fills a
  fresh id on publish so logs are always correlatable, just without
  cross-message linkage.
- Plugins reading messages can ignore `traceId` entirely; it's an additive
  optional field on existing interfaces.

#### Recommended pattern for plugin authors

When your plugin originates a new conversation turn (e.g. a webhook, a cron
trigger, an actor dispatch), generate a fresh trace id and pass it on the
first publish:

```ts
import { newTraceId } from "../logger/trace.js"; // host app helper, not exported by core

const traceId = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
bus.publish({ channel: "ai.request", source: "my-plugin", target: "main", text: "...", traceId });
```

When you forward or react to a message, copy the incoming traceId onto your
publishes so the chain stays linked.

## [0.5.0] — 2026-04-28

### Added — `AISession.setStickyModelOverride` and `AISession.setToolFilter`

Two new optional methods on `AISession`:

- `setStickyModelOverride(model: string | undefined)` — sets a sticky model
  override for ALL subsequent calls on this session. Pass `undefined` to clear
  and revert to the global config model.

- `setToolFilter(filter: ((toolName: string) => boolean) | undefined)` — sets
  a per-session tool filter. Only tools matching the filter are sent to the
  model. Pass `undefined` to clear (all tools visible). The filter is applied
  on every API call — tools registered AFTER the filter is set still respect it.

Both methods are **optional**. Providers that can't implement per-session
routing/filtering simply leave them unimplemented; callers should `typeof ===
"function"` check before invoking. Backward compatible: existing plugins that
don't use these continue to work unchanged.

#### Use cases

- **Actor roles with cost-optimized models** — actor-runner plugin now reads
  `model:` from role frontmatter (full model id only, e.g. `claude-sonnet-4-6`)
  and applies it via `setStickyModelOverride`, isolating the actor from the
  global model. File-system actors can run on Sonnet/Haiku while reasoning
  actors stay on Opus.

- **Tool restrictions per role** — actor-runner reads `tools_allow:` and
  `tools_block:` from role frontmatter (YAML inline arrays) and installs a
  `setToolFilter` predicate. Restricts the visible tool surface so a
  read-only role can't see write/edit tools.

## [0.4.0] — 2026-04-28

### Added — `AIRequestMessage.data.utility` convention

New optional convention on the `data` field of `AIRequestMessage` for marking
calls as "utility" (summary, title generation, classification, etc).

When `data.utility === true`, the ModelRouter piece (new) routes the call to
the configured utility model (Haiku by default) **without touching the
session's sticky model**. This isolates utility calls from the main
conversation cache, preserving cache_read on subsequent turns.

Backward compatible: pieces that don't read `data.utility` keep working as
before. Old `AIRequestMessage` payloads without `data` continue to work.

### Added — `system.event` events: `router.decision` and `router.switch`

The ModelRouter publishes:
- `router.decision` on every routing decision (sticky, prefix, utility)
- `router.switch` only on actual model changes, with cost estimate

Plugins can subscribe to surface routing in their HUDs / metrics.

## [0.3.0] — 2026-04-28

### Added — Chat Anchor Registry

Generic, session-scoped anchor mechanism for the chat composer. Any piece (core or plugin) can pin a UI element above the composer until explicitly removed.

#### New bus channel: `chat.anchor`

Three actions:
- `set` — declare/replace an anchor by `(sessionId, id)`
- `remove` — drop a single anchor
- `clear` — drop all anchors of a session

Anchors are **strictly per-session**: a `chat.anchor` message carries a required `sessionId`. The frontend AnchorRegistry filters by the active ChatPanel's `sessionId` so anchors never leak across sessions.

#### New types

- `ChatAnchor` — `{ id, sessionId, source, priority?, rendererKind, payload, renderer?, ttlMs?, createdAt? }`
- `ChatAnchorMessage` — bus envelope for `set` / `remove` / `clear`

#### Frontend additions (consumed via `window.__JARVIS_CHAT_ANCHORS`)

- Singleton registry exposed for plugin renderers; backend pieces should publish via the bus instead.
- `useAnchors(sessionId)` hook for React components.
- `<ChatAnchorSlot sessionId={...} />` mounted between the chat scroll output and the composer.

Built-in `rendererKind`: `"choice"`. Plugins may set `renderer: { plugin, file }` to load a custom renderer (same loader path used for HUD pieces).

### Backward compatibility

Additive only. Existing channels, types, and HTTP endpoints unchanged. Plugins that never publish to `chat.anchor` are unaffected.

## [0.2.2] — 2026-04-23

### Breaking Changes — Unified Chat Refactor

Chat is now **session-agnostic**: a single unified chat system services any number of sessions (`main`, `actor-*`, or arbitrary labels). The root `jarvis-app` knows nothing about the concept of "actor" — it operates on opaque `sessionId` strings.

#### HTTP API — sessionId is now required

All `/chat/*` endpoints require a `sessionId`. Missing or empty → `HTTP 400`.

| Endpoint | Method | Required shape |
|----------|--------|----------------|
| `/chat/send` | POST | body: `{ sessionId, prompt, images? }` |
| `/chat-stream` | GET | query: `?sessionId=X` |
| `/chat/history` | GET | query: `?sessionId=X` |
| `/chat/abort` | POST | body: `{ sessionId }` |
| `/chat/clear-session` | POST | body: `{ sessionId }` |
| `/chat/compact` | POST | body: `{ sessionId }` |

Removed: `POST /chat` (legacy SSE streaming endpoint).

#### HudPieceData renderer — core renderer opt-in

`renderer.plugin` now accepts `null` to resolve a core renderer from `window.__JARVIS_COMPONENTS`:

```ts
{ plugin: null, file: "ChatPanel" }  // core ChatPanelHudAdapter
{ plugin: "jarvis-plugin-x", file: "MyRenderer" }  // plugin renderer (unchanged)
```

#### ChatPanel — props changed

Old: `streamUrl`, `sendUrl`, `abortUrl`, `historyUrl`, `assistantLabel`.

New: `sessionId` (required) + `assistantLabel` + optional features/labels. All URLs are derived internally from `sessionId`. A core `ChatPanelHudAdapter` is exposed on `window.__JARVIS_COMPONENTS.ChatPanelHudAdapter` so HUD pieces can mount it via `renderer: { plugin: null, file: "ChatPanel" }` with `data.sessionId`.

#### Server callbacks — sessionId-scoped

`HttpServer` callbacks now take `sessionId` as their first argument:

```ts
server.setOnAbort((sessionId: string) => ...)
server.setOnClearSession((sessionId: string) => ...)
server.setOnCompact((sessionId: string) => ...)
```

#### ChatPiece — multi-pool SSE

`ChatPiece.broadcastEvent(data)` became `broadcastEvent(sessionId, data)`. Internal state `streamClients` went from `Set<ServerResponse>` to `Map<sessionId, Set<ServerResponse>>`. Removed: `DEFAULT_SESSION` constant, `timelineSessions`, `addTimelineSession`, `removeTimelineSession`.

#### DiffViewer — sessionId propagation

`hud_show_diff`/`hud_show_file`/`hud_compare_files` now forward the calling session's `__sessionId` into `data.sessionId` on the HUD panel so Accept/Reject replies route back to the correct chat.

### Removed — jarvis-plugin-actors

- `actor-chat` piece — replaced by core chat endpoints
- `ActorChatRenderer` — replaced by core `ChatPanelHudAdapter`
- Routes `/plugins/actors/<name>/{send,stream,history,abort}` — replaced by `/chat/{send,stream,history,abort}` with `sessionId`

Retained (administrative lifecycle only):
- `POST /plugins/actors/create` — spawn actor
- `POST /plugins/actors/<name>/kill` — destroy actor

### Migration

- Any plugin calling `/chat/send` must include `sessionId` in the body.
- Any plugin embedding `ChatPanel` as a React component must pass `sessionId` instead of URL props.
- Any plugin mounting a chat in the HUD should publish `renderer: { plugin: null, file: "ChatPanel" }` with `data: { sessionId, assistantLabel? }`.

## [0.3.0] — 2025-07-20

### Added
- **GraphHandle & GraphNodeChild** — types exported from `@jarvis/core` for plugins to register children in the HUD graph
  - `GraphHandle` provides `setChildren()` and `update()` scoped to a piece's graph node
  - `GraphNodeChild` defines the shape of child nodes (id, label, status, meta, recursive children)
- **PluginContext.graphHandle** — optional factory `(pieceId: string) => GraphHandle`
  - Plugins can now enrich their piece's graph node with dynamic children (e.g. active skills, connected services)
  - Optional field (backward compatible with existing plugins)

## [0.2.1] — 2026-04-21

### Added
- **SessionManager interface** — `SessionManager`, `ManagedSession`, `SessionState` types exported from `@jarvis/core`
  - Central manager for ALL AI sessions (main, grpc-*, actor-*)
  - Provides `get()`, `getWithPrompt()`, `setState()`, `abort()`, `save()`, `close()`, `has()`
  - `getWithPrompt()` supports creating sessions with custom base prompt and role context (for actors)
- **PluginContext.sessionManager** — optional field added to `PluginContext`
  - Plugins can now access the central SessionManager for session persistence, restore, and state tracking
  - Optional field (backward compatible with existing plugins)

## [2.0.0] — 2025-07-19

### Added
- **HUD SSE Stream** — `GET /hud-stream` endpoint replaces polling `GET /hud` for real-time UI updates
  - Backend pushes deltas per-piece via SSE (`set` / `remove` actions)
  - Initial `snapshot` event provides full state on connect
  - Frontend maintains reactive `Map<pieceId, HudComponentState>` via `useSyncExternalStore`
- **Frontend hooks exposed to plugins** via `window.__JARVIS_HUD_HOOKS`:
  - `useHudState()` — full HudState (reactor + components array)
  - `useHudPiece(id)` — single piece state (granular subscription)
  - `useHudReactor()` — reactor state only
- **Plugin renderer banner** now includes `useHudState`, `useHudPiece`, `useHudReactor`, `useSyncExternalStore`
- **Settings cache** — `load()` uses in-memory cache with mtime validation (avoids excessive disk reads)
- **Per-session state tracking** in JarvisCore — `deriveGlobalState()` from individual session states
- **Token estimation fix** — uses real API `cache_read + cache_creation` values instead of char/4 heuristic
- **Smart conversation trimming** — ensures restored conversations start on a user message

### Changed
- `HudState` class now manages SSE client connections (`addStreamClient` / `removeStreamClient`)
- `HudState.getState()` kept for backward compat (initial snapshot, `GET /hud` still works)
- `settings.ts` `load()` returns cached object when file mtimes haven't changed
- `settings.ts` `save()` updates cache immediately after write
- `AnthropicSession` verbose message logging demoted to debug level
- `EventBus` error logging now uses structured objects instead of string concatenation

### Breaking
- `GET /hud` polling is **deprecated** in favor of `GET /hud-stream` SSE
  - `GET /hud` still works and returns the same payload (backward compatible)
  - New UI code should use `useHudState()` / `useHudPiece()` hooks instead
- Plugin renderers now have access to `useHudPiece(id)` for reactive per-piece updates
  - Old pattern (reading from `state` prop passed by HudRenderer) still works

## [1.0.0] — 2025-07-15

Initial release. EventBus, Piece, PluginContext, CapabilityRegistry, AISession interfaces.
