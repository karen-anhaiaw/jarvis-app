# @jarvis/core — Compatibility Guide

## Versioning Policy

This package follows **Semantic Versioning (semver)**:

- **MAJOR** — breaking changes to public API (types, interfaces, bus channels, plugin contract)
- **MINOR** — new features, new optional fields, new hooks (backward compatible)
- **PATCH** — bug fixes, performance improvements, internal refactors

## Plugin Compatibility Matrix

| @jarvis/core | Plugin API | HUD Stream | Notes |
|---|---|---|---|
| 1.x | `state` prop only | ❌ polling `/hud` every 2s | Original architecture |
| 2.x | `state` prop + `useHudPiece()` | ✅ SSE `/hud-stream` | Backward compatible — `state` prop still works |
| 0.2.1 | + `sessionManager?` in PluginContext | ✅ SSE `/hud-stream` | Optional field — plugins without it still work |
| **0.2.2** | **Unified chat — sessionId required everywhere** | ✅ SSE per sessionId | **BREAKING** — see CHANGELOG. Chat endpoints, `ChatPanel` props, and `HttpServer` callbacks all changed. `renderer.plugin` accepts `null` for core renderers. |
| **0.3.0** | + `chat.anchor` channel + `ChatAnchor` types + `window.__JARVIS_CHAT_ANCHORS` | ✅ Unchanged | Additive. Pieces can pin per-session UI anchors above the chat composer. |
| **0.5.0** | + `AISession.setStickyModelOverride?` + `AISession.setToolFilter?` | ✅ Unchanged | Additive. Both optional — plugins that don't call them keep working. Actor-runner uses them to apply per-role model + tool restrictions. |
| **0.6.0** | + `BusMessage.traceId?` | ✅ Unchanged | Additive optional field. Plugins that don't set it keep working — bus auto-fills a fresh id per publish. Plugins that DO set it on the originating publish (and propagate it on follow-ups) get end-to-end log correlation across chat→bus→core→provider→stream. |
| **0.7.0** | + `CapabilityDefinition.category?` | ✅ Unchanged | Additive optional field. Declarative slash-menu grouping per tool (F3.15). Tools without it fall back to "mcp" (`mcp__` prefix) or "general". Old plugins keep working unchanged. |
| **0.8.0** | + `TurnSummary` / `TurnToolStat` types + `system.event: turn.summary` | ✅ Unchanged | Additive. jarvis-core emits one summary per turn traceId; plugins MAY subscribe. No existing shape changed (F5). |

## Public API Surface

### Stable (do NOT break without major version bump)

These are consumed by plugins and must remain backward compatible:

#### TypeScript Interfaces (`@jarvis/core`)
- `Piece` — `id`, `name`, `start(bus)`, `stop()`, `systemContext?()`
- `PluginContext` — `bus`, `capabilityRegistry`, `config`, `pluginDir`, `sessionFactory`, `sessionManager?`, `registerRoute`, `saveConfig`, `registerSlashCommand`, `unregisterSlashCommand`
- `PluginManifest` — `name`, `version`, `description`, `author?`, `entry?`, `capabilities?`
- `HudPieceData` — `pieceId`, `type`, `name`, `status`, `data`, `position?`, `size?`, `visible?`, `ephemeral?`, `renderer?` (renderer.plugin: `string` for plugin renderer, `null` for core renderer resolved from `window.__JARVIS_COMPONENTS`)
- `EventBus` — `publish(msg)`, `subscribe(channel, handler)`, `stats`
- `CapabilityRegistry` — `register(def)`, `getDefinitions()`, `execute(calls)`, `registerSlashCommand`, `unregisterSlashCommand`, `getSlashCommands()`, `names`, `size`
- Bus channels: `ai.request`, `ai.stream`, `capability.request`, `capability.result`, `hud.update`, `system.event`
- All message types: `AIRequestMessage`, `AIStreamMessage`, `CapabilityRequestMessage`, `CapabilityResultMessage`, `HudUpdateMessage`, `SystemEventMessage`
- `system.event` payloads: `turn.summary` → `data: TurnSummary` (with `TurnToolStat`) — one per turn traceId (added in 0.8.0)

#### Window Globals (consumed by plugin renderers)
- `window.__JARVIS_REACT` — React instance (`createElement`, `Fragment`, all hooks)
- `window.__JARVIS_HUD_HOOKS` — `{ useHudState, useHudPiece, useHudReactor }` (added in 2.0)

