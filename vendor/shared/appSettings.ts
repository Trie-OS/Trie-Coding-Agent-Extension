/**
 * App-wide settings persisted in userData/settings.json (not per-workspace).
 * Phase 6 — onboarding flag, theme, default generation params.
 */
import { z } from 'zod'
import { MAX_AGENT_MAX_TOOL_CALLS, MIN_AGENT_MAX_TOOL_CALLS } from './agentLimits'
import { DEFAULT_GENERATION_PARAMS, generationParamsSchema } from './inference'
import { FRONTIER_ASSIST_PROVIDERS } from './frontierAssist'

z.config({ jitless: true })

export const themeSchema = z.enum(['dark', 'light'])
export type Theme = z.infer<typeof themeSchema>

/** OpenAI-compatible HTTP provider (Kimi / opencodex / local proxy). */
export const apiProviderSettingsSchema = z.object({
  enabled: z.boolean(),
  /** Origin only, e.g. `http://127.0.0.1:8080` — `/v1/chat/completions` is appended. */
  baseUrl: z.string(),
  /** Model id sent in the chat/completions body. */
  modelName: z.string(),
  /** Optional Bearer token for proxies that require auth. */
  apiKey: z.string().optional(),
  /**
   * Opt-in for llama.cpp `llama-server` (and compatible proxies): sends
   * `cache_prompt: true` in the chat/completions body so the server reuses
   * its KV cache across the growing prompts of an agent tool loop. Off by
   * default because unknown OpenAI-compatible endpoints may reject unknown
   * body fields. Optional so settings.json files written before this field
   * existed still parse; absent = disabled.
   */
  llamaServerCompatible: z.boolean().optional(),
})
export type ApiProviderSettings = z.infer<typeof apiProviderSettingsSchema>

export const defaultApiProviderSettings: ApiProviderSettings = {
  enabled: false,
  baseUrl: 'http://127.0.0.1:8080',
  modelName: 'kimi-k3',
}

/** Local MLX model server via `mlx_lm.server` (Apple Silicon only). */
export const mlxProviderSettingsSchema = z.object({
  enabled: z.boolean(),
  /** Local path to an MLX model directory. */
  modelPath: z.string(),
  /** Local port for the `mlx_lm.server` subprocess. */
  port: z.number().int().positive().default(8765),
  /** Extra CLI args passed to `mlx_lm.server`. */
  extraArgs: z.string().optional(),
})
export type MlxProviderSettings = z.infer<typeof mlxProviderSettingsSchema>

export const defaultMlxProviderSettings: MlxProviderSettings = {
  enabled: false,
  modelPath: 'mlx-community/Mistral-7B-Instruct-v0.3-4bit',
  port: 8765,
}

/** Optional cloud assist for stuck hints, plan critique, and spot-checks. */
export const frontierAssistSettingsSchema = z.object({
  enabled: z.boolean(),
  provider: z.enum(FRONTIER_ASSIST_PROVIDERS),
  /** Empty string uses the frontier default for the selected provider. */
  model: z.string(),
  apiKey: z.string(),
})
export type FrontierAssistSettings = z.infer<typeof frontierAssistSettingsSchema>

export const defaultFrontierAssistSettings: FrontierAssistSettings = {
  enabled: false,
  provider: 'openai',
  model: '',
  apiKey: '',
}

/** Internet search for the agent's `web_search` tool. Calls the provider API directly from this machine. */
export const WEB_SEARCH_PROVIDERS = ['none', 'exa', 'tavily', 'ceramic'] as const
export type WebSearchProvider = (typeof WEB_SEARCH_PROVIDERS)[number]

export const webSearchSettingsSchema = z.object({
  provider: z.enum(WEB_SEARCH_PROVIDERS),
  apiKey: z.string(),
  /** Results per query handed back to the model. */
  maxResults: z.number().int().min(1).max(10),
})
export type WebSearchSettings = z.infer<typeof webSearchSettingsSchema>

export const defaultWebSearchSettings: WebSearchSettings = {
  provider: 'none',
  apiKey: '',
  maxResults: 5,
}

/** True when the `web_search` tool can actually reach a provider. */
export function webSearchConfigured(settings: WebSearchSettings): boolean {
  return settings.provider !== 'none' && settings.apiKey.trim().length > 0
}

export const appSettingsSchema = z.object({
  /** Set true after onboarding completes or the user skips it. */
  onboardingComplete: z.boolean(),
  theme: themeSchema,
  generationParams: generationParamsSchema,
  /** Default model id for new conversations; null = user picks each time. */
  defaultModelId: z.string().nullable().optional(),
  /**
   * Ghost-text inline completions in the editor. Optional so settings.json
   * files written before this field existed still parse; absent = enabled.
   */
  inlineCompletions: z.boolean().optional(),
  /**
   * External OpenAI-compatible provider. Optional so older settings.json
   * files still parse; absent = disabled defaults.
   */
  apiProvider: apiProviderSettingsSchema.default(defaultApiProviderSettings),
  /**
   * Local MLX model server via `mlx_lm.server`. Optional so older settings.json
   * files still parse; absent = disabled defaults.
   */
  mlxProvider: mlxProviderSettingsSchema.default(defaultMlxProviderSettings),
  /**
   * Frontier Assist — optional cloud model for hints and review. Optional so
   * older settings.json files still parse; absent = disabled defaults.
   */
  frontierAssist: frontierAssistSettingsSchema.default(defaultFrontierAssistSettings),
  /**
   * Internet search for the agent (`web_search` tool). Optional so older
   * settings.json files still parse; absent = disabled defaults.
   */
  webSearch: webSearchSettingsSchema.default(defaultWebSearchSettings),
  /**
   * Max tool calls per direct agent turn (and agent-mode subagents). Optional
   * so older settings.json files still parse; absent = DEFAULT_AGENT_MAX_CALLS.
   */
  agentMaxToolCalls: z
    .number()
    .int()
    .min(MIN_AGENT_MAX_TOOL_CALLS)
    .max(MAX_AGENT_MAX_TOOL_CALLS)
    .optional(),
})

export type AppSettings = z.infer<typeof appSettingsSchema>

export const defaultAppSettings: AppSettings = {
  onboardingComplete: false,
  theme: 'dark',
  generationParams: DEFAULT_GENERATION_PARAMS,
  defaultModelId: null,
  inlineCompletions: true,
  apiProvider: defaultApiProviderSettings,
  mlxProvider: defaultMlxProviderSettings,
  frontierAssist: defaultFrontierAssistSettings,
  webSearch: defaultWebSearchSettings,
}

/** Resolve the tri-state stored value to the effective on/off. */
export function inlineCompletionsEnabled(settings: Pick<AppSettings, 'inlineCompletions'>): boolean {
  return settings.inlineCompletions !== false
}

export function parseAppSettings(raw: unknown): AppSettings {
  const parsed = appSettingsSchema.safeParse(raw)
  if (!parsed.success) {
    console.error('Discarding malformed app settings:', parsed.error)
    return defaultAppSettings
  }
  return parsed.data
}
