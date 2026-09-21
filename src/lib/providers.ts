/**
 * The model providers DataLens can talk to, and how to tell which one an
 * API key belongs to. Client-safe (no secrets, no SDK) so the settings UI
 * can label a pasted key the moment it is typed.
 *
 * Both providers expose an OpenAI-compatible chat endpoint, so the same
 * SDK call works for either; only the base URL, the model ids and the
 * tuning of reasoning/token limits differ.
 */
export type ProviderId = "openrouter" | "gemini";

export interface ProviderConfig {
  id: ProviderId;
  label: string;
  baseURL: string;
  /** Models tried in order; the first that answers is used. */
  models: string[];
  /** What a key from this provider looks like, for the settings placeholder. */
  keyHint: string;
  keysUrl: string;
  /** Output budget for a planning call — reasoning models spend part of it thinking. */
  maxTokens: number;
  /** Extra body fields the provider understands (reasoning controls). */
  extraBody: Record<string, unknown>;
}

export const PROVIDERS: Record<ProviderId, ProviderConfig> = {
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    baseURL: "https://openrouter.ai/api/v1",
    // Free-tier only (no paid model is ever called). OpenRouter's per-day
    // free quota is per ACCOUNT, shared by every ":free" model, so a longer
    // chain helps with a congested or delisted model, not a spent cap.
    models: [
      "qwen/qwen3.8-27b:free",
      "google/gemma-4-31b-it:free",
      "z-ai/glm-5.2:free",
      "nvidia/nemotron-3-super-120b-a12b:free",
      "google/gemma-4-26b-a4b-it:free",
      "nvidia/nemotron-3-ultra-550b-a55b:free",
      "nex-agi/nex-n2.5-pro:free",
      "thinkingmachines/inkling:free",
    ],
    keyHint: "sk-or-v1-…",
    keysUrl: "https://openrouter.ai/keys",
    maxTokens: 2000,
    // Some free models default to an internal "thinking" pass that eats
    // the whole token budget as reasoning and returns empty content;
    // turning reasoning off (where supported) makes them answer directly.
    extraBody: { reasoning: { enabled: false } },
  },
  gemini: {
    id: "gemini",
    label: "Google Gemini",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    // Newest flash model first; older ones as fallback when the newest is
    // under high demand (503) or retired for new keys (404).
    models: [
      "gemini-3.8-flash",
      "gemini-3.7-flash",
      "gemini-3.6-flash",
      "gemini-3.5-flash",
      "gemini-3.5-flash-lite",
      "gemini-3.1-flash-lite",
    ],
    keyHint: "AIza… or AQ.…",
    keysUrl: "https://aistudio.google.com/apikey",
    // Gemini counts its thinking tokens inside max_tokens; a low reasoning
    // effort plus headroom keeps the JSON from being cut off.
    maxTokens: 8000,
    extraBody: { reasoning_effort: "low" },
  },
};

/** Provider order when several kinds of key are configured. */
export const PROVIDER_ORDER: ProviderId[] = ["gemini", "openrouter"];

/**
 * Which provider issued a key, from its shape alone. OpenRouter keys are
 * "sk-or-…"; Google AI Studio keys are "AIza…" (classic) or "AQ.…" (newer).
 * Unknown shapes are treated as OpenRouter, the original default.
 */
export function detectProvider(key: string): { id: ProviderId; recognised: boolean } {
  const k = key.trim();
  if (/^sk-or-/i.test(k)) return { id: "openrouter", recognised: true };
  if (/^(AIza|AQ\.)/.test(k)) return { id: "gemini", recognised: true };
  return { id: "openrouter", recognised: false };
}
