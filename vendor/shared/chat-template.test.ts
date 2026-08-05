import { describe, expect, it, vi } from 'vitest'
import { ForgeError } from './errors'
import type { ChatTurn } from './inference'
import {
  detectTemplateFromJinja,
  KNOWN_BROKEN_OVERRIDES,
  looksLikeJinja,
  normalizeStoredTemplate,
  renderPrompt,
  selectTemplate,
  templateIds,
  type GgufTemplateMetadata,
} from './chat-template'

/**
 * The verbatim `tokenizer.chat_template` of Gemma instruct GGUFs — the exact
 * raw Jinja that leaked into `models.chat_template` and produced the user's
 * "unknown chat template" load failure.
 */
const GEMMA_JINJA =
  "{{ bos_token }}{% if messages[0]['role'] == 'system' %}{{ raise_exception('System role not supported') }}{% endif %}{% for message in messages %}{% if (message['role'] == 'user') != (loop.index0 % 2 == 0) %}{{ raise_exception('Conversation roles must alternate user/assistant/user/assistant/...') }}{% endif %}{% if (message['role'] == 'assistant') %}{% set role = 'model' %}{% else %}{% set role = message['role'] %}{% endif %}{{ '<start_of_turn>' + role + '\\n' + message['content'] | trim + '<end_of_turn>\\n' }}{% endfor %}{% if add_generation_prompt %}{{'<start_of_turn>model\\n'}}{% endif %}"

const CHATML_JINJA =
  "{% for message in messages %}{{'<|im_start|>' + message['role'] + '\\n' + message['content'] + '<|im_end|>' + '\\n'}}{% endfor %}{% if add_generation_prompt %}{{ '<|im_start|>assistant\\n' }}{% endif %}"

const UNKNOWN_JINJA =
  "{% for message in messages %}{{ '<<TURN:' + message['role'] + '>>' + message['content'] }}{% endfor %}"

const meta = (overrides: Partial<GgufTemplateMetadata> = {}): GgufTemplateMetadata => ({
  chatTemplate: null,
  arch: null,
  modelName: null,
  ...overrides,
})

const turns: ChatTurn[] = [
  { role: 'system', content: 'You are a coding assistant.' },
  { role: 'user', content: 'Write add()' },
  { role: 'assistant', content: 'Sure.' },
  { role: 'user', content: 'Now in Rust' },
]

describe('selectTemplate — precedence', () => {
  it('honors an explicit manifest/registry value above everything else', () => {
    const selection = selectTemplate(
      meta({ registryTemplate: 'phi3', arch: 'gemma2', chatTemplate: '<|im_start|>' }),
    )
    expect(selection).toMatchObject({ id: 'phi3', source: 'registry' })
  })

  it('rejects an unknown manifest template loudly instead of guessing', () => {
    expect(() => selectTemplate(meta({ registryTemplate: 'vicuna-1.1' }))).toThrowError(ForgeError)
    try {
      selectTemplate(meta({ registryTemplate: 'vicuna-1.1' }))
    } catch (error) {
      expect((error as ForgeError).code).toBe('CHAT_TEMPLATE_UNKNOWN')
    }
  })

  it('applies the known-broken override above the embedded GGUF template', () => {
    // A Gemma GGUF that *does* carry a template still gets overridden.
    const selection = selectTemplate(
      meta({ arch: 'gemma4', modelName: 'Gemma 4 26B it', chatTemplate: '<start_of_turn>' }),
    )
    expect(selection.id).toBe('gemma')
    expect(selection.source).toBe('override')
    expect(selection.reason).toMatch(/start_of_turn|system role/i)
  })

  it('overrides Llama 3 for the eot_id stop-token bug', () => {
    const selection = selectTemplate(
      meta({ arch: 'llama', modelName: 'Meta-Llama-3.1-8B-Instruct' }),
    )
    expect(selection).toMatchObject({ id: 'llama3', source: 'override' })
    expect(selection.reason).toContain('eot_id')
  })

  it('overrides gpt-oss to harmony format', () => {
    const selection = selectTemplate(meta({ modelName: 'gpt-oss-120b-MXFP4', arch: 'gpt-oss' }))
    expect(selection).toMatchObject({ id: 'harmony', source: 'override' })
  })

  it('harmony stops on final return, not analysis channel end', () => {
    const rendered = renderPrompt('harmony', [
      { role: 'user', content: 'Tell me about this project.' },
    ])
    expect(rendered.stopSequences).toEqual(['<|return|>', '<|call|>'])
    expect(rendered.stopSequences).not.toContain('<|end|>')
  })

  it('does not override Llama 2 (the bug is Llama-3-specific)', () => {
    expect(() =>
      selectTemplate(meta({ arch: 'llama', modelName: 'Llama-2-7b-chat' })),
    ).toThrowError(ForgeError)
  })

  it('reads the family out of the embedded Jinja when no override applies', () => {
    const selection = selectTemplate(
      meta({ chatTemplate: '{% for m in messages %}<|im_start|>{{m.role}}\n{% endfor %}' }),
    )
    expect(selection).toMatchObject({ id: 'chatml', source: 'gguf' })
  })

  it('falls back to general.architecture when the template is missing entirely', () => {
    expect(selectTemplate(meta({ arch: 'qwen2' }))).toMatchObject({ id: 'chatml', source: 'gguf' })
    expect(selectTemplate(meta({ arch: 'deepseek2' }))).toMatchObject({ id: 'deepseek' })
    expect(selectTemplate(meta({ arch: 'phi3' }))).toMatchObject({ id: 'phi3' })
    expect(selectTemplate(meta({ arch: 'mixtral' }))).toMatchObject({ id: 'mistral' })
  })

  it('fails loudly rather than guessing when nothing identifies the family', () => {
    try {
      selectTemplate(meta({ arch: 'bitnet', modelName: 'mystery-model' }))
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as ForgeError).code).toBe('CHAT_TEMPLATE_UNKNOWN')
      expect((error as ForgeError).message).toContain('manifest.json')
    }
  })

  it('every override names a real template id', () => {
    for (const override of KNOWN_BROKEN_OVERRIDES) {
      expect(templateIds).toContain(override.id)
      expect(override.reason.length).toBeGreaterThan(20)
    }
  })
})

