// Copies tree-sitter query files from src/chunking/queries/ into
// dist/queries/ so they ship with the VSIX. Invoked from `npm run build`.

import { mkdir, readdir, copyFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const srcDir = join(repoRoot, 'src', 'chunking', 'queries');
const outDir = join(repoRoot, 'dist', 'queries');

await mkdir(outDir, { recursive: true });

const entries = await readdir(srcDir);
const queries = entries.filter((name) => name.endsWith('.scm'));
for (const name of queries) {
  await copyFile(join(srcDir, name), join(outDir, name));
}
console.log(`copy-queries: wrote ${queries.length} .scm files to ${outDir}`);
