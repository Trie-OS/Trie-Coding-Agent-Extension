/**
 * In-memory message bus for parallel Multitask siblings: findings, Q&A, and
 * exclusive path claims so concurrent worktrees don't all edit the same files.
 */

export type MultitaskBusMessageType =
  | 'finding'
  | 'path_claim'
  | 'path_release'
  | 'status'
  | 'question'
  | 'answer'

export interface MultitaskBusMessage {
  id: number
  type: MultitaskBusMessageType
  fromId: string
  fromName: string
  text: string
  paths?: string[]
  at: number
}

export interface PathClaim {
  path: string
  ownerId: string
  ownerName: string
  at: number
}

export interface ClaimResult {
  ok: boolean
  claimed: string[]
  denied: { path: string; ownerId: string; ownerName: string }[]
}

function normalizeRelPath(raw: string): string {
  return raw.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+/g, '/').replace(/\/$/, '')
}

export class MultitaskBus {
  private nextId = 1
  private readonly messages: MultitaskBusMessage[] = []
  private readonly claims = new Map<string, PathClaim>()

  post(
    type: MultitaskBusMessageType,
    fromId: string,
    fromName: string,
    text: string,
    paths?: string[],
  ): MultitaskBusMessage {
    const message: MultitaskBusMessage = {
      id: this.nextId++,
      type,
      fromId,
      fromName,
      text: text.trim().slice(0, 2000),
      paths: paths?.map(normalizeRelPath),
      at: Date.now(),
    }
    this.messages.push(message)
    return message
  }

  readSince(cursor: number, excludeId?: string): { messages: MultitaskBusMessage[]; nextCursor: number } {
    const messages = this.messages.filter(
      (message) => message.id > cursor && (!excludeId || message.fromId !== excludeId),
    )
    const nextCursor = this.messages.length ? this.messages[this.messages.length - 1]!.id : cursor
    return { messages, nextCursor }
  }

  digest(limit = 12): string {
    const recent = this.messages.slice(-limit)
    if (recent.length === 0) return 'No sibling messages yet.'
    return recent
      .map((message) => {
        const pathNote = message.paths?.length ? ` [${message.paths.join(', ')}]` : ''
        return `#${message.id} ${message.fromName} (${message.type})${pathNote}: ${message.text}`
      })
      .join('\n')
  }

  claimPaths(ownerId: string, ownerName: string, paths: string[]): ClaimResult {
    const claimed: string[] = []
    const denied: ClaimResult['denied'] = []
    for (const raw of paths) {
      const path = normalizeRelPath(raw)
      if (!path) continue
      const existing = this.claims.get(path)
      if (existing && existing.ownerId !== ownerId) {
        denied.push({ path, ownerId: existing.ownerId, ownerName: existing.ownerName })
        continue
      }
      this.claims.set(path, { path, ownerId, ownerName, at: Date.now() })
      claimed.push(path)
    }
    if (claimed.length) {
      this.post('path_claim', ownerId, ownerName, `Claimed ${claimed.join(', ')}`, claimed)
    }
    return { ok: denied.length === 0, claimed, denied }
  }

  releasePaths(ownerId: string, ownerName: string, paths: string[]): string[] {
    const released: string[] = []
    for (const raw of paths) {
      const path = normalizeRelPath(raw)
      const existing = this.claims.get(path)
      if (!existing || existing.ownerId !== ownerId) continue
      this.claims.delete(path)
      released.push(path)
    }
    if (released.length) {
      this.post('path_release', ownerId, ownerName, `Released ${released.join(', ')}`, released)
    }
    return released
  }

  /** Returns the foreign owner if `path` is claimed by someone else. */
  ownerOf(path: string, selfId: string): PathClaim | null {
    const claim = this.claims.get(normalizeRelPath(path))
    if (!claim || claim.ownerId === selfId) return null
    return claim
  }

  listClaims(): PathClaim[] {
    return [...this.claims.values()]
  }
}

export const MULTITASK_TOOL_SPECS = [
  {
    name: 'post_finding',
    signature: '{"text": string, "paths"?: string[]}',
    description:
      'Publish a concise finding to sibling Multitask agents (and the final coordinator). Prefer concrete paths/symbols.',
  },
  {
    name: 'read_sibling_updates',
    signature: '{"sinceId"?: number}',
    description:
      'Read new sibling messages since `sinceId` (omit or 0 for recent digest). Call periodically while working in parallel.',
  },
  {
    name: 'claim_paths',
    signature: '{"paths": string[]}',
    description:
      'Claim exclusive edit ownership for relative paths. First claim wins. Mutating tools refuse paths owned by siblings.',
  },
  {
    name: 'release_paths',
    signature: '{"paths": string[]}',
    description: 'Release path claims you previously took.',
  },
] as const

