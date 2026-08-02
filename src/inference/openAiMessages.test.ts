import assert from 'node:assert/strict'
import test from 'node:test'
import { buildOpenAiMessages } from './openAiMessages.ts'
import type { ChatTurn } from './types.ts'

test('buildOpenAiMessages maps user turns with images to multimodal content', () => {
  const turns: ChatTurn[] = [
    {
      role: 'user',
      content: 'What is this?',
      images: [{ mimeType: 'image/png', dataBase64: 'abc123' }],
    },
  ]
  const messages = buildOpenAiMessages(turns)
  assert.deepEqual(messages, [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'What is this?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,abc123' } },
      ],
    },
  ])
})

test('buildOpenAiMessages keeps plain string content for text-only turns', () => {
  const turns: ChatTurn[] = [{ role: 'assistant', content: 'Done.' }]
  assert.deepEqual(buildOpenAiMessages(turns), [{ role: 'assistant', content: 'Done.' }])
})
