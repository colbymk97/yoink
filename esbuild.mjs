import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

/** @type {esbuild.BuildOptions} */
const buildOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: [
    'vscode',
    'better-sqlite3',
    'sqlite-vec',
    'web-tree-sitter',
  ],
  format: 'cjs',
  platform: 'node',
  target: 'es2022',
  sourcemap: true,
  minify: false,
};

if (watch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log('esbuild: watching for changes...');
} else {
  await esbuild.build(buildOptions);
}
