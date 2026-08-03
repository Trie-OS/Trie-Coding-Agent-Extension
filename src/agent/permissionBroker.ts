/**
 * In-chat permission broker — shell commands and sensitive writes via the webview.
 */

export type PermissionKind = 'shell' | 'write' | 'scope' | 'verification'

export interface PermissionRequest {
  kind: PermissionKind
  title: string
  preview: string
  path?: string
  command?: string
  cwd?: string
  scope?: 'outside-workspace' | 'url-pattern'
  toolName?: string
  action?: 'edit' | 'write'
  diff?: { before?: string; after?: string }
}

export type PermissionChoice = 'once' | 'session' | 'always' | 'deny'

export type PermissionRequestHandler = (
  requestId: string,
  request: PermissionRequest,
) => Promise<PermissionChoice | null>

const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000

export class PermissionBroker {
  private handler: PermissionRequestHandler | null = null

  setHandler(handler: PermissionRequestHandler | null): void {
    this.handler = handler
  }

  async ask(request: PermissionRequest): Promise<PermissionChoice | null> {
    if (!this.handler) return null
    const requestId = crypto.randomUUID()
    const timeout = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), PERMISSION_TIMEOUT_MS)
    })
    return Promise.race([this.handler(requestId, request), timeout])
  }
}
