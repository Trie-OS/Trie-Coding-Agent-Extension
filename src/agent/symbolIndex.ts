/**
 * Workspace symbol index on a prefix trie — the data structure the product is
 * named after, doing real work in the agent loop.
 *
 * Ported from Trie IDE (app/src/main/services/symbolTrie.ts + symbolIndex.ts):
 * a lexical declaration scanner feeds symbol names into a character trie;
 * `search_symbols` walks the trie for prefix hits (falling back to a substring
 * scan), and `grep` consults it first for plain-identifier queries so "where
 * is X declared" is answered from the index instead of a full file walk.
 *
 * Built lazily on the first query, updated incrementally on file save,
 * never on activation — an idle extension costs nothing.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'

export interface SymbolHit {
  path: string
  line: number
  kind: string
  name: string
}

interface OutlineSymbol {
  line: number
  kind: string
  name: string
}

/* ── Lexical declaration scanner (Trie IDE outline.ts) ──────────────────── */

const TS_PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: 'class', re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'interface', re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'type', re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'enum', re: /^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/ },
  {
    kind: 'function',
    re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
  },
  { kind: 'const', re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/ },
]

const LANGUAGE_PATTERNS: Record<string, { kind: string; re: RegExp }[]> = {
  ts: TS_PATTERNS,
  tsx: TS_PATTERNS,
  js: TS_PATTERNS,
  jsx: TS_PATTERNS,
  mjs: TS_PATTERNS,
  cjs: TS_PATTERNS,
  py: [
    { kind: 'class', re: /^\s*class\s+([A-Za-z_][\w]*)/ },
    { kind: 'function', re: /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)/ },
  ],
  go: [
    { kind: 'func', re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/ },
    { kind: 'type', re: /^\s*type\s+([A-Za-z_][\w]*)/ },
  ],
  rs: [
    { kind: 'fn', re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/ },
    { kind: 'struct', re: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_][\w]*)/ },
    { kind: 'enum', re: /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_][\w]*)/ },
    { kind: 'trait', re: /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_][\w]*)/ },
  ],
  swift: [
    {
      kind: 'class',
      re: /^\s*(?:public\s+|private\s+|internal\s+|open\s+|final\s+)*class\s+([A-Za-z_][\w]*)/,
    },
    { kind: 'struct', re: /^\s*(?:public\s+|private\s+|internal\s+)*struct\s+([A-Za-z_][\w]*)/ },
    { kind: 'enum', re: /^\s*(?:public\s+|private\s+|internal\s+)*enum\s+([A-Za-z_][\w]*)/ },
    { kind: 'protocol', re: /^\s*(?:public\s+|private\s+|internal\s+)*protocol\s+([A-Za-z_][\w]*)/ },
    {
      kind: 'func',
      re: /^\s*(?:public\s+|private\s+|internal\s+|static\s+|class\s+|override\s+)*func\s+([A-Za-z_][\w]*)/,
    },
  ],
}

export const INDEXABLE_EXTENSIONS = Object.keys(LANGUAGE_PATTERNS)

function scanSymbols(relPath: string, content: string): OutlineSymbol[] {
  const ext = relPath.split('.').pop()?.toLowerCase() ?? ''
  const patterns = LANGUAGE_PATTERNS[ext]
  if (!patterns) return []
  const symbols: OutlineSymbol[] = []
  content.split('\n').forEach((line, index) => {
    const trimmed = line.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) return
    for (const { kind, re } of patterns) {
      const match = re.exec(line)
      if (match?.[1]) {
        symbols.push({ line: index + 1, kind, name: match[1] })
        return
      }
    }
  })
  return symbols
}

/* ── Prefix trie (Trie IDE symbolTrie.ts) ───────────────────────────────── */

interface TrieNode {
  children: Map<string, TrieNode>
  hits: SymbolHit[]
}

export class SymbolTrie {
  private root: TrieNode = { children: new Map(), hits: [] }
  private allHits: SymbolHit[] = []

  get size(): number {
    return this.allHits.length
  }

  clear(): void {
    this.root = { children: new Map(), hits: [] }
    this.allHits = []
  }

  insert(hit: SymbolHit): void {
    this.allHits.push(hit)
    this.insertIntoTrie(hit)
  }

  private insertIntoTrie(hit: SymbolHit): void {
    let node = this.root
    for (const ch of hit.name.toLowerCase()) {
      let child = node.children.get(ch)
      if (!child) {
        child = { children: new Map(), hits: [] }
        node.children.set(ch, child)
      }
      node = child
    }
    node.hits.push(hit)
  }

  /** Prefix match: walk to the query node, then collect terminal hits below it. */
  searchPrefix(query: string, limit: number): SymbolHit[] {
    const q = query.trim().toLowerCase()
    if (q === '') return []
    let node = this.root
    for (const ch of q) {
      const child = node.children.get(ch)
      if (!child) return []
      node = child
    }
    const out: SymbolHit[] = []
    const walk = (n: TrieNode): void => {
      if (out.length >= limit) return
      for (const hit of n.hits) {
        out.push(hit)
        if (out.length >= limit) return
      }
      for (const child of n.children.values()) {
        walk(child)
        if (out.length >= limit) return
      }
    }
    walk(node)
    return out.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
  }

