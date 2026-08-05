/**
 * Chat template handling (PLAN.md Phase 3 — "Chat template handling per model
 * family (chatml, llama3, gemma…) read from GGUF metadata").
 *
 * Two jobs:
 *   1. `selectTemplate` — decide which template a loaded model should use,
 *      from GGUF metadata plus a small table of *known-broken* overrides.
 *   2. `renderPrompt` — turn a conversation into the exact prompt string and
 *      the stop sequences that terminate an assistant turn.
 *
 * Why we render ourselves instead of executing the GGUF's embedded Jinja:
 * the embedded templates are the single most common source of silent local-
 * model breakage, and a wrong template fails *quietly* (the model rambles past
 * its turn, hallucinates the user's next message, or emits raw control
 * tokens). Deterministic, unit-tested renderers per family let us fail loudly
 * (`CHAT_TEMPLATE_UNKNOWN`) instead of half-working.
 *
 * Known-broken templates found while researching this (July 2026):
 *   - **Gemma 4 GGUFs converted before ~May 2026** shipped broken
 *     start_of_turn/end_of_turn markers; reported symptoms are the model
 *     continuing past its turn, inventing user replies, and echoing literal
 *     template tokens. Some Gemma 4 conversions omit `tokenizer.chat_template`
 *     from the metadata entirely (e.g. NVFP4 conversions with only 52 KV
 *     pairs). llama.cpp's own remedy is `--chat-template-file`, i.e. exactly
 *     an override.
 *   - **Every Gemma template rejects a `system` role** — passing one is a
 *     template exception upstream, so we fold system text into the first user
 *     turn (documented behavior, not a silent drop).
 *   - **Llama 3 GGUFs** had the well-known EOS bug where `<|eot_id|>` (128009)
 *     is not treated as a stop token, so generation never terminates; the
 *     upstream remedy is forcing `--chat-template llama3`, which is what our
 *     override does.
 *   - **Several older conversions ship no template at all** (deepseek-coder,
 *     small Mistral finetunes), which is why arch/name inference exists.
 *
 * Sources consulted: llama.cpp issues #18895 / #12897 / discussion #10604,
 * huggingface.co/google/gemma-7b-it/discussions/38, and the Gemma-4 GGUF
 * chat-template fix write-ups of 2026-05.
 */
import { ForgeError } from './errors'
import type { ChatTurn } from './inference'

export const templateIds = ['chatml', 'llama3', 'gemma', 'mistral', 'phi3', 'deepseek', 'harmony'] as const
export type TemplateId = (typeof templateIds)[number]

export function isTemplateId(value: unknown): value is TemplateId {
  return typeof value === 'string' && (templateIds as readonly string[]).includes(value)
}

/**
 * Where the selected template came from — surfaced in the UI. 'fallback'
 * marks the one case where we *did* guess (unidentifiable Jinja template,
 * see the end of `selectTemplate`), so the guess is never presented as fact.
 */
export type TemplateSource = 'gguf' | 'override' | 'registry' | 'fallback'

export interface TemplateSelection {
  id: TemplateId
  source: TemplateSource
  /** Human-readable justification, shown in the model detail panel. */
  reason: string
}

export interface GgufTemplateMetadata {
  /** `tokenizer.chat_template` — the embedded Jinja source, if any. */
  chatTemplate: string | null
  /** `general.architecture` — 'qwen2', 'llama', 'gemma2', 'phi3', … */
  arch: string | null
  /** `general.name` — often the only place the family/version shows up. */
  modelName: string | null
  /**
   * `models.chat_template` from the registry (drive manifest). User- or
   * manifest-authored, so it outranks everything: an explicit choice is never
   * second-guessed.
   */
  registryTemplate?: string | null
}

interface BrokenTemplateOverride {
  id: TemplateId
  reason: string
  matches(meta: GgufTemplateMetadata): boolean
}

const lower = (value: string | null | undefined): string => (value ?? '').toLowerCase()

/**
 * Families whose embedded GGUF template is known to be wrong often enough that
 * we do not trust it. Each entry cites the concrete failure it prevents.
 */
