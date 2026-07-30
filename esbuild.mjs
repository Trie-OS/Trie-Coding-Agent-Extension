import { build, context } from 'esbuild'

const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  sourcemap: false,
  minify: false,
}

if (process.argv.includes('--watch')) {
  const ctx = await context(options)
  await ctx.watch()
  console.log('watching…')
} else {
  await build(options)
  console.log('built dist/extension.js')
}
