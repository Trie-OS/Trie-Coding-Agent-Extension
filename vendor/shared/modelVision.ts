/**
 * Heuristic vision-capability detection for GGUF models.
 *
 * Uses architecture metadata plus repo/display/file name hints. This is
 * intentionally conservative for known text-only families (Gemma, Qwen2-Coder)
 * while treating explicit VL / LLaVA / multimodal naming as vision-capable.
 */
import { isApiProviderModelId } from './apiProvider'
import { isMlxProviderModelId } from './mlxProvider'

export interface ModelVisionHints {
  arch: string | null
  hfRepoId: string | null
  displayName: string
  hfFile: string | null
}

/** MIME types accepted for chat image attachments. */
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
  return /\b(vl|vision|llava|multimodal|mmproj|moondream|bakllava|minicpm-v|minicpmv|pixtral|internvl)\b/.test(
    haystack,
  )
}

/** True when the loaded model is likely to accept image inputs. */
export function modelSupportsVision(model: ModelVisionHints): boolean {
  const arch = model.arch?.toLowerCase().trim() ?? ''
  const haystack = nameHaystack(model)

  if (hasVisionNameHint(haystack)) return true

  if (arch !== '') {
    if (VISION_ARCHITECTURES.has(arch)) return true
    if (arch.includes('vl') || arch.includes('llava')) return true

    // Gemma text-only unless explicitly marked vision/VL in the name.
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
  'Vision inference not yet supported for this model.'

/** Whether image attachments can be sent for the selected model. */
export type ImageAttachmentSupport = 'supported' | 'non-vision-model' | 'inference-not-supported'

/** Resolve whether image attachments are allowed for `modelId`. */
export function imageAttachmentSupport(
  modelId: string,
  model: ModelVisionHints,
): ImageAttachmentSupport {
  if (isApiProviderModelId(modelId)) return 'supported'
  if (isMlxProviderModelId(modelId)) return 'inference-not-supported'
  if (!modelSupportsVision(model)) return 'non-vision-model'
  return 'inference-not-supported'
}

/** User-facing error for blocked image sends, or null when attachments are allowed. */
export function imageAttachmentSupportError(support: ImageAttachmentSupport): string | null {
  if (support === 'non-vision-model') return NON_VISION_MODEL_IMAGE_ERROR
  if (support === 'inference-not-supported') return VISION_INFERENCE_NOT_SUPPORTED_ERROR
  return null
}

/** Vision hints for a registry row, including synthetic API/MLX models. */
export function visionHintsForRegistryModel(
  modelId: string,
  model: ModelVisionHints | null,
): ModelVisionHints {
  if (isApiProviderModelId(modelId)) {
    return { arch: 'api', hfRepoId: null, displayName: 'API model', hfFile: null }
  }
  if (isMlxProviderModelId(modelId)) {
    return { arch: 'mlx', hfRepoId: null, displayName: 'MLX model', hfFile: null }
  }
  return model ?? { arch: null, hfRepoId: null, displayName: modelId, hfFile: null }
}

/** User-facing error when sending `imageCount` attachments, or null if allowed. */
export function imageAttachmentsBlockedMessage(
  modelId: string,
  model: ModelVisionHints | null,
  imageCount: number,
): string | null {
  if (imageCount === 0) return null
  return imageAttachmentSupportError(
    imageAttachmentSupport(modelId, visionHintsForRegistryModel(modelId, model)),
  )
}
