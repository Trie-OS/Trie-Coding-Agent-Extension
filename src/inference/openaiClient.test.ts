import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { OpenAiCompatibleClient, resolveChatCompletionsUrl } from './openaiClient.ts'
import { isOutputTruncatedFinishReason } from './truncation.ts'
import type { GenerationParams } from './types.ts'

test('OpenAI finish reasons identify output-limit truncation', () => {
  assert.equal(isOutputTruncatedFinishReason('length'), true)
  assert.equal(isOutputTruncatedFinishReason('max_tokens'), true)
  assert.equal(isOutputTruncatedFinishReason('stop'), false)
  assert.equal(isOutputTruncatedFinishReason('tool_calls'), false)
  assert.equal(isOutputTruncatedFinishReason(null), false)
})

test('OpenAI base URLs normalize without duplicating v1', () => {
  assert.equal(
    resolveChatCompletionsUrl('https://api.openai.com/v1'),
    'https://api.openai.com/v1/chat/completions',
  )
  assert.equal(
    resolveChatCompletionsUrl('http://127.0.0.1:11434'),
    'http://127.0.0.1:11434/v1/chat/completions',
  )
  assert.equal(
    resolveChatCompletionsUrl('https://proxy.test/v1/chat/completions'),
    'https://proxy.test/v1/chat/completions',
  )
})

function sse(events: unknown[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

const params: GenerationParams = {
  temperature: 0.1,
  topP: 0.9,
  maxTokens: 512,
  nativeTools: [
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a file.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
    },
  ],
}

describe('OpenAiCompatibleClient native tools', () => {
  test('sends required native tools and converts tool_calls to an envelope', async () => {
    const originalFetch = globalThis.fetch
    const bodies: Array<Record<string, unknown>> = []
    globalThis.fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return sse([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { name: 'read_file', arguments: '{"path":"src/a.ts"}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        },
      ])
    }
    try {
      const client = new OpenAiCompatibleClient('http://example.test', 'model', '')
      const result = await client.generate(
        [{ role: 'user', content: 'Read it' }],
        params,
        () => {},
        new AbortController().signal,
      )
      assert.equal(bodies.length, 1)
      assert.deepEqual(bodies[0]!.tools, params.nativeTools)
      assert.equal(bodies[0]!.tool_choice, 'required')
      assert.equal(bodies[0]!.parallel_tool_calls, false)
      assert.deepEqual(JSON.parse(result.text), {
        thought: 'Function call',
        tool: 'read_file',
        args: { path: 'src/a.ts' },
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('fails without fallback when an endpoint rejects native functions', async () => {
    const originalFetch = globalThis.fetch
    const bodies: Array<Record<string, unknown>> = []
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      bodies.push(body)
      return new Response('unknown field: tools', { status: 400 })
    }
    try {
      const client = new OpenAiCompatibleClient('http://example.test', 'model', '')
      await assert.rejects(
        client.generate(
          [{ role: 'user', content: 'Read it' }],
          params,
          () => {},
          new AbortController().signal,
        ),
        /chat completion failed \(400\): unknown field: tools/,
      )
      assert.equal(bodies.length, 1)
      assert.ok(Array.isArray(bodies[0]!.tools))
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
