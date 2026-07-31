import { build, context } from 'esbuild'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const appSrc = resolve(__dirname, '../app/src')

const shared = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: false,
  minify: false,
  alias: {
    '@shared': resolve(appSrc, 'shared'),
  },
}

const extensionOptions = {
  ...shared,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  external: ['vscode'],
}

const daemonOptions = {
  ...shared,
  entryPoints: [resolve(appSrc, 'daemon/trie-daemon.ts')],
  outfile: 'dist/daemon.js',
  external: ['node-llama-cpp'],
}

const webviewOptions = {
  entryPoints: ['media/src/main.ts'],
  outfile: 'media/main.js',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
  sourcemap: false,
  minify: false,
}

const watch = process.argv.includes('--watch')

if (watch) {
  const ctx = await context(extensionOptions)
  await ctx.watch()
  console.log('watching extension…')
} else {
  await build(extensionOptions)
  console.log('built dist/extension.js')
  await build(daemonOptions)
  console.log('built dist/daemon.js')
  await build(webviewOptions)
  console.log('built media/main.js')
}
