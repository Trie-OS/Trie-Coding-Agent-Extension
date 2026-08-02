/**
 * Cross-platform shell execution for run_command.
 */
import { execFile, type ExecFileOptions } from 'node:child_process'

export interface ShellExecResult {
  ok: boolean
  text: string
}

export function shellExec(
  command: string,
  cwd: string,
  timeoutMs: number,
  maxBuffer: number,
): Promise<ShellExecResult> {
  const { file, args, options } = shellCommandSpec(command, cwd, timeoutMs, maxBuffer)
  return new Promise((resolve) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      const text = [stdout, stderr].filter(Boolean).join('\n')
      resolve({ ok: !error, text: text || (error ? String(error) : '(no output)') })
    })
  })
}

/** Exported for unit tests. */
export function shellCommandSpec(
  command: string,
  cwd: string,
  timeoutMs: number,
  maxBuffer: number,
): { file: string; args: string[]; options: ExecFileOptions } {
  const base: ExecFileOptions = { cwd, timeout: timeoutMs, maxBuffer }
  if (process.platform === 'win32') {
    return {
      file: process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', command],
      options: { ...base, windowsVerbatimArguments: true },
    }
  }
  return {
    file: '/bin/sh',
    args: ['-c', command],
    options: base,
  }
}
