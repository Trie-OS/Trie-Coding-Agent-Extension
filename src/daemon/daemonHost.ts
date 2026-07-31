import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import * as vscode from 'vscode'
import { readConfig } from '../config'
import { DaemonClient } from '../inference/daemonClient'
import { ensureInferenceDeps } from './inferenceDeps'

const OUTPUT_CHANNEL = 'Trie Coding Agent Daemon'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** VS Code on macOS often lacks node on PATH — resolve via the user's login shell. */
function resolveNodeBinary(): Promise<string> {
  if (process.platform === 'win32') return Promise.resolve('node.exe')
  const shell = process.env.SHELL || '/bin/zsh'
  return new Promise((resolve) => {
    execFile(shell, ['-l', '-c', 'command -v node'], { timeout: 8000 }, (error, stdout) => {
      const found = stdout?.trim()
      resolve(!error && found ? found : 'node')
    })
  })
}

function assertNodeAvailable(bin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, ['--version'], { timeout: 10_000 }, (error, stdout) => {
      if (error) {
        reject(
          new Error(
            `Node.js is required for local GGUF inference (tried "${bin}"). Install Node.js from https://nodejs.org ` +
              'or switch to the openai-compatible backend (Ollama / LM Studio) in settings.',
          ),
        )
        return
      }
      resolve(stdout.trim())
    })
  })
}

async function killProcessOnPort(port: number): Promise<void> {
  if (process.platform === 'win32') return
  await new Promise<void>((resolve) => {
    execFile('lsof', ['-ti', `:${port}`], (error, stdout) => {
      if (error || !stdout.trim()) {
        resolve()
        return
      }
      for (const pid of stdout.trim().split('\n')) {
        try {
          process.kill(Number(pid), 'SIGTERM')
        } catch {
          // Process may have already exited.
        }
      }
      resolve()
    })
  })
}

function parseDaemonUrl(url: string): { host: string; port: number } {
  const parsed = new URL(url)
  return {
    host: parsed.hostname || '127.0.0.1',
    port: parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 7841,
  }
}

export class DaemonHost {
  private child: ChildProcess | null = null
  private readonly output: vscode.OutputChannel
  private startedByExtension = false

  constructor(private readonly context: vscode.ExtensionContext) {
    this.output = vscode.window.createOutputChannel(OUTPUT_CHANNEL)
    context.subscriptions.push(this.output)
  }

  isManaged(): boolean {
    return this.startedByExtension && this.child !== null
  }

  log(line: string): void {
    this.output.appendLine(line)
  }

  async handshake(url: string): Promise<boolean> {
    try {
      await new DaemonClient(url).handshake()
      return true
    } catch {
      return false
    }
  }

  async ensureRunning(): Promise<boolean> {
    const cfg = readConfig()
    if (cfg.backend !== 'daemon') return false

    if (await this.handshake(cfg.daemon.url)) {
      this.log(`Using existing trie-daemon at ${cfg.daemon.url}`)
      return true
    }

    if (!cfg.daemon.autoStart) {
      this.log(`No daemon at ${cfg.daemon.url} and autoStart is disabled`)
      return false
    }

    await this.startEmbedded()
    return this.handshake(cfg.daemon.url)
  }

  /**
   * Restart the embedded daemon before loading a model. Reuses a stale process
   * (e.g. one started under VS Code's Electron before 0.3.2) and load fails
   * with no model ever attached.
   */
  async restartForConnect(): Promise<boolean> {
    const cfg = readConfig()
    if (cfg.backend !== 'daemon') return false

    if (cfg.daemon.command.trim()) {
      if (await this.handshake(cfg.daemon.url)) return true
      await this.spawnCommand(cfg.daemon.command.trim(), cfg)
      return this.handshake(cfg.daemon.url)
    }

    if (!cfg.daemon.autoStart) {
      return this.handshake(cfg.daemon.url)
    }

    await this.stopEmbedded()
    const { port } = parseDaemonUrl(cfg.daemon.url)
    await killProcessOnPort(port)
    await sleep(400)
    await this.startEmbedded()
    return this.handshake(cfg.daemon.url)
  }

