/**
 * Workspace context for the agent's first prompt — a slim port of the IDE's
 * context engine (repo detection + file-tree scoping). Detects the project
 * type from marker files and builds a compact two-level tree so the model
 * starts oriented instead of discovering everything through grep/glob.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

interface ProjectMarker {
  /** File name or extension glob at the workspace root. */
  match: (name: string) => boolean
  label: string
  /** Suggested verification command, mentioned in the prompt. */
  verify?: string
}

const MARKERS: ProjectMarker[] = [
  {
    match: (n) => n.endsWith('.xcworkspace'),
    label: 'Xcode workspace (Swift/iOS/macOS)',
    verify: 'xcodebuild -list; then xcodebuild -scheme <scheme> build',
  },
  {
    match: (n) => n.endsWith('.xcodeproj'),
    label: 'Xcode project (Swift/iOS/macOS)',
    verify: 'xcodebuild -list; then xcodebuild -scheme <scheme> build',
  },
  { match: (n) => n === 'Package.swift', label: 'Swift package', verify: 'swift build && swift test' },
  { match: (n) => n === 'package.json', label: 'Node.js project', verify: 'npm test / npm run build' },
  { match: (n) => n === 'Cargo.toml', label: 'Rust crate', verify: 'cargo check && cargo test' },
  { match: (n) => n === 'go.mod', label: 'Go module', verify: 'go build ./... && go test ./...' },
  { match: (n) => n === 'pyproject.toml' || n === 'requirements.txt', label: 'Python project', verify: 'pytest' },
  { match: (n) => n === 'pom.xml', label: 'Maven project', verify: 'mvn -q test' },
  { match: (n) => n === 'build.gradle' || n === 'build.gradle.kts', label: 'Gradle project', verify: 'gradle test' },
  { match: (n) => n === 'Gemfile', label: 'Ruby project', verify: 'bundle exec rake test' },
]

const SKIP_DIRS = new Set([
  '.git',
  '.trie-ide',
  'node_modules',
  'dist',
  'out',
  'build',
  '.next',
  'coverage',
  'DerivedData',
  'Pods',
  '.build',
  'target',
  '__pycache__',
  '.venv',
  'venv',
])

const MAX_TREE_ENTRIES = 90
const MAX_CHILDREN_PER_DIR = 14

function listEntries(dir: string): fs.Dirent[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.') || e.name === '.github')
      .filter((e) => !SKIP_DIRS.has(e.name))
      .sort(
        (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
      )
  } catch {
    return []
  }
}

/** Detected project descriptions for the workspace root (may be several). */
export function detectProjects(root: string): { label: string; verify?: string }[] {
  const names = listEntries(root).map((e) => e.name)
  const found: { label: string; verify?: string }[] = []
  for (const marker of MARKERS) {
    if (names.some((n) => marker.match(n))) {
      found.push({ label: marker.label, verify: marker.verify })
    }
  }
  return found
}

/** Compact two-level tree, capped so it fits comfortably in a small model's context. */
export function fileTreeSummary(root: string): string {
  const lines: string[] = []
  const top = listEntries(root)
  let total = 0

  for (const entry of top) {
    if (total >= MAX_TREE_ENTRIES) {
      lines.push('… (more entries omitted)')
      break
    }
    if (entry.isDirectory()) {
      lines.push(`${entry.name}/`)
      total++
      const children = listEntries(path.join(root, entry.name))
      const shown = children.slice(0, MAX_CHILDREN_PER_DIR)
      for (const child of shown) {
        if (total >= MAX_TREE_ENTRIES) break
        lines.push(`  ${child.name}${child.isDirectory() ? '/' : ''}`)
        total++
      }
      if (children.length > shown.length) {
        lines.push(`  … (${children.length - shown.length} more)`)
      }
    } else {
      lines.push(entry.name)
      total++
    }
  }
  return lines.join('\n') || '(empty workspace)'
}

/** The workspace block injected into the first user turn. */
export function buildWorkspaceContext(root: string, workspaceName: string): string {
  const projects = detectProjects(root)
  const parts: string[] = [`Workspace: ${workspaceName}`]

  if (projects.length > 0) {
    parts.push(`Project type: ${projects.map((p) => p.label).join('; ')}`)
    const verifies = projects.filter((p) => p.verify).map((p) => p.verify as string)
    if (verifies.length > 0) {
      parts.push(`To verify changes, prefer: ${verifies.join(' | ')}`)
    }
  }

  parts.push('File tree (partial):', fileTreeSummary(root))
  return parts.join('\n')
}
