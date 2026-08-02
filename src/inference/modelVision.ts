/**
 * Vision-capability heuristics for extension backends (mirrors app modelVision.ts).
 */

export interface ModelVisionHints {
  arch: string | null
  hfRepoId: string | null
  displayName: string
  hfFile: string | null
}

export const ACCEPTED_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const

export type AcceptedImageMimeType = (typeof ACCEPTED_IMAGE_MIME_TYPES)[number]

const ACCEPTED_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])

const VISION_ARCHITECTURES = new Set([
  'llava',
  'llava-next',
  'llava-next-moe',
  'qwen2vl',
  'qwen2_vl',
  'qwen3vl',
  'gemma3',
  'mllama',
  'pixtral',
  'minicpmv',
  'minicpm-v',
  'moondream',
  'bakllava',
  'internvl',
])

const TEXT_ONLY_ARCHITECTURES = new Set(['gemma', 'gemma2', 'qwen2', 'qwen3', 'llama', 'mistral'])

function nameHaystack(model: ModelVisionHints): string {
  return [model.hfRepoId, model.displayName, model.hfFile]
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    .join(' ')
    .toLowerCase()
}

function hasVisionNameHint(haystack: string): boolean {
  return /\b(vl|vision|llava|multimodal|mmproj|moondream|bakllava|minicpm-v|minicpmv|pixtral|internvl|gpt-4o|gpt-4\.1|claude-3|claude-sonnet-4|gemini)\b/.test(
    haystack,
  )
}

export function modelSupportsVision(model: ModelVisionHints): boolean {
  const arch = model.arch?.toLowerCase().trim() ?? ''
  const haystack = nameHaystack(model)

  if (hasVisionNameHint(haystack)) return true

  if (arch !== '') {
    if (VISION_ARCHITECTURES.has(arch)) return true
    if (arch.includes('vl') || arch.includes('llava')) return true
    if (arch === 'gemma' || arch === 'gemma2') return false
    if (arch.startsWith('gemma') && !haystack.includes('vision') && !haystack.includes('vl')) {
      return false
    }
    if (TEXT_ONLY_ARCHITECTURES.has(arch) && !haystack.includes('vl') && !haystack.includes('vision')) {
      return false
    }
  }

  return false
}

export function isAcceptedImageMimeType(mimeType: string): mimeType is AcceptedImageMimeType {
  return (ACCEPTED_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType)
}

export function isAcceptedImageFile(file: Pick<File, 'type' | 'name'>): boolean {
  if (isAcceptedImageMimeType(file.type)) return true
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  return ACCEPTED_IMAGE_EXTENSIONS.has(ext)
}

export const NON_VISION_MODEL_IMAGE_ERROR =
  'This model does not support images. Pick a vision-capable model to attach images.'

export const VISION_INFERENCE_NOT_SUPPORTED_ERROR =
  'Vision inference is not yet supported for this local model in the extension. Use an LLM API backend with a vision model, or a cloud endpoint.'

export type ImageAttachmentSupport = 'supported' | 'non-vision-model' | 'inference-not-supported'

export function imageAttachmentSupportError(support: ImageAttachmentSupport): string | null {
  if (support === 'non-vision-model') return NON_VISION_MODEL_IMAGE_ERROR
  if (support === 'inference-not-supported') return VISION_INFERENCE_NOT_SUPPORTED_ERROR
  return null
}

/** Resolve image attachment support for the active extension backend. */
export function extensionImageAttachmentSupport(
  backend: 'daemon' | 'openai-compatible',
  loadedModelName: string | null,
): ImageAttachmentSupport {
  if (backend === 'openai-compatible') return 'supported'
  const label = loadedModelName ?? ''
  if (!label.trim()) return 'non-vision-model'
  const hints: ModelVisionHints = {
    arch: null,
    hfRepoId: null,
    displayName: label,
    hfFile: label,
  }
  if (!modelSupportsVision(hints)) return 'non-vision-model'
  return 'inference-not-supported'
}

export function imageAttachmentsBlockedMessage(
  backend: 'daemon' | 'openai-compatible',
  loadedModelName: string | null,
  imageCount: number,
): string | null {
  if (imageCount === 0) return null
  return imageAttachmentSupportError(extensionImageAttachmentSupport(backend, loadedModelName))
}
