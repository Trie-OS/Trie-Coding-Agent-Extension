/**
 * Cross-platform shell execution for run_command.
 */
import { execFile, type ExecFileOptions, type ChildProcess } from 'node:child_process'

export interface ShellExecResult {
  ok: boolean
  text: string
  cancelled?: boolean
}

export function shellExec(
  command: string,
  cwd: string,
  timeoutMs: number,
  maxBuffer: number,
  signal?: AbortSignal,
): Promise<ShellExecResult> {
  if (signal?.aborted) {
    return Promise.resolve({ ok: false, text: 'Cancelled.', cancelled: true })
  }
  const { file, args, options } = shellCommandSpec(command, cwd, timeoutMs, maxBuffer)
  return new Promise((resolve) => {
    let settled = false
    const finish = (result: ShellExecResult): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const child: ChildProcess = execFile(file, args, options, (error, stdout, stderr) => {
      const text = [stdout, stderr].filter(Boolean).join('\n')
      finish({
        ok: !error,
        text: text || (error ? String(error) : '(no output)'),
      })
    })
    const onAbort = (): void => {
      try {
        child.kill('SIGTERM')
      } catch {
        /* already exited */
      }
      setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* already exited */
        }
      }, 500)
      finish({ ok: false, text: 'Cancelled.', cancelled: true })
    }
    signal?.addEventListener('abort', onAbort, { once: true })
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

export function execFileWithSignal(
  executable: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  maxBuffer: number,
  signal?: AbortSignal,
): Promise<{ ok: boolean; text: string; cancelled?: boolean }> {
  if (signal?.aborted) {
    return Promise.resolve({ ok: false, text: 'Cancelled.', cancelled: true })
  }
  return new Promise((resolve) => {
    let settled = false
    const finish = (result: { ok: boolean; text: string; cancelled?: boolean }): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const child = execFile(
      executable,
      args,
      { cwd, timeout: timeoutMs, maxBuffer },
      (error, stdout, stderr) => {
        const text = [stdout, stderr].filter(Boolean).join('\n')
        finish({
          ok: !error,
          text: text || (error ? String(error) : '(no output)'),
        })
      },
    )
    const onAbort = (): void => {
      try {
        child.kill('SIGTERM')
      } catch {
        /* already exited */
      }
      setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* already exited */
        }
      }, 500)
      finish({ ok: false, text: 'Cancelled.', cancelled: true })
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