  /** Substring fallback when the query is not a prefix of any indexed name. */
  searchContains(query: string, limit: number): SymbolHit[] {
    const q = query.trim().toLowerCase()
    if (q === '') return []
    const hits: SymbolHit[] = []
    for (const hit of this.allHits) {
      if (!hit.name.toLowerCase().includes(q)) continue
      hits.push(hit)
      if (hits.length >= limit) break
    }
    return hits.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
  }

  search(query: string, limit: number): SymbolHit[] {
    const prefix = this.searchPrefix(query, limit)
    if (prefix.length > 0) return prefix
    return this.searchContains(query, limit)
  }

  /**
   * Bounded edit-distance walk over the trie (Levenshtein DP, one row per
   * node, pruning any branch whose whole subtree is already over budget).
   * Returns names within `maxDist` typos of the query — no embeddings needed.
   */
  searchFuzzy(query: string, maxDist: number, limit: number): { hit: SymbolHit; dist: number }[] {
    const q = query.trim().toLowerCase()
    if (q === '') return []
    const out: { hit: SymbolHit; dist: number }[] = []
    const firstRow = Array.from({ length: q.length + 1 }, (_, i) => i)
    const walk = (node: TrieNode, prevRow: number[]): void => {
      if (out.length >= limit) return
      for (const [ch, child] of node.children) {
        const row = new Array<number>(q.length + 1)
        row[0] = prevRow[0] + 1
        let rowMin = row[0]
        for (let i = 1; i <= q.length; i++) {
          row[i] = Math.min(
            prevRow[i] + 1, // deletion
            row[i - 1] + 1, // insertion
            prevRow[i - 1] + (q[i - 1] === ch ? 0 : 1), // substitution
          )
          if (row[i] < rowMin) rowMin = row[i]
        }
        if (row[q.length] <= maxDist) {
          for (const hit of child.hits) {
            out.push({ hit, dist: row[q.length] })
            if (out.length >= limit) return
          }
        }
        if (rowMin <= maxDist) walk(child, row)
      }
    }
    walk(this.root, firstRow)
    return out
  }

  /**
   * Scored search for the "search score threshold" setting. Purely lexical —
   * every score is explainable: 1.0 exact, ~0.75–0.95 prefix, ~0.6 word
   * initials, ~0.5–0.65 substring, ~0.35–0.5 typo-tolerant (edit distance).
   */
  scoredSearch(query: string, limit: number, threshold: number): SymbolHit[] {
    const q = query.trim().toLowerCase()
    if (q === '') return []
    const best = new Map<SymbolHit, number>()
    const consider = (hit: SymbolHit, score: number): void => {
      if (score > (best.get(hit) ?? 0)) best.set(hit, score)
    }

    for (const hit of this.searchPrefix(q, limit * 4)) {
      const name = hit.name.toLowerCase()
      consider(hit, name === q ? 1 : 0.75 + 0.2 * (q.length / name.length))
    }
    for (const hit of this.allHits) {
      const name = hit.name.toLowerCase()
      if (name.includes(q) && !name.startsWith(q)) {
        consider(hit, 0.5 + 0.15 * (q.length / name.length))
      }
      if (wordInitials(hit.name).startsWith(q)) consider(hit, 0.65)
    }
    // Multi-word concept-ish queries ("auth token" → validateAuthToken):
    // score by how many query words match a subword of the symbol name.
    const qWords = q.split(/\s+/).filter(Boolean)
    if (qWords.length > 1) {
      for (const hit of this.allHits) {
        const parts = subwords(hit.name)
        const matched = qWords.filter((w) => parts.some((p) => p.startsWith(w))).length
        if (matched > 0) consider(hit, 0.3 + 0.4 * (matched / qWords.length))
      }
    }
    if (q.length >= 3 && threshold <= 0.5) {
      for (const { hit, dist } of this.searchFuzzy(q, q.length >= 6 ? 2 : 1, limit * 4)) {
        consider(hit, dist === 0 ? 1 : dist === 1 ? 0.5 : 0.35)
      }
    }

    return [...best.entries()]
      .filter(([, score]) => score >= threshold)
      .sort((a, b) => b[1] - a[1] || a[0].name.localeCompare(b[0].name))
      .slice(0, limit)
      .map(([hit]) => hit)
  }

  removePath(relPath: string): void {
    this.allHits = this.allHits.filter((hit) => hit.path !== relPath)
    this.root = { children: new Map(), hits: [] }
    for (const hit of this.allHits) this.insertIntoTrie(hit)
  }
}

/** `validateAuthToken` → ["validate", "auth", "token"]. */
function subwords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_$-]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase())
}

/** `WorkspaceSymbolIndex` → "wsi", `parse_tool_call` → "ptc". */
function wordInitials(name: string): string {
  const words = subwords(name)
  if (words.length < 2) return ''
  return words.map((w) => w[0]).join('')
}