export type MultitaskToolName = (typeof MULTITASK_TOOL_SPECS)[number]['name']

export const MULTITASK_TOOL_NAMES = new Set<string>(MULTITASK_TOOL_SPECS.map((tool) => tool.name))

export interface MultitaskToolContext {
  agentId: string
  agentName: string
  bus: MultitaskBus
  /** Cursor for read_sibling_updates; mutated by the tool handler. */
  cursor: { value: number }
  onActivity?: (summary: string) => void
}

export function executeMultitaskTool(
  tool: string,
  args: Record<string, unknown>,
  ctx: MultitaskToolContext,
): { ok: boolean; result: string; uiSummary: string } {
  const { bus, agentId, agentName } = ctx
  switch (tool) {
    case 'post_finding': {
      const text = typeof args['text'] === 'string' ? args['text'] : ''
      if (!text.trim()) return { ok: false, result: 'Error: `text` is required', uiSummary: 'empty finding' }
      const paths = Array.isArray(args['paths'])
        ? args['paths'].filter((p): p is string => typeof p === 'string')
        : undefined
      const message = bus.post('finding', agentId, agentName, text, paths)
      ctx.onActivity?.(`Posted finding #${message.id}`)
      return { ok: true, result: `Posted finding #${message.id} to siblings.`, uiSummary: `finding #${message.id}` }
    }
    case 'read_sibling_updates': {
      const since =
        typeof args['sinceId'] === 'number' && Number.isFinite(args['sinceId'])
          ? Math.max(0, Math.floor(args['sinceId']))
          : ctx.cursor.value
      const { messages, nextCursor } = bus.readSince(since, agentId)
      ctx.cursor.value = nextCursor
      if (messages.length === 0) {
        return {
          ok: true,
          result: `No new sibling messages since #${since}.\n\nCurrent claims:\n${
            bus.listClaims().map((c) => `${c.path} → ${c.ownerName}`).join('\n') || '(none)'
          }`,
          uiSummary: 'no sibling updates',
        }
      }
      const body = messages
        .map((m) => {
          const pathNote = m.paths?.length ? ` paths=${m.paths.join(',')}` : ''
          return `#${m.id} [${m.type}] ${m.fromName}${pathNote}: ${m.text}`
        })
        .join('\n\n')
      ctx.onActivity?.(`Read ${messages.length} sibling update(s)`)
      return {
        ok: true,
        result: `${body}\n\nnext sinceId=${nextCursor}`,
        uiSummary: `${messages.length} sibling update(s)`,
      }
    }
    case 'claim_paths': {
      const paths = Array.isArray(args['paths'])
        ? args['paths'].filter((p): p is string => typeof p === 'string')
        : []
      if (paths.length === 0) {
        return { ok: false, result: 'Error: `paths` must be a non-empty string array', uiSummary: 'claim failed' }
      }
      const result = bus.claimPaths(agentId, agentName, paths)
      if (result.claimed.length) ctx.onActivity?.(`Claimed ${result.claimed.join(', ')}`)
      const denied = result.denied
        .map((d) => `${d.path} owned by ${d.ownerName}`)
        .join('; ')
      return {
        ok: result.ok,
        result: [
          result.claimed.length ? `Claimed: ${result.claimed.join(', ')}` : 'Claimed: (none)',
          denied ? `Denied: ${denied}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
        uiSummary: result.ok ? `claimed ${result.claimed.length}` : 'claim conflict',
      }
    }
    case 'release_paths': {
      const paths = Array.isArray(args['paths'])
        ? args['paths'].filter((p): p is string => typeof p === 'string')
        : []
      if (paths.length === 0) {
        return { ok: false, result: 'Error: `paths` must be a non-empty string array', uiSummary: 'release failed' }
      }
      const released = bus.releasePaths(agentId, agentName, paths)
      if (released.length) ctx.onActivity?.(`Released ${released.join(', ')}`)
      return {
        ok: true,
        result: released.length ? `Released: ${released.join(', ')}` : 'Nothing to release.',
        uiSummary: `released ${released.length}`,
      }
    }
    default:
      return { ok: false, result: `Error: unknown multitask tool ${tool}`, uiSummary: 'unknown tool' }
  }
}
