# Module: ModelRouterPiece

**File:** `app/src/pieces/model-router.ts`
**Piece ID:** `model-router`

## Responsibility

Decides which model (and, since mission Gearbox, which reasoning effort) an
`ai.request` should use, per session. Sticky-by-default: switching a model
invalidates 100% of that session's prompt cache, so the router never switches
unless the user explicitly asks (prefix, slash command, HUD picker) or a
utility flag forces it.

## Key Types

| Type | Description |
|---|---|
| `SessionRoute` | Per-session routing state: `sticky` (model id), `switchCount`, `lastSwitchAt`, `lastReason`, `userForced`, `params?` (provider-interpreted sticky map, e.g. `{ effort }`, mission Gearbox). Persisted via `conversation-store.ts` (`<label>.route.json`). |
| `RoutingConfig` | Tiers (`default`/`heavy`/`light`/`utility`) + aliases (`opus`/`sonnet`/`haiku`/…), loaded from settings with hardcoded defaults. |

## Key Functions

| Function | Description |
|---|---|
| `parseModelCommand(arg)` | (mission Gearbox, exported, pure) Parses a `/model` argument into `{ model, params }`. Grammar: `<id-or-alias>` optionally followed by whitespace + a JSON object. **Blind to the params keys** — just splits and `JSON.parse`s the suffix, forwarding whatever map it finds. Malformed JSON → `params: undefined`, model kept. This is what keeps the params map open: a new provider key (e.g. OpenAI `reasoning_effort`) needs zero parser changes. |

## Key Methods

| Method | Description |
|---|---|
| `onRequest(msg)` | Bus handler for `ai.request`. Decides the model via `decide()`, applies the sticky override on the live session (`setStickyModelOverride` + `setStickyParams` if a route has `params`), emits `router.decision` telemetry. |
| `decide(sessionId, msg, cfg)` | Pure decision: utility flag → prefix (`[opus]`) → sticky (default path, ~95% of calls). Prefix switches update `route.sticky`, mark `userForced`, and emit switch/banner events. |
| `setStickyModel(sessionId, model, reason?, params?)` | Public API used by the `/model` slash command and the HUD picker. **Mission Gearbox:** applies model AND params **atomically on the live session** — calls `session.setStickyModelOverride(model)` and, if `params` is provided, `session.setStickyParams(params)` — both immediately, not deferred to the next `onRequest`. This closes a pre-Gearbox gap where `/model` felt instant via the UI event but the actual session state lagged one turn. `onRequest` still re-applies both on every turn (idempotent — harmless double-application, and the source of truth for sessions not yet materialized, e.g. actors). A no-op guard skips work only when BOTH the model AND params are unchanged (`paramsChanged` computed via `JSON.stringify` comparison). |
| `getRoute(sessionId)` / `getAllRoutes()` | Read-only inspection for the HUD/slash-command status line. |

## Bus Events

| Channel/Event | Payload | Purpose |
|---|---|---|
| `system.event` / `router.decision` | `{ sessionId, model, reason, stickyChanged, ctxTokens }` | Emitted on every routed `ai.request` — telemetry. |
| `system.event` / `router.switch` | `{ sessionId, fromModel, toModel, ctxTokens, costUsd, reason, effort? }` | Emitted only on an actual model/params change. `effort` (mission Gearbox) is `params?.effort`, surfaced explicitly so `chat-piece.ts` can forward it on the `model_changed` SSE event without inspecting the whole map. |
| `chat.anchor` (via `ChatPiece.broadcastEvent`) | Banner text: `"⚠️ Model switch — Sonnet → Opus 4.8 · High (reason)"` | Non-blocking timeline banner. Effort label (mission Gearbox) is appended to the target model name when `params.effort` is present. |

## Effort (mission Gearbox, 2026-08-07)

The router treats `params` as an **opaque map** — it never inspects keys beyond
reading `params.effort` for banner display. The actual interpretation (what
`effort: "high"` DOES) lives entirely in the provider session
(`AnthropicSession.resolveEffort` — see `docs/modules/ai/session.md`).

Flow: HUD picker row `{ id, effort }` → `POST /chat/send` with
`/model <id> {"effort":"<level>"}` → `parseModelCommand` splits it →
`setStickyModel(sessionId, id, reason, { effort })` → applied atomically on
the live session + persisted to `<label>.route.json`.

## Invariants

- The router NEVER switches models automatically based on context size (auto-degrade was removed 2026-06-19 per Sir's decision — see Mnemosyne). Only user-explicit switches (prefix/slash/HUD) or the `utility` flag change the sticky model.
- `params` is a **full replacement**, not a merge, when provided to `setStickyModel` — callers pass the complete map they want in effect, mirroring how `model` replaces `sticky`.
- Session lifecycle eviction (F3.14): routes and pending overrides for closed sessions are dropped on `session.closed` — never persisted to disk on `stop()`.
- `ensureRoute` seeds a brand-new route from `session.stickyModelOverride` (if the session already exists with one set — e.g. slack-hook pinning Haiku before the first `ai.request`) rather than stomping it with `cfg.default`.

## Testing Safety Note (mission Gearbox postmortem, 2026-08-07)

`model-router.ts` **statically imports** `conversation-store.ts`, whose
`SESSIONS_DIR` is a **module-level `const`** resolved from `JARVIS_HOME` **at
import time** — before any `beforeEach` can override the env var. Any test
file that statically imports `model-router.ts` (or anything that transitively
imports `conversation-store.ts`) WILL read/write the REAL
`~/.jarvis/sessions/` directory unless `conversation-store.js` is mocked
(`vi.mock("../core/conversation-store.js", ...)`) BEFORE the import. This was
discovered the hard way — an early version of `model-router-params.test.ts`
corrupted the real `main.route.json`; recovered from the live process's
in-memory `ModelRouterPiece` state via `jarvis_eval`. **Any new test touching
`model-router.ts` or `main.ts` must mock `conversation-store.js` unconditionally,
not rely on `JARVIS_HOME` + import ordering.**
