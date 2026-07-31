#!/usr/bin/env node
/**
 * Slim Marketplace VSIX — extension + bundled daemon.js only.
 * node-llama-cpp is downloaded on first use into extension globalStorage.
 */
import { execSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

console.log('Building slim Marketplace VSIX (no bundled node-llama-cpp)…')
execSync('npm run typecheck && npm run build', { cwd: root, stdio: 'inherit' })
execSync('npx @vscode/vsce package --no-dependencies', { cwd: root, stdio: 'inherit' })
