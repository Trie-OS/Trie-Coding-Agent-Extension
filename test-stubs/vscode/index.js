/** Minimal vscode stub for node:test runs outside the extension host. */
export const workspace = {
  isTrusted: true,
  findFiles: async () => [],
  fs: {
    createDirectory: async () => {},
    writeFile: async () => {},
    readFile: async () => new Uint8Array(),
    rename: async () => {},
    delete: async () => {},
  },
  getConfiguration: () => ({
    get: (_key, defaultValue) => defaultValue,
    inspect: () => ({
      globalValue: undefined,
      workspaceValue: undefined,
      workspaceFolderValue: undefined,
    }),
  }),
  workspaceFolders: [{ uri: { fsPath: '/tmp/workspace' }, name: 'workspace' }],
  onDidChangeWorkspaceFolders: () => ({ dispose: () => {} }),
}

export class CancellationTokenSource {
  constructor() {
    this.token = {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose: () => {} }),
    }
  }
  cancel() {
    this.token.isCancellationRequested = true
  }
  dispose() {}
}

export class RelativePattern {
  constructor(base, pattern) {
    this.base = base
    this.pattern = pattern
  }
}

export const Uri = {
  file: (fsPath) => ({ fsPath }),
  joinPath: (...parts) => ({ fsPath: String(parts[parts.length - 1]) }),
  from: (parts) => parts,
}

export const window = {
  showWarningMessage: async () => undefined,
  createOutputChannel: () => ({ appendLine: () => {} }),
  createStatusBarItem: () => ({ show: () => {}, dispose: () => {} }),
}

export const commands = {
  executeCommand: async () => undefined,
}

export const env = {
  machineId: 'test-machine',
  sessionId: 'test-session',
}

export const extensions = {
  getExtension: () => ({ packageJSON: { version: '0.0.0-test' } }),
}

export const StatusBarAlignment = { Right: 1 }

export const ConfigurationTarget = { Global: 1, Workspace: 2 }

export const ThemeColor = class {}

export const ThemeIcon = class {}

export const ViewColumn = { One: 1 }

export const WebviewViewProvider = class {}

export const WebviewPanel = class {}

export const ColorThemeKind = { Dark: 2, Light: 1, HighContrast: 3 }