export const KNOWN_BROKEN_OVERRIDES: readonly BrokenTemplateOverride[] = [
  {
    id: 'harmony',
    reason:
      'gpt-oss models require the OpenAI Harmony chat format; other templates leak chain-of-thought analysis as the visible reply.',
    matches: (m) =>
      /\bgpt[-_]?oss\b/i.test(lower(m.modelName)) ||
      /gpt_oss|gpt-oss/i.test(lower(m.arch)),
  },
  {
    id: 'gemma',
    reason:
      'Gemma GGUF templates are overridden: pre-May-2026 Gemma 4 conversions ship broken start_of_turn/end_of_turn markers (model runs past its turn), some conversions omit the template entirely, and every Gemma template rejects a system role.',
    matches: (m) => /^gemma/.test(lower(m.arch)) || /\bgemma\b/.test(lower(m.modelName)),
  },
  {
    id: 'llama3',
    reason:
      'Llama 3 GGUF templates are overridden: the well-known EOS bug leaves <|eot_id|> (128009) untreated as a stop token, so generation never terminates. Forcing the llama3 template supplies the correct stop sequences.',
    matches: (m) =>
      /^llama/.test(lower(m.arch)) && /llama[-_ ]?3(\.\d)?\b/.test(lower(m.modelName)),
  },
]