  async installInferenceRuntime(): Promise<void> {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Downloading local inference runtime (one-time, ~40 MB)…',
        cancellable: false,
      },
      () => ensureInferenceDeps(this.context, (line) => this.log(line)),
    )
    void vscode.window.showInformationMessage('Local inference runtime installed.')
  }

  async startEmbedded(): Promise<void> {
    if (this.child) return

    const cfg = readConfig()
    const { host, port } = parseDaemonUrl(cfg.daemon.url)
    const extensionPath = this.context.extensionPath
    const daemonScript = join(extensionPath, 'dist', 'daemon.js')

    if (cfg.daemon.command.trim()) {
      await this.spawnCommand(cfg.daemon.command.trim(), cfg)
      return
    }

    if (!existsSync(daemonScript)) {
      throw new Error(`Embedded daemon not found at ${daemonScript}. Reinstall the extension.`)
    }

    let nodePath = join(extensionPath, 'node_modules')
    if (!existsSync(join(nodePath, 'node-llama-cpp'))) {
      nodePath = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Downloading local inference runtime (one-time, ~40 MB)…',
          cancellable: false,
        },
        () => ensureInferenceDeps(this.context, (line) => this.log(line)),
      )
    }

    const nodeBin = await resolveNodeBinary()
    const nodeVersion = await assertNodeAvailable(nodeBin)
    this.log(`Using Node.js ${nodeVersion} (${nodeBin}) for embedded trie-daemon`)

    const args = [daemonScript, `--port=${port}`, `--host=${host}`]
    if (cfg.daemon.storePath.trim()) {
      args.push(`--store=${cfg.daemon.storePath.trim()}`)
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_PATH: nodePath,
      TRIE_INFERENCE_NODE_MODULES: nodePath,
    }

    this.log(`Starting embedded trie-daemon: ${nodeBin} ${args.join(' ')}`)
    this.child = spawn(nodeBin, args, {
      cwd: extensionPath,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    })
    this.startedByExtension = true

    const child = this.child
    child.stdout?.on('data', (chunk: Buffer) => this.log(chunk.toString().trimEnd()))
    child.stderr?.on('data', (chunk: Buffer) => this.log(chunk.toString().trimEnd()))
    child.on('exit', (code, signal) => {
      this.log(`trie-daemon exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`)
      this.child = null
      this.startedByExtension = false
    })

    await this.waitForReady(cfg.daemon.url)
  }

  private async spawnCommand(commandLine: string, cfg: ReturnType<typeof readConfig>): Promise<void> {
    const { host, port } = parseDaemonUrl(cfg.daemon.url)
    const parts = commandLine.split(/\s+/).filter(Boolean)
    const cmd = parts[0]!
    const args = parts.slice(1)
    if (!args.some((a) => a.startsWith('--port='))) args.push(`--port=${port}`)
    if (!args.some((a) => a.startsWith('--host='))) args.push(`--host=${host}`)
    if (cfg.daemon.storePath.trim() && !args.some((a) => a.startsWith('--store='))) {
      args.push(`--store=${cfg.daemon.storePath.trim()}`)
    }

    this.log(`Starting user trie-daemon: ${commandLine}`)
    this.child = spawn(cmd, args, {
      cwd: this.context.extensionPath,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    })
    this.startedByExtension = true

    const child = this.child
    child.stdout?.on('data', (chunk: Buffer) => this.log(chunk.toString().trimEnd()))
    child.stderr?.on('data', (chunk: Buffer) => this.log(chunk.toString().trimEnd()))
    child.on('exit', (code, signal) => {
      this.log(`trie-daemon exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`)
      this.child = null
      this.startedByExtension = false
    })

    await this.waitForReady(cfg.daemon.url)
  }

  private async waitForReady(url: string, timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await this.handshake(url)) {
        this.log(`trie-daemon ready at ${url}`)
        return
      }
      await sleep(250)
    }
    throw new Error(`Timed out waiting for trie-daemon at ${url}`)
  }

  async stopEmbedded(): Promise<void> {
    if (this.child) {
      const child = this.child
      this.child = null
      this.startedByExtension = false
      child.kill('SIGTERM')
      await sleep(500)
      if (!child.killed) child.kill('SIGKILL')
      this.log('Stopped embedded trie-daemon')
    }

    const { port } = parseDaemonUrl(readConfig().daemon.url)
    await killProcessOnPort(port)
  }

  dispose(): void {
    const cfg = readConfig()
    if (cfg.daemon.keepRunning) {
      this.log('keepRunning enabled — leaving trie-daemon running after VS Code closes')
      return
    }
    void this.stopEmbedded()
  }
}
