import * as vscode from 'vscode'

export type WebviewTheme = 'light' | 'dark'

/** Match the active VS Code color theme for webview surfaces. */
export function webviewTheme(): WebviewTheme {
  const kind = vscode.window.activeColorTheme.kind
  if (
    kind === vscode.ColorThemeKind.Dark ||
    kind === vscode.ColorThemeKind.HighContrast
  ) {
    return 'dark'
  }
  return 'light'
}
