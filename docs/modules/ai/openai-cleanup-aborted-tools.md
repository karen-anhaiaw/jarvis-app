# openai/cleanup-aborted-tools

> `app/src/ai/openai/cleanup-aborted-tools.ts` · pure function · since mission jarvis-fix F2.4

## Responsibility

Restore the OpenAI history invariant after a user abort in `waiting_tools`: **every assistant `tool_calls` id must have a matching `role:"tool"` message**. Port of the tested Anthropic module (`anthropic/cleanup-aborted-tools.ts`) to the OpenAI message format.

## Why (decision record)

The previous in-session loop popped trailing `role:"tool"` messages unconditionally — destroying valid completed sequences and orphaning their assistant tool_calls (OpenAI rejects such histories with 400). The Anthropic module proved the correct approach is **additive, never destructive**: scan for gaps, append synthetic pieces (`[Tool execution was aborted by user]`) until the invariant holds.

## Format mapping (Anthropic → OpenAI)

| Anthropic | OpenAI |
|---|---|
| `tool_use` content block | assistant message `tool_calls[]` |
| `tool_result` content block | `role:"tool"` message with `tool_call_id` |

## Algorithm

1. Scan existing tool_call ids and tool result ids.
2. Pending calls missing their tool_call → append ONE assistant message with those `tool_calls`.
3. Pending calls missing their result → append synthetic `role:"tool"` messages.
4. Final sweep: ANY orphaned tool_call id (even non-pending) gets an emergency synthetic result.
5. Never removes or mutates existing messages.

## Tests

`app/src/ai/openai/session.test.ts` (F2.4 block) — mirrors `docs/features/bdd/openai-parity.feature`: full synthetic pair, completed sequences untouched, partial gap fill, orphan emergency results, empty no-op.
