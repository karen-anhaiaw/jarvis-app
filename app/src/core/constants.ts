// src/core/constants.ts
// Cross-module constants. Introduced in mission jarvis-fix (F1.3/F3.11) to
// replace scattered "main" string literals — single place to change the
// canonical default session id.

/**
 * The canonical default session — the human user's primary chat session.
 *
 * Rules of use:
 * - System notifications (piece failures, cron warnings, plugin events) go here.
 * - It is ALWAYS a legitimate ai.request target: creating it on demand is by
 *   design (it owns the default system prompt), so it is exempt from
 *   phantom-session target validation.
 */
export const DEFAULT_SESSION = "main";
