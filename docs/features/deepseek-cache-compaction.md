# DeepSeek Provider: Cache + Compaction

## Intent

Enable DeepSeek (api.deepseek.com) as a first-class JARVIS AI provider with:
- **Cache:** automatic prefix cache (DeepSeek API native, like OpenAI)
- **Compaction:** manual summarization (Engine B, like Anthropic) for long histories

## Architecture

### Dual-Engine Strategy

**Cache (API-native, per-turn):**
- DeepSeek API automatically caches prompt prefixes for prefix-repeated requests
- No explicit `cache_control` headers needed (unlike Anthropic's `cache_control: ephemeral`)
- Transparent — the API handles it; session code doesn't manage breakpoints

**Compaction (Manual, per-session):**
- Triggered on: sliding-window schedule, absolute threshold (80%), abrupt growth (+15%)
- Uses same model as session for summarization (avoids Haiku truncation on large contexts)
- Engine B only (async, visible to user)

### Factory Pattern

`DeepSeekSessionFactory` extends structure from AnthropicSessionFactory:
- Same `buildSystemBlocks()` architecture (system prompt composition with cache breakpoints)
- System blocks are TEXT ONLY — no `cache_control` needed (OpenAI-compatible API ignores them)
- Factory wires up compaction triggers (from AnthropicSession)

### Session Hierarchy

```
AISession (interface)
  ├── OpenAISession (no compaction)
  ├── AnthropicSession (cache breakpoints + compaction)
  └── DeepSeekSession (inherits compaction from Anthropic, cache is native)
```

DeepSeekSession is likely an alias to AnthropicSession for compaction logic, but:
- Uses OpenAI SDK client (api.deepseek.com endpoint)
- No `TextBlockParam[]` system prompt (just string) because cache_control won't be used
- Same compaction triggers, summarization, and failure guards

### Credentials

- `settings.providers.deepseek.apiKey` (or `DEEPSEEK_API_KEY`)
- `settings.providers.deepseek.baseUrl` (default: `https://api.deepseek.com`, optional)
- Must fail loudly if apiKey is missing (no fallback to OPENAI_API_KEY)

## Implementation Plan

### Files to Create/Modify

1. **app/src/ai/deepseek/session.ts** (new)
   - DeepSeekSession class
   - Reuse compaction logic from AnthropicSession
   - OpenAI SDK API calls (not Anthropic SDK)
   - Usage mapping (cached tokens like OpenAI)

2. **app/src/ai/deepseek/factory.ts** (new)
   - DeepSeekSessionFactory
   - `buildSystemBlocks()` for prompt composition
   - `create()` and `createWithPrompt()`
   - Tool definitions, token breakdown

3. **app/src/ai/deepseek/metrics-hud.ts** (new)
   - DeepSeekMetricsHud (Piece)
   - Track usage + compaction events
   - HUD rendering (token counter, cache %)

4. **app/src/ai/deepseek/provider.ts** (modify)
   - Register `createDeepSeekProvider` with ProviderRouter
   - Pass ProviderConfig (getTools, getBasePrompt, getCoreContext, etc.)
   - Return Provider with factory + metricsPiece

5. **app/src/ai/provider.ts** (modify)
   - Register DeepSeek factory in ProviderRouter constructor
   - Wire up switchTo("deepseek") call

6. **Tests** (new)
   - session.test.ts: cache mapping, compaction triggers
   - factory.test.ts: system block composition
   - provider.test.ts: credentials, factory creation

7. **Docs** (new)
   - Feature: compaction.md already exists, no change needed
   - Module: docs/modules/ai/deepseek.md

## Key Decisions

### Why not explicit cache_control in system blocks?

DeepSeek API (OpenAI-compatible) doesn't interpret `cache_control` headers on requests.
Prefix caching is **implicit** — repeated prompt prefixes are automatically cached by the server.
No client-side management needed.

### Why Anthropic's compaction, not OpenAI's automatic cache?

OpenAI's prefix cache is "unlimited" in theory but has practical limits:
- Only caches identical prefixes (no delta between calls)
- Doesn't compress history (cache stays at full size)

DeepSeek uses the same approach. For **long conversations**, manual compaction is essential:
- Summarizes old history into a short block
- Reduces context window pressure after ~30 turns
- Enables multi-hour sessions without hitting limits

### Same model for summarization?

Following Anthropic best-practice (F-compact-1.2):
- Use `stickyModelOverride ?? baseModel()` for compaction
- Avoids Haiku's ~200k context limit on large summaries
- Small cost for huge safety gain

## Failure Guards

1. **Empty/short summary floor:** proportional to `tokensBefore` (50/300/800 chars)
2. **Pre-compact backup:** full history archived before replacement
3. **Sanitization:** messages checked for orphan tool_use / duplicate tool_result
4. **Diagnostics:** every compaction call logged (stop_reason, block types, usage)
5. **Thinking exhaustion retry:** 4x budget retry if stop_reason=max_tokens with zero text

## Metrics & Observability

**Usage telemetry:**
- `input_tokens`, `output_tokens` from API response
- `cached_tokens` from `prompt_tokens_details.cached_tokens` (OpenAI format)
- `cache_creation_input_tokens: 0` (OpenAI has no explicit cache-write step)

**Compaction events:**
- `compaction_start`, `compaction`, `compaction_failed` (streamed to HUD)
- `summary` text, `engine` ("fallback"), `tokensBefore`, `tokensAfter`
- Logged to `usage.log` for cost analysis

## Compatibility

- Min context: 1M tokens (per DeepSeek v4 models)
- Model IDs (current): `deepseek-v4-pro`, `deepseek-v4-flash`
- Settings: inherit from `settings.providers.deepseek` (apiKey, baseUrl)
- Session restore: compaction triggers survive restore (turn count is derived)

## Future Work

- Cache statistics dashboard (cache hit rate, tokens cached)
- Sliding-window incremental compaction (merge new turns, preserve recent)
- Per-model compaction strategy (cheaper model for Haiku-tier sessions)
