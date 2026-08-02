import assert from 'node:assert/strict'
import test from 'node:test'
import {
  extensionImageAttachmentSupport,
  imageAttachmentsBlockedMessage,
  isAcceptedImageFile,
  modelSupportsVision,
  NON_VISION_MODEL_IMAGE_ERROR,
} from './modelVision.ts'

test('modelSupportsVision detects VL naming', () => {
  assert.equal(
    modelSupportsVision({
      arch: 'qwen2',
      hfRepoId: 'Qwen/Qwen2-VL-7B-Instruct-GGUF',
      displayName: 'Qwen2-VL 7B',
      hfFile: 'Qwen2-VL-7B-Instruct-Q4_K_M.gguf',
    }),
    true,
  )
  assert.equal(
    modelSupportsVision({
      arch: 'gemma2',
      hfRepoId: null,
      displayName: 'Gemma 2 9B',
      hfFile: 'gemma.gguf',
    }),
    false,
  )
})

test('isAcceptedImageFile accepts common image types', () => {
  assert.equal(isAcceptedImageFile({ type: 'image/png', name: 'shot.png' }), true)
  assert.equal(isAcceptedImageFile({ type: '', name: 'photo.jpg' }), true)
  assert.equal(isAcceptedImageFile({ type: 'application/pdf', name: 'doc.pdf' }), false)
})

test('extensionImageAttachmentSupport allows API backend', () => {
  assert.equal(extensionImageAttachmentSupport('openai-compatible', null), 'supported')
  assert.equal(imageAttachmentsBlockedMessage('openai-compatible', null, 1), null)
})

test('extensionImageAttachmentSupport blocks non-vision daemon models', () => {
  assert.equal(extensionImageAttachmentSupport('daemon', 'Gemma 2 9B'), 'non-vision-model')
  assert.equal(
    imageAttachmentsBlockedMessage('daemon', 'Gemma 2 9B', 1),
    NON_VISION_MODEL_IMAGE_ERROR,
  )
})

test('extensionImageAttachmentSupport blocks local vision until inference is wired', () => {
  assert.equal(extensionImageAttachmentSupport('daemon', 'LLaVA v1.6 Mistral 7B'), 'inference-not-supported')
})
