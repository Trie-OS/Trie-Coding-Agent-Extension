/**
 * Chat history persistence — one JSON file in the extension's global storage.
 * Each chat keeps a display transcript (for replay in the webview) and the
 * raw LLM turns (so a reopened chat can be continued with full context).
 */
import * as vscode from 'vscode'
import type { ChatTurn } from '../inference/types'

export type TranscriptEntry =
  | { role: 'user' | 'reply' | 'error'; text: string; failed?: boolean }
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

export class ChatStore {
  private readonly file: vscode.Uri
  private cache: StoredChat[] | null = null
  /** Serialize writes so an older concurrent save can never win on disk. */
  private writeChain: Promise<void> = Promise.resolve()

  constructor(private readonly storageUri: vscode.Uri) {
    this.file = vscode.Uri.joinPath(storageUri, 'chats.json')
  }

  async list(): Promise<ChatSummary[]> {
    const chats = await this.load()
    return chats
      .map(({ id, title, workspace, updatedAt }) => ({ id, title, workspace, updatedAt }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async get(id: string): Promise<StoredChat | null> {
    const chats = await this.load()
    return chats.find((c) => c.id === id) ?? null
  }

  async upsert(chat: StoredChat): Promise<void> {
    const chats = await this.load()
    const index = chats.findIndex((c) => c.id === chat.id)
    if (index >= 0) chats[index] = chat
    else chats.push(chat)
    // Cap the file: drop the oldest chats beyond the limit.
    chats.sort((a, b) => b.updatedAt - a.updatedAt)
    this.cache = chats.slice(0, MAX_CHATS)
    await this.enqueuePersist()
  }

  async delete(id: string): Promise<void> {
    const chats = await this.load()
    this.cache = chats.filter((c) => c.id !== id)
    await this.enqueuePersist()
  }

  private async load(): Promise<StoredChat[]> {
    if (this.cache) return this.cache
    try {
      const bytes = await vscode.workspace.fs.readFile(this.file)
      const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as StoredChat[]
      this.cache = Array.isArray(parsed) ? parsed : []
    } catch {
      this.cache = [] // first run, or unreadable file — start fresh
    }
    return this.cache
  }

  private enqueuePersist(): Promise<void> {
    const snapshot = JSON.stringify(this.cache ?? [], null, 1)
    this.writeChain = this.writeChain
      .catch(() => {
        // A failed previous write must not permanently poison later saves.
      })
      .then(async () => {
        await vscode.workspace.fs.createDirectory(this.storageUri)
        await vscode.workspace.fs.writeFile(this.file, Buffer.from(snapshot, 'utf8'))
      })
    return this.writeChain
  }
}