/* ── Workspace index (lazy build, save-time incremental update) ─────────── */

const MAX_INDEXED_FILES = 5_000
const MAX_INDEXED_FILE_BYTES = 512 * 1024
const INDEX_EXCLUDE = '**/{node_modules,.git,dist,out,build,.next,coverage}/**'

export interface IndexStatus {
  state: 'standby' | 'indexing' | 'ready'
  files: number
  symbols: number
  /** Wall-clock ms the last full build took, once ready. */
  buildMs: number
  /** Set once file discovery finishes during an active build. */
  totalFiles: number | null
}

type IndexStatusListener = (root: string, status: IndexStatus) => void
const statusListeners = new Set<IndexStatusListener>()

/** Fires whenever any workspace index changes state or makes build progress. */
export function onIndexStatusChange(listener: IndexStatusListener): vscode.Disposable {
  statusListeners.add(listener)
  return { dispose: () => statusListeners.delete(listener) }
}

function emitIndexStatus(root: string, index: WorkspaceSymbolIndex): void {
  const status = index.status()
  for (const listener of statusListeners) listener(root, status)
}

export class WorkspaceSymbolIndex {
  private readonly trie = new SymbolTrie()
  private built: Promise<void> | null = null
  private saveListener: vscode.Disposable | null = null
  private state: IndexStatus['state'] = 'standby'
  private fileCount = 0
  private totalFiles: number | null = null
  private buildMs = 0

  constructor(private readonly root: string) {}

  private notifyStatus(): void {
    emitIndexStatus(this.root, this)
  }

  /**
   * With `threshold` set, results are scored lexically (exact > prefix >
   * initials > substring > typo) and filtered; without it, plain prefix /
   * substring lookup (the grep fast path).
   */
  async search(query: string, limit = 30, threshold?: number): Promise<SymbolHit[]> {
    await this.ensureBuilt()
    return threshold === undefined
      ? this.trie.search(query, limit)
      : this.trie.scoredSearch(query, limit, threshold)
  }

  status(): IndexStatus {
    return {
      state: this.state,
      files: this.fileCount,
      symbols: this.trie.size,
      buildMs: this.buildMs,
      totalFiles: this.totalFiles,
    }
  }

  /** Kick off the build without waiting for a query (index-on-startup). */
  warmUp(): Promise<void> {
    return this.ensureBuilt()
  }

  /** Drop everything and re-scan the workspace from scratch. */
  async rebuild(): Promise<void> {
    this.trie.clear()
    this.fileCount = 0
    this.totalFiles = null
    this.buildMs = 0
    this.state = 'standby'
    this.built = this.build()
    await this.built
  }

  dispose(): void {
    this.saveListener?.dispose()
    this.saveListener = null
  }

  private ensureBuilt(): Promise<void> {
    this.built ??= this.build()
    return this.built
  }

  private async build(): Promise<void> {
    this.state = 'indexing'
    this.fileCount = 0
    this.totalFiles = null
    this.notifyStatus()
    const start = Date.now()
    const pattern = `**/*.{${INDEXABLE_EXTENSIONS.join(',')}}`
    const uris = await vscode.workspace.findFiles(pattern, INDEX_EXCLUDE, MAX_INDEXED_FILES)
    this.totalFiles = uris.length
    this.notifyStatus()
    for (const uri of uris) {
      await this.indexFile(uri.fsPath)
      this.fileCount++
      if (this.fileCount % 5 === 0 || this.fileCount === this.totalFiles) {
        this.notifyStatus()
      }
    }
    this.buildMs = Date.now() - start
    this.state = 'ready'
    this.notifyStatus()
    this.saveListener ??= vscode.workspace.onDidSaveTextDocument((doc) => {
      const rel = path.relative(this.root, doc.uri.fsPath)
      if (rel.startsWith('..')) return
      this.trie.removePath(rel)
      void this.indexFile(doc.uri.fsPath)
    })
  }

  private async indexFile(absolute: string): Promise<void> {
    const rel = path.relative(this.root, absolute)
    try {
      const stat = await fs.promises.stat(absolute)
      if (stat.size > MAX_INDEXED_FILE_BYTES) return
      const content = await fs.promises.readFile(absolute, 'utf8')
      for (const sym of scanSymbols(rel, content)) {
        this.trie.insert({ path: rel, line: sym.line, kind: sym.kind, name: sym.name })
      }
    } catch {
      // Unreadable file: skip. The index reports what it can see, only that.
    }
  }
}

const indexes = new Map<string, WorkspaceSymbolIndex>()

/** One lazily built index per workspace root, shared across agent turns. */
export function getSymbolIndex(root: string): WorkspaceSymbolIndex {
  let index = indexes.get(root)
  if (!index) {
    index = new WorkspaceSymbolIndex(root)
    indexes.set(root, index)
  }
  return index
}

/** True for queries like `useTheme` / `parse_tool_call` — the trie fast path. */
export function isIdentifierPattern(pattern: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(pattern.trim())
}
