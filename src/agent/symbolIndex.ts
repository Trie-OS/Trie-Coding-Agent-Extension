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

  removePath(relPath: string): void {
    this.allHits = this.allHits.filter((hit) => hit.path !== relPath)
    this.root = { children: new Map(), hits: [] }
    for (const hit of this.allHits) this.insertIntoTrie(hit)
  }
}

/* ── Workspace index (lazy build, save-time incremental update) ─────────── */

const MAX_INDEXED_FILES = 5_000
const MAX_INDEXED_FILE_BYTES = 512 * 1024
const INDEX_EXCLUDE = '**/{node_modules,.git,dist,out,build,.next,coverage}/**'

export class WorkspaceSymbolIndex {
  private readonly trie = new SymbolTrie()
  private built: Promise<void> | null = null
  private saveListener: vscode.Disposable | null = null

  constructor(private readonly root: string) {}

  async search(query: string, limit = 30): Promise<SymbolHit[]> {
    await this.ensureBuilt()
    return this.trie.search(query, limit)
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
    const pattern = `**/*.{${INDEXABLE_EXTENSIONS.join(',')}}`
    const uris = await vscode.workspace.findFiles(pattern, INDEX_EXCLUDE, MAX_INDEXED_FILES)
    for (const uri of uris) {
      await this.indexFile(uri.fsPath)
    }
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
