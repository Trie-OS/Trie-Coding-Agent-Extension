import { describe, expect, it } from 'vitest'
import {
  isAcceptedImageFile,
  imageAttachmentSupport,
  modelSupportsVision,
  NON_VISION_MODEL_IMAGE_ERROR,
} from './modelVision'

describe('modelSupportsVision', () => {
  it('returns false for Gemma text-only models', () => {
    expect(
      modelSupportsVision({
        arch: 'gemma',
        hfRepoId: 'google/gemma-2b-it-GGUF',
        displayName: 'Gemma 2B Instruct',
        hfFile: 'gemma-2b-it-q4_k_m.gguf',
      }),
    ).toBe(false)
    expect(
      modelSupportsVision({
        arch: 'gemma2',
        hfRepoId: 'bartowski/gemma-2-9b-it-GGUF',
        displayName: 'Gemma 2 9B',
        hfFile: 'gemma-2-9b-it-q4_k_m.gguf',
      }),
    ).toBe(false)
  })

  it('returns false for Qwen2 coder models without VL hints', () => {
    expect(
      modelSupportsVision({
        arch: 'qwen2',
        hfRepoId: 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF',
        displayName: 'Qwen2.5 Coder 7B',
        hfFile: 'Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf',
      }),
    ).toBe(false)
  })

  it('returns true for explicit VL / LLaVA naming', () => {
    expect(
      modelSupportsVision({
        arch: 'qwen2',
        hfRepoId: 'Qwen/Qwen2-VL-7B-Instruct-GGUF',
        displayName: 'Qwen2-VL 7B',
        hfFile: 'Qwen2-VL-7B-Instruct-Q4_K_M.gguf',
      }),
    ).toBe(true)
    expect(
      modelSupportsVision({
        arch: 'llava',
        hfRepoId: 'bartowski/llava-v1.6-mistral-7b-GGUF',
        displayName: 'LLaVA v1.6 Mistral 7B',
        hfFile: 'llava-v1.6-mistral-7b-q4_k_m.gguf',
      }),
    ).toBe(true)
  })

  it('returns true for known vision architectures', () => {
    expect(
      modelSupportsVision({
        arch: 'qwen2vl',
        hfRepoId: null,
        displayName: 'Local Qwen2-VL',
        hfFile: 'model.gguf',
      }),
    ).toBe(true)
  })
})

describe('isAcceptedImageFile', () => {
  it('accepts common image mime types and extensions', () => {
    expect(isAcceptedImageFile({ type: 'image/png', name: 'shot.png' })).toBe(true)
    expect(isAcceptedImageFile({ type: 'image/jpeg', name: 'photo.jpg' })).toBe(true)
    expect(isAcceptedImageFile({ type: '', name: 'diagram.webp' })).toBe(true)
    expect(isAcceptedImageFile({ type: 'application/pdf', name: 'doc.pdf' })).toBe(false)
  })
})

describe('error copy', () => {
  it('includes guidance for non-vision models', () => {
    expect(NON_VISION_MODEL_IMAGE_ERROR).toMatch(/vision-capable/i)
  })
})

describe('imageAttachmentSupport', () => {
  it('allows API provider models', () => {
    expect(
      imageAttachmentSupport('api:external', {
        arch: 'api',
        hfRepoId: null,
        displayName: 'API',
        hfFile: null,
      }),
    ).toBe('supported')
  })

  it('blocks local text-only models', () => {
    expect(
      imageAttachmentSupport('local-model', {
        arch: 'gemma',
        hfRepoId: null,
        displayName: 'Gemma',
        hfFile: 'gemma.gguf',
      }),
    ).toBe('non-vision-model')
  })

  it('blocks local vision GGUF until inference is wired', () => {
    expect(
      imageAttachmentSupport('local-vl', {
        arch: 'llava',
        hfRepoId: null,
        displayName: 'LLaVA',
        hfFile: 'llava.gguf',
      }),
    ).toBe('inference-not-supported')
  })
})
