import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeReplyMarkdownStructure } from './replyMarkdown.ts'

test('normalizeReplyMarkdownStructure splits comma-separated numbered lists', () => {
  const input =
    '1. **loop.ts:** Add logging, 2. **tools.ts:** Expose options, 3. **prompts.ts:** Handlers'
  const out = normalizeReplyMarkdownStructure(input)
  assert.match(out, /^1\. \*\*loop\.ts:\*\*/m)
  assert.match(out, /\n2\. \*\*tools\.ts:\*\*/)
  assert.match(out, /\n3\. \*\*prompts\.ts:\*\*/)
})
