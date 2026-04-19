import { describe, it, expect } from 'vitest';
import { buildFileTree } from '../../../src/tools/fileTreeBuilder';
import type { FileStats } from '../../../src/storage/chunkStore';

function fs(filePath: string, tokenCount = 100): FileStats {
  return { filePath, chunkCount: 1, tokenCount };
}

const SAMPLE: FileStats[] = [
  fs('src/extension.ts', 1234),
  fs('src/tools/toolHandler.ts', 2341),
  fs('src/tools/toolManager.ts', 856),
  fs('src/storage/database.ts', 567),
  fs('test/unit/chunker.test.ts', 890),
  fs('docs/README.md', 1890),
  fs('package.json', 178),
  fs('.github/workflows/ci.yml', 432),
];

describe('buildFileTree', () => {
  it('returns all files when no filters applied', () => {
    const { text, totalNodes } = buildFileTree(SAMPLE);
    expect(totalNodes).toBeGreaterThan(0);
    expect(text).toContain('extension.ts');
    expect(text).toContain('toolHandler.ts');
    expect(text).toContain('package.json');
  });

  it('renders dirs before files, alphabetically', () => {
    const { text } = buildFileTree(SAMPLE);
    const lines = text.split('\n').map((l) => l.trim());
    const srcIdx = lines.findIndex((l) => l.startsWith('src/'));
    const pkgIdx = lines.findIndex((l) => l.startsWith('package.json'));
    expect(srcIdx).toBeLessThan(pkgIdx);
  });

  it('annotates test files with test flag', () => {
    const { text } = buildFileTree(SAMPLE);
    expect(text).toMatch(/chunker\.test\.ts.*test/);
  });

  it('annotates docs files with docs flag', () => {
    const { text } = buildFileTree(SAMPLE);
    expect(text).toMatch(/README\.md.*docs/);
  });

  it('annotates workflow files with workflow flag', () => {
    const { text } = buildFileTree(SAMPLE);
    expect(text).toMatch(/ci\.yml.*workflow/);
  });

  it('annotates package.json with config flag', () => {
    const { text } = buildFileTree(SAMPLE);
    expect(text).toMatch(/package\.json.*config/);
  });

  it('rootPath scopes to subtree', () => {
    const { text } = buildFileTree(SAMPLE, { rootPath: 'src' });
    expect(text).toContain('extension.ts');
    expect(text).not.toContain('package.json');
    expect(text).not.toContain('README.md');
  });

  it('maxDepth truncates deep dirs', () => {
    const { text } = buildFileTree(SAMPLE, { maxDepth: 1 });
    expect(text).toContain('not shown');
    expect(text).not.toContain('toolHandler.ts');
  });

  it('maxDepth 3 shows three levels deep', () => {
    const { text } = buildFileTree(SAMPLE, { maxDepth: 3 });
    expect(text).toContain('toolHandler.ts');
  });

  it('include glob filters to matching files', () => {
    const { text } = buildFileTree(SAMPLE, { include: ['**/*.md'] });
    expect(text).toContain('README.md');
    expect(text).not.toContain('extension.ts');
  });

  it('exclude glob removes matching files', () => {
    const { text } = buildFileTree(SAMPLE, { exclude: ['test/**'] });
    expect(text).not.toContain('chunker.test.ts');
    expect(text).toContain('extension.ts');
  });

  it('pagination returns correct page', () => {
    const bigFiles = Array.from({ length: 50 }, (_, i) =>
      fs(`src/file${String(i).padStart(2, '0')}.ts`),
    );
    const r1 = buildFileTree(bigFiles, { pageSize: 10, page: 1 });
    const r2 = buildFileTree(bigFiles, { pageSize: 10, page: 2 });
    expect(r1.totalPages).toBeGreaterThan(1);
    expect(r1.page).toBe(1);
    expect(r2.page).toBe(2);
    expect(r1.text).not.toBe(r2.text);
  });

  it('clamps page to totalPages', () => {
    const { page, totalPages } = buildFileTree(SAMPLE, { page: 9999, pageSize: 5 });
    expect(page).toBe(totalPages);
  });

  it('returns empty message when no files match filters', () => {
    const { text } = buildFileTree(SAMPLE, { include: ['**/*.xyz'] });
    expect(text).toContain('No indexed files');
  });

  it('handles empty file list', () => {
    const { text, totalNodes } = buildFileTree([]);
    expect(totalNodes).toBe(0);
    expect(text).toContain('No indexed files');
  });

  it('caps maxDepth at 10', () => {
    const result = buildFileTree(SAMPLE, { maxDepth: 99 });
    expect(result.text).toBeTruthy();
  });

  it('caps pageSize at 500', () => {
    const result = buildFileTree(SAMPLE, { pageSize: 9999 });
    expect(result.totalPages).toBe(1);
  });
});
