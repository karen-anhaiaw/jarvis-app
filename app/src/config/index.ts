// src/config/index.ts
import { load as loadSettings, save as saveSettings } from "../core/settings.js";

export interface JarvisConfig {
  model: string;
  grpcPort: number;
  grpcEnabled: boolean;
  logLevel: string;
  systemPromptPath: string;
}

const savedModel = loadSettings().model;

export const config: JarvisConfig = {
  model: process.env.JARVIS_MODEL ?? savedModel ?? "claude-sonnet-4-6",
  grpcPort: Number(process.env.JARVIS_GRPC_PORT ?? "50051"),
  grpcEnabled: process.env.JARVIS_GRPC_ENABLED !== "false",
  logLevel: process.env.LOG_LEVEL ?? "info",
  systemPromptPath: process.env.JARVIS_SYSTEM_PROMPT ?? "./jarvis-system.md",
};

const MODEL_PROVIDERS: Record<string, string> = {
  "claude-fable-5":   "anthropic",
  "claude-opus-5":    "anthropic",
  "claude-opus-4-8":  "anthropic",
  "claude-opus-4-7":  "anthropic",
  "claude-opus-4-6":  "anthropic",
  "claude-sonnet-4-6": "anthropic",
  "claude-haiku-4-5": "anthropic",
  "gpt-4o": "openai",
  "gpt-4o-mini": "openai",
  "gpt-4.1": "openai",
  "o3": "openai",
  "o4-mini": "openai",
};

export function getProviderForModel(model: string): string {
  // Exact match first
  if (MODEL_PROVIDERS[model]) return MODEL_PROVIDERS[model];
  // Prefix match: claude-* → anthropic, gpt-*/o* → openai
  if (model.startsWith("claude-")) return "anthropic";
  if (model.startsWith("gpt-") || model.startsWith("o3") || model.startsWith("o4")) return "openai";
  // Default to openai-compatible (works with Ollama, Groq, etc.)
  return "openai";
}

export function setModel(model: string): { message: string; providerChanged: boolean; provider: string } {
  const oldProvider = getProviderForModel(config.model);
  const newProvider = getProviderForModel(model);
  config.model = model;
  const settings = loadSettings();
  settings.model = model;
  saveSettings(settings);
  return {
    message: `Model switched to ${model} (${newProvider}).${oldProvider !== newProvider ? " Provider changed — session will reset." : ""}`,
    providerChanged: oldProvider !== newProvider,
    provider: newProvider,
  };
}

export function getValidModels(): string[] {
  return Object.keys(MODEL_PROVIDERS);
}

/** Human-readable metadata for each known model. Drives the UI model picker. */
export interface ModelMeta {
  id: string;
  label: string;
  note: string;
  provider: string;
}

/**
 * Returns the full model catalog with display metadata.
 * Single source of truth consumed by GET /chat/models — UI reads this,
 * no per-UI hardcoding needed.
 */
export function getModelCatalog(): ModelMeta[] {
  return [
    { id: 'claude-fable-5',   label: 'Fable 5',      note: '1M · Frontier', provider: 'anthropic' },
    { id: 'claude-opus-5',    label: 'Opus 5',        note: '1M · Flagship', provider: 'anthropic' },
    { id: 'claude-opus-4-8',  label: 'Opus 4.8',     note: '1M · Max',      provider: 'anthropic' },
    { id: 'claude-opus-4-7',  label: 'Opus 4.7',     note: '1M · Max',      provider: 'anthropic' },
    { id: 'claude-opus-4-6',  label: 'Opus 4.6',     note: '1M · Max',      provider: 'anthropic' },
    { id: 'claude-sonnet-4-6',label: 'Sonnet 4.6',   note: '1M · High',     provider: 'anthropic' },
    { id: 'claude-haiku-4-5', label: 'Haiku 4.5',    note: '200K · Fast',   provider: 'anthropic' },
    { id: 'gpt-4o',           label: 'GPT-4o',       note: 'OpenAI',        provider: 'openai'    },
    { id: 'gpt-4o-mini',      label: 'GPT-4o Mini',  note: 'OpenAI · Fast', provider: 'openai'    },
    { id: 'gpt-4.1',          label: 'GPT-4.1',      note: 'OpenAI',        provider: 'openai'    },
    { id: 'o3',               label: 'o3',            note: 'OpenAI · Reason', provider: 'openai' },
    { id: 'o4-mini',          label: 'o4-mini',       note: 'OpenAI · Fast', provider: 'openai'   },
  ];
}

export function getCurrentProvider(): string {
  return getProviderForModel(config.model);
}

/**
 * Models that support 1M context via the `context-1m-2025-08-07` beta header.
 * Without the header, all Claude 4.x models cap at 200k.
 *
 * Source: https://docs.anthropic.com/en/docs/build-with-claude/context-windows
 * Confirmed members (2026-07): fable-5, mythos-5, opus-5, opus-4-8, opus-4-7, opus-4-6, sonnet-4-6.
 * Sonnet 4.5, Sonnet 4, Haiku 4.5, all 3.x models → 200k only.
 */
export function supportsLongContext(model?: string): boolean {
  const m = model ?? config.model;
  // Match exact model IDs (and dated variants like "claude-opus-4-7-20260101").
  return /(?:^|-)(fable-5|mythos-5|opus-5|opus-4-8|opus-4-7|opus-4-6|sonnet-4-6)(?:-|$)/.test(m);
}

export function getMaxContext(model?: string): number {
  return supportsLongContext(model) ? 1_000_000 : 200_000;
}

/**
 * Max output tokens per single completion/stream.
 *
 * Anthropic models as of 2026-04:
 * - Opus 4.7:    128k output tokens
 * - Sonnet 4.6:   64k output tokens
 * - Haiku 4.5:    64k output tokens
 *
 * This directly limits:
 * - How large a single tool_use `input` JSON can be (big write_file/bash payloads)
 * - How long a single assistant text block can be
 *
 * Set too low → model truncates tool_use JSON mid-stream → capability receives
 * empty/partial args → `command is required` / `content is required` errors.
 */
export function getMaxOutput(model?: string): number {
  const m = model ?? config.model;
  if (m.includes("fable") || m.includes("mythos")) return 128_000;
  if (m.includes("opus")) return 128_000;
  if (m.includes("haiku")) return 64_000;
  if (m.includes("sonnet")) return 64_000;
  return 16_000; // safe default for unknown models (OpenAI etc)
}