describe('detectTemplateFromJinja / looksLikeJinja / normalizeStoredTemplate', () => {
  it("detects gemma from the exact raw Jinja in the user's load failure", () => {
    expect(detectTemplateFromJinja(GEMMA_JINJA)).toBe('gemma')
  })

  it('detects each family by its turn markers', () => {
    expect(detectTemplateFromJinja(CHATML_JINJA)).toBe('chatml')
    expect(detectTemplateFromJinja('...<|start_header_id|>user<|end_header_id|>...')).toBe('llama3')
    expect(detectTemplateFromJinja("{{ '[INST] ' + message['content'] + ' [/INST]' }}")).toBe(
      'mistral',
    )
    expect(detectTemplateFromJinja("{{ '<|user|>\\n' + message['content'] + '<|end|>' }}")).toBe(
      'phi3',
    )
  })

  it('returns null (never throws) for an unrecognized template', () => {
    expect(detectTemplateFromJinja(UNKNOWN_JINJA)).toBeNull()
    expect(detectTemplateFromJinja('')).toBeNull()
  })

  it('looksLikeJinja distinguishes Jinja source from template ids', () => {
    expect(looksLikeJinja(GEMMA_JINJA)).toBe(true)
    expect(looksLikeJinja('{% for m in messages %}')).toBe(true)
    expect(looksLikeJinja('gemma')).toBe(false)
    expect(looksLikeJinja('vicuna-1.1')).toBe(false)
  })

  it('normalizeStoredTemplate: known ids and null/empty pass through', () => {
    for (const id of templateIds) expect(normalizeStoredTemplate(id)).toBe(id)
    expect(normalizeStoredTemplate(null)).toBeNull()
    expect(normalizeStoredTemplate(undefined)).toBeNull()
    expect(normalizeStoredTemplate('')).toBeNull()
  })

  it('normalizeStoredTemplate: raw Jinja becomes the detected id', () => {
    expect(normalizeStoredTemplate(GEMMA_JINJA)).toBe('gemma')
    expect(normalizeStoredTemplate(CHATML_JINJA)).toBe('chatml')
  })

  it('normalizeStoredTemplate: unrecognized Jinja becomes null with a warning, not a throw', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(normalizeStoredTemplate(UNKNOWN_JINJA)).toBeNull()
      expect(warn).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
    }
  })

  it('normalizeStoredTemplate: a human-typed unknown id passes through for the loud failure', () => {
    // Explicit-but-wrong manifest values must keep failing loudly downstream,
    // never get silently dropped by normalization.
    expect(normalizeStoredTemplate('vicuna-1.1')).toBe('vicuna-1.1')
  })
})