#### HTTP Endpoints (consumed by plugins via `registerRoute` and `fetch`)
- `GET /hud` — full HUD state snapshot (JSON). Components additionally carry `rev` (per-panel monotonic revision) and `updatedAt` (epoch ms of last content change) since app F6 — additive, safe to ignore.
- `GET /hud-stream` — SSE delta stream (added in 2.0). Deltas additionally carry `rev` since app F6 — additive; clients without rev logic keep working.
- `POST /chat/send` — body `{ sessionId, prompt, images? }` — **sessionId required (0.2.2)**
- `GET /chat-stream?sessionId=X` — SSE chat event stream scoped to `sessionId` — **required (0.2.2)**
- `GET /chat/history?sessionId=X` — message history for UI hydration — **sessionId required (0.2.2)**
- `POST /chat/abort` — body `{ sessionId }` — **required (0.2.2)**
- `POST /chat/clear-session` — body `{ sessionId }` — **required (0.2.2)**
- `POST /chat/compact` — body `{ sessionId }` — **required (0.2.2)**
- `GET /plugins/{name}/renderers/{file}.js` — compiled plugin renderer

#### Plugin Renderer esbuild Banner
Injected variables available in all `.tsx` plugin renderers:
```js
// React (from window.__JARVIS_REACT)
createElement, Fragment, useEffect, useRef, useState,
useCallback, useMemo, useSyncExternalStore

// HUD hooks (from window.__JARVIS_HUD_HOOKS) — added in 2.0
useHudState, useHudPiece, useHudReactor
```

### Internal (may change without notice)

These are implementation details NOT consumed by plugins:
- `HudState` class internals (stream client management, delta format)
- `JarvisCore` state machine internals (`sessionStates`, `deriveGlobalState`)
- `SessionManager` internals
- `AnthropicSession` / `AnthropicSessionFactory` internals
- Settings file format (`.jarvis/settings.user.json`)
- Conversation store format (`.jarvis/sessions/*.json`)
- Log format and log buffer API

## Migration Guide: 0.2.1 → 0.2.2

### For plugins that embed `ChatPanel` or call `/chat/*`

**Required:** always pass `sessionId`. No fallback, no default.

```ts
// Before (0.2.1)
fetch('/chat/send', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt: 'hello' }),
})

// After (0.2.2)
fetch('/chat/send', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ sessionId: mySessionId, prompt: 'hello' }),
})
```

### For plugins that mount a chat panel in the HUD

Use the core renderer via `renderer.plugin = null`:

```ts
bus.publish({
  channel: "hud.update",
  source: myPieceId,
  action: "add",
  pieceId: `chat-${name}`,
  piece: {
    pieceId: `chat-${name}`,
    type: "panel",
    name: `Chat: ${name}`,
    status: "running",
    data: {
      sessionId: `my-session-${name}`,  // opaque — core knows nothing about "actor" etc.
      assistantLabel: name.toUpperCase(),
    },
    position: { x: 100, y: 100 },
    size: { width: 480, height: 400 },
    ephemeral: true,
    renderer: { plugin: null, file: "ChatPanel" },
  },
});
```

### For plugins that import `ChatPanel` as a React component

Change from URL props to `sessionId`:

```tsx
// Before (0.2.1)
<ChatPanel
  streamUrl={`/plugins/x/${name}/stream`}
  sendUrl={`/plugins/x/${name}/send`}
  abortUrl={`/plugins/x/${name}/abort`}
  historyUrl={`/plugins/x/${name}/history`}
  assistantLabel={name}
/>

// After (0.2.2)
<ChatPanel sessionId={`my-session-${name}`} assistantLabel={name} />
```

## Migration Guide: 1.x → 2.x

### For plugin renderers (frontend)

**No changes required.** The `state` prop passed by HudRenderer still works exactly as before.

**Optional optimization:** Use `useHudPiece(pieceId)` for granular reactivity:
```tsx
// Before (1.x) — re-renders on ANY HUD change
export default function MyRenderer({ state }: { state: any }) {
  const data = state.data
  return <div>{data.myValue}</div>
}

// After (2.x) — re-renders only when THIS piece changes
export default function MyRenderer({ state }: { state: any }) {
  const piece = useHudPiece(state.id)
  const data = piece?.data ?? state.data
  return <div>{data.myValue}</div>
}
```

### For plugin pieces (backend)

**No changes required.** Publishing `hud.update` on the bus works exactly as before. The HudState SSE layer handles delta broadcasting automatically.
