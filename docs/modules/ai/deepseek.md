# DeepSeek Provider Module

## Location
`app/src/ai/deepseek/`

## Responsibility

Provides AI session management for DeepSeek API (api.deepseek.com) with:
- **Prefix cache** — automatic, implicit (DeepSeek API handles it)
- **System prompt composition** — base + core context + instructions + plugin context
- **Usage telemetry** — input/output tokens + cache hits

## Architecture

### Current Implementation (v1)

DeepSeek reuses **OpenAI SDK + OpenAISessionFactory** because:
1. DeepSeek exposes OpenAI-compatible `/chat/completions` endpoint
2. OpenAI SDK's `baseURL` parameter allows pointing to `api.deepseek.com`
3. Credentials come from `settings.providers.deepseek.{apiKey, baseUrl}`
4. Prefix cache is implicit — no explicit cache breakpoints needed

**Files:**
- `provider.ts` — factory registration, credential loading
- `provider.test.ts` — factory creation and session lifecycle tests

### Future Work (v2)

- **Compaction** (Engine B) — manual summarization for long conversations (like Anthropic)
- **System prompt as string only** — no `TextBlockParam[]` cache blocks (OpenAI-compatible API ignores `cache_control`)
- **Token estimation** — prefix cache efficiency tracking

## Public API

### `createDeepSeekProvider(config: ProviderConfig): Provider`

Creates a provider instance with factory and metrics HUD.

**Parameters:**
- `config.getTools()` → capabilities array
- `config.getBasePrompt()` → system prompt (jarvis-system.md + core context + instructions)
- `config.getCoreContext(sessionId?)` → core pieces context
- `config.getPluginInstructions()` → plugin registry instructions
- `config.getPluginContext(sessionId?)` → per-session plugin state (skills, active actors)
- `config.getInstructions()` → CLAUDE.md or equivalent

**Returns:**
- `Provider { name, factory: OpenAISessionFactory, metricsPiece: OpenAIMetricsHud }`

**Throws:**
- `Error` if `providers.deepseek.apiKey` is not set (no OPENAI_API_KEY fallback)

## Credentials

Priority order (highest to lowest):
1. `~/.jarvis/settings.user.json` → `providers.deepseek.apiKey`
2. `process.env.DEEPSEEK_API_KEY` environment variable
3. **Missing** → throws error (no cross-provider fallback)

Optional:
- `providers.deepseek.baseUrl` (default: `https://api.deepseek.com`)

## Usage

**Boot (in `main.ts`):**
```typescript
import { createDeepSeekProvider } from "./ai/deepseek/provider.js";

// Register provider
providerRouter.registerProviderFactory("deepseek", createDeepSeekProvider);

// Switch to DeepSeek
const result = await providerRouter.switchTo("deepseek", bus);
console.log(result); // "Provider switched to deepseek"
```

**Chat:**
```typescript
// Session automatically uses DeepSeek API endpoint
const session = factory.create({ label: "main" });

for await (const event of session.sendAndStream("Hello DeepSeek!")) {
  if (event.type === "delta") console.log(event.text);
  if (event.type === "message_complete") console.log("Usage:", event.usage);
}
```

## Model IDs

**Current (2026-07):**
- `deepseek-v4-pro` — top-tier, 1M context, 384K max output
- `deepseek-v4-flash` — fast, 1M context, 384K max output

**Retired (2026-07-24):**
- ❌ `deepseek-chat` — returns 404
- ❌ `deepseek-reasoner` — returns 404

## Usage Mapping

DeepSeek's OpenAI-format response is mapped to Anthropic-shape (what HUD expects):

```typescript
// DeepSeek response
{
  usage: {
    prompt_tokens: 1000,
    completion_tokens: 100,
    prompt_tokens_details: {
      cached_tokens: 200  // Prefix cache hit
    }
  }
}

// Mapped to Anthropic shape
{
  input_tokens: 800,           // prompt_tokens - cached_tokens
  output_tokens: 100,          // completion_tokens
  cache_creation_input_tokens: 0,   // DeepSeek has no explicit cache-write step
  cache_read_input_tokens: 200      // cached_tokens (prefix cache hits)
}
```

**Rationale:**
- OpenAI counts cached tokens **inside** prompt_tokens
- Anthropic counts them **separately** (cache_read_input_tokens)
- To avoid double-billing on screen, we subtract: `input_tokens = prompt_tokens - cached_tokens`

## Compaction (TODO — v2)

Engine B (manual summarization) will be added in v2:

1. **Sliding window** — compact oldest N turns every M turns (proactive)
2. **Threshold** — compact if context > 80% of window (reactive)
3. **Growth** — compact if context grew > 15% in one turn (reactive)

Uses the session's current model (not Haiku) to avoid truncation on large contexts.

## Testing

**Type check:**
```bash
cd app && npx tsc --noEmit
```

**Unit tests:**
```bash
# Provider creation, session lifecycle
npm test -- src/ai/deepseek/provider.test.ts
```

**Integration (manual):**
```bash
# Start JARVIS HUD, switch to deepseek model picker
/model_set deepseek-v4-pro
# Should switch provider and create session
```

## Invariants

1. **Credentials fail loudly** — if `providers.deepseek.apiKey` is missing, throw before any session creation
2. **No cross-provider credential leak** — never fall back to `OPENAI_API_KEY` (would send OpenAI key to DeepSeek)
3. **System prompt always present** — `config.getBasePrompt()` is injected into every session
4. **Usage always logged** — every API response records tokens to `usage.log` for cost analysis
5. **Prefix cache is transparent** — no special handling needed; OpenAI SDK + DeepSeek API handle it

## Related

- **Provider Router** — `app/src/ai/provider.ts` (factory registration, switchTo logic)
- **OpenAI Factory** — `app/src/ai/openai/factory.ts` (session creation, base implementation)
- **System Prompt** — `app/src/ai/system-prompt.ts` (composition: base + context)
- **Usage Logging** — `app/src/ai/anthropic/usage-log.ts` (shared telemetry)
- **Feature Doc** — `docs/features/deepseek-cache-compaction.md` (architecture rationale)

## Changelog

**2026-08-01:**
- Initial implementation: reuse OpenAI SDK + factory with DeepSeek endpoint
- System prompt composition (base + core + instructions + plugins)
- Credentials from settings.providers.deepseek.{apiKey, baseUrl}
- Usage mapping (OpenAI → Anthropic shape for HUD)
- **TODO:** Compaction Engine B in v2