describe('selectTemplate — raw Jinja leaked into the registry slot', () => {
  it("resolves the user's Gemma Jinja stored as models.chat_template instead of throwing", () => {
    const selection = selectTemplate(meta({ registryTemplate: GEMMA_JINJA }))
    expect(selection).toMatchObject({ id: 'gemma', source: 'registry' })
  })

  it('resolves chatml-marker Jinja in the registry slot', () => {
    const selection = selectTemplate(meta({ registryTemplate: CHATML_JINJA }))
    expect(selection).toMatchObject({ id: 'chatml', source: 'registry' })
  })

  it('unrecognized registry Jinja falls through to arch detection', () => {
    const selection = selectTemplate(meta({ registryTemplate: UNKNOWN_JINJA, arch: 'qwen2' }))
    expect(selection).toMatchObject({ id: 'chatml', source: 'gguf' })
  })

  it('unrecognized Jinja with no other evidence falls back to chatml with a visible warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const selection = selectTemplate(meta({ registryTemplate: UNKNOWN_JINJA, arch: 'bitnet' }))
      expect(selection).toMatchObject({ id: 'chatml', source: 'fallback' })
      expect(selection.reason).toMatch(/could not identify/i)
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('an unidentifiable *embedded* template also falls back to chatml instead of refusing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const selection = selectTemplate(meta({ chatTemplate: UNKNOWN_JINJA, arch: 'bitnet' }))
      expect(selection).toMatchObject({ id: 'chatml', source: 'fallback' })
    } finally {
      warn.mockRestore()
    }
  })
})

describe('renderPrompt — the same conversation across model families', () => {
  it('chatml wraps every role and opens an assistant turn', () => {
    const { prompt, stopSequences } = renderPrompt('chatml', turns)
    expect(prompt).toBe(
      '<|im_start|>system\nYou are a coding assistant.<|im_end|>\n' +
        '<|im_start|>user\nWrite add()<|im_end|>\n' +
        '<|im_start|>assistant\nSure.<|im_end|>\n' +
        '<|im_start|>user\nNow in Rust<|im_end|>\n' +
        '<|im_start|>assistant\n',
    )
    expect(stopSequences).toEqual(['<|im_end|>', '<|endoftext|>'])
  })

  it('llama3 emits header ids and stops on <|eot_id|> first', () => {
    const { prompt, stopSequences } = renderPrompt('llama3', turns)
    expect(prompt.startsWith('<|begin_of_text|><|start_header_id|>system<|end_header_id|>')).toBe(
      true,
    )
    expect(prompt.endsWith('<|start_header_id|>assistant<|end_header_id|>\n\n')).toBe(true)
    expect(prompt.match(/<\|eot_id\|>/g)).toHaveLength(4)
    expect(stopSequences[0]).toBe('<|eot_id|>')
  })

  it('gemma receives trailing project context on the current user turn', () => {
    const turns: ChatTurn[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      {
        role: 'user',
        content: '--- Active project ---\nYou are helping with "Trie IDE".\n\nTell me about this project',
      },
    ]
    const { prompt } = renderPrompt('gemma', turns)
    expect(prompt).toContain('Active project')
    expect(prompt).toContain('Tell me about this project')
    expect(prompt).not.toContain('<start_of_turn>system')
  })

  it('gemma has no system role — system text is folded into the first user turn', () => {
    const { prompt, stopSequences } = renderPrompt('gemma', turns)
    expect(prompt).not.toContain('system')
    expect(prompt).toContain('<start_of_turn>user\nYou are a coding assistant.\n\nWrite add()')
    // assistant becomes 'model'
    expect(prompt).toContain('<start_of_turn>model\nSure.<end_of_turn>')
    expect(prompt.endsWith('<start_of_turn>model\n')).toBe(true)
    expect(stopSequences).toEqual(['<end_of_turn>', '<eos>'])
  })

  it('mistral uses [INST] blocks and folds the system prompt', () => {
    const { prompt } = renderPrompt('mistral', turns)
    expect(prompt.startsWith('<s>[INST] You are a coding assistant.\n\nWrite add() [/INST]')).toBe(
      true,
    )
    expect(prompt).toContain('Sure.</s>')
    expect(prompt.endsWith('[INST] Now in Rust [/INST]')).toBe(true)
  })

  it('phi3 and deepseek render their own shapes', () => {
    expect(renderPrompt('phi3', turns).prompt).toContain('<|user|>\nWrite add()<|end|>')
    const deepseek = renderPrompt('deepseek', turns)
    expect(deepseek.prompt).toContain('### Instruction:\n')
    expect(deepseek.prompt.endsWith('### Response:\n')).toBe(true)
  })

  it('every template ends with an open assistant turn and non-empty stops', () => {
    for (const id of templateIds) {
      const rendered = renderPrompt(id, turns)
      expect(rendered.prompt.length).toBeGreaterThan(0)
      expect(rendered.stopSequences.length).toBeGreaterThan(0)
      // The last thing in the prompt must not be a completed turn.
      expect(rendered.prompt.trimEnd().endsWith(rendered.stopSequences[0] as string)).toBe(false)
    }
  })

  it('handles a system-only conversation without dropping the system text', () => {
    const only: ChatTurn[] = [{ role: 'system', content: 'Be terse.' }]
    expect(renderPrompt('gemma', only).prompt).toContain('Be terse.')
    expect(renderPrompt('mistral', only).prompt).toContain('Be terse.')
  })

  it('refuses to render an empty conversation', () => {
    expect(() => renderPrompt('chatml', [])).toThrowError(ForgeError)
  })
})
