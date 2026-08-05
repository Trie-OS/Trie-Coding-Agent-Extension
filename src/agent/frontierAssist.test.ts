import assert from 'node:assert/strict'
import test from 'node:test'
import { buildFrontierChatPayload, frontierHttpErrorDetail } from './frontierAssist.ts'

test('GPT-5 frontier payload uses current OpenAI token field and default temperature', () => {
  const payload = buildFrontierChatPayload(
    'openai',
    'gpt-5.4-2026-03-05',
    'system',
    'user',
    { maxTokens: 2048, temperature: 0.2 },
  )
  assert.equal(payload.max_completion_tokens, 2048)
  assert.equal(payload.max_tokens, undefined)
  assert.equal(payload.temperature, undefined)
})

test('non-reasoning OpenAI models retain configured temperature', () => {
  const payload = buildFrontierChatPayload('openai', 'gpt-4.1', 'system', 'user', {
    maxTokens: 400,
    temperature: 0.2,
  })
  assert.equal(payload.max_completion_tokens, 400)
  assert.equal(payload.temperature, 0.2)
})

test('Moonshot payload keeps its OpenAI-compatible legacy fields', () => {
  const payload = buildFrontierChatPayload('moonshot', 'kimi-k2', 'system', 'user', {
    maxTokens: 400,
    temperature: 0.2,
  })
  assert.equal(payload.max_tokens, 400)
  assert.equal(payload.max_completion_tokens, undefined)
  assert.equal(payload.temperature, 0.2)
})

test('frontier HTTP errors expose a bounded API message', () => {
  assert.equal(
    frontierHttpErrorDetail(
      JSON.stringify({ error: { message: "Unsupported parameter: 'max_tokens'." } }),
    ),
    "Unsupported parameter: 'max_tokens'.",
  )
  assert.equal(frontierHttpErrorDetail('bad\nrequest'), 'bad request')
})