/** Fingerprints for reading the family straight out of the embedded Jinja. */
const JINJA_FINGERPRINTS: ReadonlyArray<[RegExp, TemplateId]> = [
  [/<\|start\|>/, 'harmony'],
  [/<\|im_start\|>/, 'chatml'],
  [/<\|start_header_id\|>/, 'llama3'],
  [/<start_of_turn>/, 'gemma'],
  [/<\|user\|>/, 'phi3'],
  [/\[INST\]/, 'mistral'],
  [/### Instruction/i, 'deepseek'],
]

/** True when a chat-template value is raw Jinja source rather than a template id. */
export function looksLikeJinja(value: string): boolean {
  return value.includes('{{') || value.includes('{%')
}

/**
 * Sniff a raw Jinja/GGUF chat-template string (`tokenizer.chat_template`)
 * and map it to a known template id by its turn markers. Returns null when
 * no marker is recognized.
 *
 * Callers treat null as "fall back to model-default detection (arch), or
 * chatml, with a visible warning" — deliberately NOT a hard failure, unlike
 * the rest of this file's fail-loudly policy: a wrong-but-working template
 * beats refusing to load the model outright, and the detection failure is
 * still reported (warning in the selection reason + console), never silent.
 */
export function detectTemplateFromJinja(source: string): TemplateId | null {
  for (const [pattern, id] of JINJA_FINGERPRINTS) {
    if (pattern.test(source)) return id
  }
  return null
}

/**
 * Normalize a persisted chat-template value (`models.chat_template`, a drive
 * manifest's `chatTemplate`, or `tokenizer.chat_template` straight out of a
 * GGUF header) to a template id.
 *
 * GGUF headers carry raw Jinja source, and scans used to persist that source
 * verbatim — so a stored value may be a known id, raw Jinja, or a
 * human-typed string. Rules:
 *   - a known id passes through unchanged;
 *   - raw Jinja is fingerprinted to an id; unrecognized Jinja becomes null
 *     (model-default detection takes over at load time) with a console
 *     warning — see `detectTemplateFromJinja` on why this is a warning
 *     rather than a hard failure;
 *   - any other string (e.g. a hand-typed "vicuna-1.1" in a manifest) passes
 *     through untouched so the existing loud CHAT_TEMPLATE_UNKNOWN still
 *     fires downstream: an explicit human-authored value is never silently
 *     dropped.
 */
export function normalizeStoredTemplate(value: string | null | undefined): string | null {
  if (value == null || value === '') return null
  if (isTemplateId(value)) return value
  const detected = detectTemplateFromJinja(value)
  if (detected) return detected
  if (looksLikeJinja(value)) {
    console.warn(
      `[chat-template] Unrecognized raw Jinja chat template ("${value.slice(0, 80)}…") — falling back to model-default template detection.`,
    )
    return null
  }
  return value
}

/** Last-resort inference from `general.architecture`. */
const ARCH_TEMPLATES: ReadonlyArray<[RegExp, TemplateId]> = [
  [/^qwen/, 'chatml'],
  [/^gemma/, 'gemma'],
  [/^phi/, 'phi3'],
  [/^(mistral|mixtral)/, 'mistral'],
  [/^deepseek/, 'deepseek'],
]

/**
 * Choose the template for a loaded model.
 *
 * Precedence, in order and by design:
 *   1. an explicit registry/manifest value (a human said so); raw Jinja that
 *      leaked into the registry (older scans persisted the GGUF's
 *      `tokenizer.chat_template` verbatim) is fingerprinted rather than
 *      rejected
 *   2. a known-broken-family override (we distrust the file)
 *   3. the embedded GGUF template, identified by fingerprint
 *   4. `general.architecture`
 * If none of those resolve but the model *does* carry a Jinja template we
 * simply couldn't identify, fall back to chatml with a visible warning; a
 * loud `CHAT_TEMPLATE_UNKNOWN` is reserved for models with no template
 * evidence at all, or an explicit human-authored id we don't know.
 */
export function selectTemplate(meta: GgufTemplateMetadata): TemplateSelection {
  const registry = meta.registryTemplate
  let unidentifiedJinja = false
  if (registry != null && registry !== '') {
    if (isTemplateId(registry)) {
      return { id: registry, source: 'registry', reason: 'Set explicitly in the model manifest.' }
    }
    if (looksLikeJinja(registry)) {
      // Raw Jinja stored where an id belongs (pre-normalization DB rows /
      // manifests). Fingerprint it; if unrecognized, fall through to the
      // normal detection chain instead of hard-failing.
      const detected = detectTemplateFromJinja(registry)
      if (detected) {
        return {
          id: detected,
          source: 'registry',
          reason: `Recognized the ${detected} format in the raw Jinja template stored for this model.`,
        }
      }
      unidentifiedJinja = true
    } else {
      throw new ForgeError(
        'CHAT_TEMPLATE_UNKNOWN',
        `The model manifest names an unknown chat template "${registry}". Known templates: ${templateIds.join(', ')}.`,
        { registryTemplate: registry },
      )
    }
  }

  for (const override of KNOWN_BROKEN_OVERRIDES) {
    if (override.matches(meta)) {
      return { id: override.id, source: 'override', reason: override.reason }
    }
  }

  if (meta.chatTemplate) {
    for (const [pattern, id] of JINJA_FINGERPRINTS) {
      if (pattern.test(meta.chatTemplate)) {
        return {
          id,
          source: 'gguf',
          reason: `Recognized the ${id} format in the GGUF's embedded chat template.`,
        }
      }
    }
  }

  const arch = lower(meta.arch)
  for (const [pattern, id] of ARCH_TEMPLATES) {
    if (pattern.test(arch)) {
      return {
        id,
        source: 'gguf',
        reason: `Inferred from the GGUF architecture "${meta.arch}" (no recognizable embedded template).`,
      }
    }
  }

  // The model carries a Jinja chat template we could not identify (either
  // leaked into the registry or embedded in the GGUF). Deliberate deviation
  // from this file's fail-loudly policy: a wrong-but-working template beats
  // refusing to load the model, so fall back to chatml — with the failure
  // *visible* (source 'fallback', warning reason shown in the model detail
  // panel, console warning), never silent.
  if (unidentifiedJinja || meta.chatTemplate) {
    const reason = `Could not identify this model's chat template (architecture "${meta.arch ?? 'unknown'}"); defaulting to chatml. If replies look malformed, set "chatTemplate" in the model's manifest.json to one of: ${templateIds.join(', ')}.`
    console.warn(`[chat-template] ${reason}`)
    return { id: 'chatml', source: 'fallback', reason }
  }

  throw new ForgeError(
    'CHAT_TEMPLATE_UNKNOWN',
    `Could not determine a chat template for this model (architecture "${meta.arch ?? 'unknown'}", name "${meta.modelName ?? 'unknown'}"). Set "chatTemplate" in the model's manifest.json to one of: ${templateIds.join(', ')}.`,
    { arch: meta.arch, modelName: meta.modelName, hasEmbeddedTemplate: meta.chatTemplate != null },
  )
}

export interface RenderedPrompt {
  prompt: string
  /** Strings that terminate the assistant turn. Never empty. */
  stopSequences: string[]
}

/** Merge leading system turns into the first user turn, for families with no system role. */
function foldSystemIntoUser(turns: ChatTurn[]): ChatTurn[] {
  const systemText = turns
    .filter((t) => t.role === 'system')
    .map((t) => t.content)
    .join('\n\n')
  const rest = turns.filter((t) => t.role !== 'system')
  if (systemText === '') return rest
  const firstUser = rest.findIndex((t) => t.role === 'user')
  if (firstUser === -1) return [{ role: 'user', content: systemText }, ...rest]
  return rest.map((turn, i) =>
    i === firstUser ? { role: turn.role, content: `${systemText}\n\n${turn.content}` } : turn,
  )
}

type Renderer = (turns: ChatTurn[]) => RenderedPrompt

const renderers: Record<TemplateId, Renderer> = {
  chatml: (turns) => ({
    prompt:
      turns.map((t) => `<|im_start|>${t.role}\n${t.content}<|im_end|>\n`).join('') +
      '<|im_start|>assistant\n',
    stopSequences: ['<|im_end|>', '<|endoftext|>'],
  }),

  llama3: (turns) => ({
    prompt:
      '<|begin_of_text|>' +
      turns
        .map((t) => `<|start_header_id|>${t.role}<|end_header_id|>\n\n${t.content}<|eot_id|>`)
        .join('') +
      '<|start_header_id|>assistant<|end_header_id|>\n\n',
    // <|eot_id|> first: the whole point of the llama3 override.
    stopSequences: ['<|eot_id|>', '<|end_of_text|>'],
  }),

  gemma: (turns) => ({
    prompt:
      foldSystemIntoUser(turns)
        .map(
          (t) =>
            `<start_of_turn>${t.role === 'assistant' ? 'model' : 'user'}\n${t.content}<end_of_turn>\n`,
        )
        .join('') + '<start_of_turn>model\n',
    stopSequences: ['<end_of_turn>', '<eos>'],
  }),

  mistral: (turns) => {
    const folded = foldSystemIntoUser(turns)
    const parts = folded.map((t) =>
      t.role === 'assistant' ? `${t.content}</s>` : `[INST] ${t.content} [/INST]`,
    )
    return { prompt: `<s>${parts.join('')}`, stopSequences: ['</s>', '[INST]'] }
  },

  phi3: (turns) => ({
    prompt: turns.map((t) => `<|${t.role}|>\n${t.content}<|end|>\n`).join('') + '<|assistant|>\n',
    stopSequences: ['<|end|>', '<|endoftext|>'],
  }),

  deepseek: (turns) => {
    const folded = foldSystemIntoUser(turns)
    const parts = folded.map((t) =>
      t.role === 'assistant'
        ? `### Response:\n${t.content}\n<|EOT|>\n`
        : `### Instruction:\n${t.content}\n`,
    )
    return {
      prompt: `${parts.join('')}### Response:\n`,
      stopSequences: ['<|EOT|>', '### Instruction:'],
    }
  },

  harmony: (turns) => {
    const systemText = turns
      .filter((t) => t.role === 'system')
      .map((t) => t.content)
      .join('\n\n')
    const dialogue = turns.filter((t) => t.role !== 'system')

    const parts: string[] = [
      `<|start|>system<|message|>You are ChatGPT, a large language model trained by OpenAI.
Knowledge cutoff: 2024-06
Reasoning: medium

# Valid channels: analysis, commentary, final. Channel must be included for every message.<|end|>`,
    ]

    if (systemText.trim() !== '') {
      parts.push(
        `<|start|>developer<|message|># Instructions\n\n${systemText.trim()}<|end|>`,
      )
    }

    for (const turn of dialogue) {
      if (turn.role === 'user') {
        parts.push(`<|start|>user<|message|>${turn.content}<|end|>`)
      } else if (turn.role === 'assistant') {
        parts.push(
          `<|start|>assistant<|channel|>final<|message|>${turn.content}<|end|>`,
        )
      }
    }

    parts.push('<|start|>assistant')

    return {
      prompt: parts.join(''),
      // Do NOT stop on `<|end|>` — the analysis channel closes with that token
      // before the model continues to the final channel. Stopping there is the
      // bug that produced "stopped during reasoning before a final answer."
      stopSequences: ['<|return|>', '<|call|>'],
    }
  },
}

/** Render `turns` into the prompt + stop sequences for `id`. */
export function renderPrompt(id: TemplateId, turns: ChatTurn[]): RenderedPrompt {
  if (turns.length === 0) {
    throw new ForgeError('CHAT_TEMPLATE_UNKNOWN', 'Cannot render an empty conversation.', {
      templateId: id,
    })
  }
  return renderers[id](turns)
}
