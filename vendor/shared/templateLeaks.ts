/**
 * Strip chat-template special tokens that models leak into assistant output.
 * Inline tokens (e.g. `<s>`) are removed; turn-boundary markers truncate the rest.
 */

/** Content from here onward is a new turn or garbage — drop it. */
const TRUNCATE_AT = [
  '[INST]',
  '[/INST]',
  '</s>',
  '<|im_start|>',
  '<|im_end|>',
  '<|endoftext|>',
  '<|eot_id|>',
  '<|end_of_text|>',
  '<|start_header_id|>',
  '<end_of_turn>',
  '<start_of_turn>',
  '<|end|>',
  '<|assistant|>',
  '<|user|>',
  '<|start|>user',
  '<|start|>assistant',
  '<|channel|>',
  '<|message|>',
  '<|return|>',
] as const

/** Remove in place — following text may still belong to this answer. */
const INLINE_STRIP = ['<s>'] as const

export function stripLeakedTemplateTokens(text: string): string {
  let cut = text.length
  for (const marker of TRUNCATE_AT) {
    const at = text.indexOf(marker)
    if (at !== -1 && at < cut) cut = at
  }
  let out = text.slice(0, cut)
  for (const token of INLINE_STRIP) {
    out = out.split(token).join('')
  }
  return out
}
