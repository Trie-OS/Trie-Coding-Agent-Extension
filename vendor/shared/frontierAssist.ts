/**
 * Frontier Assist — optional cloud model for stuck hints, plan critique, and spot-checks.
 * Defaults to frontier-tier models (not mini/haiku).
 */
import type { AppSettings } from './appSettings'

export const FRONTIER_ASSIST_PROVIDERS = ['openai', 'anthropic'] as const
export type FrontierAssistProvider = (typeof FRONTIER_ASSIST_PROVIDERS)[number]

/** Default model ID per provider when settings.model is empty. */
export const DEFAULT_FRONTIER_ASSIST_MODEL: Record<FrontierAssistProvider, string> = {
  openai: 'gpt-4o',
  anthropic: 'claude-sonnet-4-20250514',
}

/** Suggested frontier models shown in Settings (excludes mini/haiku). */
export const FRONTIER_ASSIST_MODEL_SUGGESTIONS: Record<
  FrontierAssistProvider,
  readonly string[]
> = {
  openai: ['gpt-4o', 'gpt-4-turbo', 'o1'],
  anthropic: [
    'claude-sonnet-4-20250514',
    'claude-3-5-sonnet-20241022',
    'claude-3-opus-20240229',
  ],
}

export function defaultFrontierAssistModel(provider: FrontierAssistProvider): string {
  return DEFAULT_FRONTIER_ASSIST_MODEL[provider]
}

/** Resolved model ID for API calls (explicit setting or provider default). */
export function resolveFrontierAssistModel(
  frontierAssist: AppSettings['frontierAssist'],
): string {
  const trimmed = frontierAssist.model.trim()
  if (trimmed.length > 0) return trimmed
  return defaultFrontierAssistModel(frontierAssist.provider)
}

/** When switching provider, reset model if it was empty or matched the old default. */
export function frontierAssistModelForProviderChange(
  currentModel: string,
  fromProvider: FrontierAssistProvider,
  toProvider: FrontierAssistProvider,
): string {
  const trimmed = currentModel.trim()
  if (trimmed.length === 0) return ''
  if (trimmed === DEFAULT_FRONTIER_ASSIST_MODEL[fromProvider]) return ''
  return trimmed
}
