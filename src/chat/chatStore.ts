/**
 * Chat history persistence — per-chat JSON files under global storage plus an index.
 * Each chat keeps a display transcript (for replay in the webview) and the
 * raw LLM turns (so a reopened chat can be continued with full context).
 */
import * as crypto from 'node:crypto'
import * as vscode from 'vscode'
import type { ChatTurn } from '../inference/types'

export type TranscriptEntry =
  | { role: 'user' | 'reply' | 'error'; text: string; failed?: boolean; imageNames?: string[] }
  | {
      role: 'activity'
      /** Serializable provider event replayed to reconstruct tool/review UI. */
      message: { type: string; [key: string]: unknown }
    }

export interface StoredChat {
  id: string
  title: string
  workspace: string
  createdAt: number
  updatedAt: number
  transcript: TranscriptEntry[]
  turns: ChatTurn[]
}

export interface ChatSummary {
  id: string
  title: string
  workspace: string
  updatedAt: number
}

const MAX_CHATS = 100
const LEGACY_FILE = 'chats.json'
const INDEX_FILE = 'index.json'
const CHATS_DIR = 'chats'

interface ChatIndex {
  chats: ChatSummary[]
}

export class ChatStore {
  private readonly chatsDir: vscode.Uri
  private readonly indexFile: vscode.Uri
  private readonly legacyFile: vscode.Uri
  private indexCache: ChatSummary[] | null = null
  /** Serialize writes so an older concurrent save can never win on disk. */
  private writeChain: Promise<void> = Promise.resolve()
  private migrated = false

  constructor(private readonly storageUri: vscode.Uri) {
    this.chatsDir = vscode.Uri.joinPath(storageUri, CHATS_DIR)
    this.indexFile = vscode.Uri.joinPath(storageUri, INDEX_FILE)
    this.legacyFile = vscode.Uri.joinPath(storageUri, LEGACY_FILE)
  }

  async list(): Promise<ChatSummary[]> {
    await this.ensureMigrated()
    const index = await this.loadIndex()
    return [...index].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async get(id: string): Promise<StoredChat | null> {
    await this.ensureMigrated()
    try {
      const bytes = await vscode.workspace.fs.readFile(this.chatFile(id))
      return JSON.parse(Buffer.from(bytes).toString('utf8')) as StoredChat
    } catch {
      return null
    }
  }

  async upsert(chat: StoredChat): Promise<void> {
    await this.ensureMigrated()
    const index = await this.loadIndex()
    const summary: ChatSummary = {
      id: chat.id,
      title: chat.title,
      workspace: chat.workspace,
      updatedAt: chat.updatedAt,
    }
    const existing = index.findIndex((c) => c.id === chat.id)
    if (existing >= 0) index[existing] = summary
    else index.push(summary)
    index.sort((a, b) => b.updatedAt - a.updatedAt)
    const trimmed = index.slice(0, MAX_CHATS)
    const dropped = index.slice(MAX_CHATS)
    this.indexCache = trimmed
    await this.enqueuePersist(chat, trimmed, dropped.map((d) => d.id))
  }

  async delete(id: string): Promise<void> {
    await this.ensureMigrated()
    const index = await this.loadIndex()
    this.indexCache = index.filter((c) => c.id !== id)
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        await vscode.workspace.fs.createDirectory(this.storageUri)
        await vscode.workspace.fs.createDirectory(this.chatsDir)
        await this.atomicWrite(this.indexFile, JSON.stringify({ chats: this.indexCache ?? [] }))
        try {
          await vscode.workspace.fs.delete(this.chatFile(id))
        } catch {
          // File may already be gone.
        }
      })
    return this.writeChain
  }

  private chatFile(id: string): vscode.Uri {
    return vscode.Uri.joinPath(this.chatsDir, `${id}.json`)
  }

  private async loadIndex(): Promise<ChatSummary[]> {
    if (this.indexCache) return this.indexCache
    try {
      const bytes = await vscode.workspace.fs.readFile(this.indexFile)
      const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as ChatIndex
      this.indexCache = Array.isArray(parsed.chats) ? parsed.chats : []
    } catch {
      this.indexCache = []
    }
    return this.indexCache
  }

  private async ensureMigrated(): Promise<void> {
    if (this.migrated) return
    this.migrated = true
    try {
      await vscode.workspace.fs.readFile(this.indexFile)
      return
    } catch {
      // No index yet — try legacy migration.
    }
    try {
      const bytes = await vscode.workspace.fs.readFile(this.legacyFile)
      const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as StoredChat[]
      if (!Array.isArray(parsed) || parsed.length === 0) return
      await vscode.workspace.fs.createDirectory(this.storageUri)
      await vscode.workspace.fs.createDirectory(this.chatsDir)
      const summaries: ChatSummary[] = []
      for (const chat of parsed.slice(0, MAX_CHATS)) {
        await this.atomicWrite(this.chatFile(chat.id), JSON.stringify(chat))
        summaries.push({
          id: chat.id,
          title: chat.title,
          workspace: chat.workspace,
          updatedAt: chat.updatedAt,
        })
      }
      summaries.sort((a, b) => b.updatedAt - a.updatedAt)
      await this.atomicWrite(this.indexFile, JSON.stringify({ chats: summaries }))
      this.indexCache = summaries
    } catch {
      // First run or unreadable legacy file.
    }
  }

  private enqueuePersist(chat: StoredChat, index: ChatSummary[], dropIds: string[]): Promise<void> {
    const chatJson = JSON.stringify(chat)
    const indexJson = JSON.stringify({ chats: index })
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        await vscode.workspace.fs.createDirectory(this.storageUri)
        await vscode.workspace.fs.createDirectory(this.chatsDir)
        await this.atomicWrite(this.chatFile(chat.id), chatJson)
        await this.atomicWrite(this.indexFile, indexJson)
        for (const id of dropIds) {
          try {
            await vscode.workspace.fs.delete(this.chatFile(id))
          } catch {
            // Best-effort cleanup of evicted chats.
          }
        }
      })
    return this.writeChain
  }

  /** Write via temp file + rename for crash-safe persistence. */
  private async atomicWrite(target: vscode.Uri, contents: string): Promise<void> {
    const temp = vscode.Uri.joinPath(
      this.storageUri,
      `.tmp-${pathBasename(target)}-${crypto.randomUUID()}`,
    )
    await vscode.workspace.fs.writeFile(temp, Buffer.from(contents, 'utf8'))
    await vscode.workspace.fs.rename(temp, target, { overwrite: true })
  }
}

function pathBasename(uri: vscode.Uri): string {
  const parts = uri.path.split('/')
  return parts[parts.length - 1] ?? 'file'
}
