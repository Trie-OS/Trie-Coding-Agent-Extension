/**
 * Download node-llama-cpp + the platform prebuilt into extension globalStorage
 * on first embedded-daemon use. Keeps the Marketplace VSIX slim (<20 MB).
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type * as vscode from 'vscode'

export const LLAMA_CPP_VERSION = '3.19.1'

const PLATFORM_PREBUILT: Record<string, string> = {
  'darwin-arm64': '@node-llama-cpp/mac-arm64-metal',
  'darwin-x64': '@node-llama-cpp/mac-x64',
  'linux-x64': '@node-llama-cpp/linux-x64',
  'linux-arm64': '@node-llama-cpp/linux-arm64',
  'win32-x64': '@node-llama-cpp/win-x64',
  'win32-arm64': '@node-llama-cpp/win-arm64',
}

export function platformKey(): string {
  return `${process.platform}-${process.arch}`
}

export function platformPrebuiltPackage(): string | null {
  return PLATFORM_PREBUILT[platformKey()] ?? null
}

export function inferenceDepsRoot(context: vscode.ExtensionContext): string {
  return join(context.globalStorageUri.fsPath, 'inference-deps')
}

export function inferenceNodeModules(context: vscode.ExtensionContext): string {
  return join(inferenceDepsRoot(context), 'node_modules')
}

export function isInferenceInstalled(context: vscode.ExtensionContext): boolean {
  return existsSync(join(inferenceNodeModules(context), 'node-llama-cpp', 'package.json'))
}

export async function ensureInferenceDeps(
  context: vscode.ExtensionContext,
  log: (line: string) => void,
): Promise<string> {
  const nodeModules = inferenceNodeModules(context)
  if (isInferenceInstalled(context)) {
    log(`Using cached inference runtime at ${nodeModules}`)
    return nodeModules
  }

  const prebuilt = platformPrebuiltPackage()
  if (!prebuilt) {
    throw new Error(
      `Local GGUF inference is not supported on ${platformKey()}. ` +
        'Switch to the LLM API backend (Ollama / LM Studio) in settings.',
    )
  }

  const depsRoot = inferenceDepsRoot(context)
  mkdirSync(depsRoot, { recursive: true })
  writeFileSync(
    join(depsRoot, 'package.json'),
    JSON.stringify({ name: 'trie-inference-deps', private: true }, null, 2),
  )

  const packages = [`node-llama-cpp@${LLAMA_CPP_VERSION}`, `${prebuilt}@${LLAMA_CPP_VERSION}`]
  log(`Downloading inference runtime (one-time, ~40 MB): ${packages.join(', ')}`)

  await runNpmInstall(depsRoot, packages, log)

  if (!isInferenceInstalled(context)) {
    throw new Error('Inference runtime install finished but node-llama-cpp was not found.')
  }

  log(`Inference runtime ready at ${nodeModules}`)
  return nodeModules
}

function runNpmInstall(cwd: string, packages: string[], log: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const args = [
      'install',
      '--omit=dev',
      '--no-save',
      '--no-audit',
      '--no-fund',
      '--loglevel=error',
      ...packages,
    ]
    log(`> ${npm} ${args.join(' ')}`)

    const child = spawn(npm, args, {
      cwd,
      env: process.env,
      shell: process.platform === 'win32',
    })

    child.stdout?.on('data', (chunk: Buffer) => log(chunk.toString().trimEnd()))
    child.stderr?.on('data', (chunk: Buffer) => log(chunk.toString().trimEnd()))

    child.on('error', (error) => {
      reject(
        new Error(
          `Could not run npm (${error.message}). Install Node.js/npm, or use the LLM API backend with Ollama.`,
        ),
      )
    })

    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`npm install failed with exit code ${code ?? 'unknown'}`))
    })
  })
}
