#!/usr/bin/env node
/**
 * Build a platform-specific VSIX with the matching @node-llama-cpp prebuilt.
 *
 * Usage:
 *   node scripts/package-platform.mjs [--target darwin-arm64|darwin-x64|linux-x64|win32-x64]
 *
 * Default target: current process.platform + process.arch
 */
import { execSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

const TARGET_PACKAGES = {
  'darwin-arm64': '@node-llama-cpp/mac-arm64-metal',
  'darwin-x64': '@node-llama-cpp/mac-x64',
  'linux-x64': '@node-llama-cpp/linux-x64',
  'linux-arm64': '@node-llama-cpp/linux-arm64',
  'win32-x64': '@node-llama-cpp/win-x64',
  'win32-arm64': '@node-llama-cpp/win-arm64',
}

function defaultTarget() {
  const key = `${process.platform}-${process.arch}`
  if (key in TARGET_PACKAGES) return key
  throw new Error(`Unsupported platform for packaging: ${key}`)
}

const targetArg = process.argv.find((a) => a.startsWith('--target='))
const target = targetArg ? targetArg.slice('--target='.length) : defaultTarget()
const prebuilt = TARGET_PACKAGES[target]
if (!prebuilt) {
  console.error(`Unknown --target=${target}. Valid: ${Object.keys(TARGET_PACKAGES).join(', ')}`)
  process.exit(1)
}

console.log(`Packaging trie-ide for ${target} with ${prebuilt}`)
execSync(`npm install ${prebuilt}@3.19.1 --no-save`, { cwd: root, stdio: 'inherit' })
execSync('npm run build', { cwd: root, stdio: 'inherit' })
execSync(`npx @vscode/vsce package --target ${target}`, {
  cwd: root,
  stdio: 'inherit',
})
