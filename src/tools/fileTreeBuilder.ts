import { minimatch } from 'minimatch';
import { detectLanguage } from '../ingestion/languageDetection';
import type { FileStats } from '../storage/chunkStore';

export interface FileTreeOptions {
  rootPath?: string;
  maxDepth?: number;
  include?: string[];
  exclude?: string[];
  page?: number;
  pageSize?: number;
}

export interface FileTreeResult {
  text: string;
  totalNodes: number;
  page: number;
  totalPages: number;
}

interface DirNode {
  kind: 'dir';
  name: string;
  children: Map<string, TreeNode>;
}

interface FileNode {
  kind: 'file';
  name: string;
  tokenCount: number;
  displayExt: string;
  flags: string[];
}

type TreeNode = DirNode | FileNode;

const CONFIG_NAMES = new Set([
  'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  'tsconfig.json', 'jsconfig.json', 'Makefile', 'Dockerfile',
  '.gitignore', '.npmignore', '.eslintignore', '.prettierignore',
  'dockerfile',
]);

const CONFIG_PATTERNS = [
  /\.config\.[^/]+$/,
  /\.eslintrc/,
  /\.prettierrc/,
  /\.babelrc/,
  /\.env(\.|$)/,
  /vite\.config\./,
  /webpack\.config\./,
  /jest\.config\./,
  /vitest\.config\./,
  /rollup\.config\./,
];

function displayExtension(filePath: string): string {
  const lang = detectLanguage(filePath);
  if (lang) {
    const short: Record<string, string> = {
      typescript: 'ts', tsx: 'tsx', javascript: 'js', python: 'py',
      go: 'go', java: 'java', csharp: 'cs', rust: 'rs', ruby: 'rb',
    };
    return short[lang] ?? lang;
  }
  const dot = filePath.lastIndexOf('.');
  return dot >= 0 ? filePath.slice(dot + 1).toLowerCase() : '';
}

function classifyFlags(filePath: string): string[] {
  const flags: string[] = [];
  const lower = filePath.toLowerCase();
  const filename = filePath.split('/').pop() ?? filePath;
  const filenameLower = filename.toLowerCase();

  if (
    lower.includes('/test/') || lower.includes('/tests/') ||
    lower.includes('/spec/') || lower.includes('/__tests__/') ||
    filenameLower.includes('.test.') || filenameLower.includes('.spec.')
  ) {
    flags.push('test');
  }

  if (
    filenameLower.endsWith('.md') || filenameLower.endsWith('.mdx') ||
    lower.includes('/docs/') || lower.includes('/wiki/')
  ) {
    flags.push('docs');
  }

  if (lower.startsWith('.github/workflows/') || lower.includes('/.github/workflows/')) {
    flags.push('workflow');
  } else if (filenameLower === 'action.yml' || filenameLower === 'action.yaml') {
    flags.push('action');
  }

  if (
    CONFIG_NAMES.has(filenameLower) ||
    CONFIG_PATTERNS.some((re) => re.test(filenameLower))
  ) {
    flags.push('config');
  }

  return flags;
}

function getOrCreateDir(parent: DirNode, segment: string): DirNode {
  let node = parent.children.get(segment);
  if (!node) {
    node = { kind: 'dir', name: segment, children: new Map() };
    parent.children.set(segment, node);
  }
  if (node.kind !== 'dir') {
    throw new Error(`Path conflict: ${segment} is both a file and directory`);
  }
  return node;
}

function countFiles(node: DirNode): number {
  let count = 0;
  for (const child of node.children.values()) {
    if (child.kind === 'file') count++;
    else count += countFiles(child);
  }
  return count;
}

function sortedChildren(node: DirNode): TreeNode[] {
  const dirs: TreeNode[] = [];
  const files: TreeNode[] = [];
  for (const child of node.children.values()) {
    if (child.kind === 'dir') dirs.push(child);
    else files.push(child);
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  return [...dirs, ...files];
}

function flatten(node: DirNode, depth: number, maxDepth: number, indent: string, lines: string[]): void {
  for (const child of sortedChildren(node)) {
    if (child.kind === 'dir') {
      const fileCount = countFiles(child);
      lines.push(`${indent}${child.name}/ [dir, ${fileCount} file${fileCount !== 1 ? 's' : ''}]`);
      if (depth < maxDepth) {
        flatten(child, depth + 1, maxDepth, indent + '  ', lines);
      } else {
        lines.push(`${indent}  [${fileCount} file${fileCount !== 1 ? 's' : ''} not shown — use path: '${child.name}/' or increase maxDepth]`);
      }
    } else {
      const parts: string[] = [child.displayExt];
      if (child.tokenCount > 0) parts.push(`${child.tokenCount.toLocaleString()} tokens`);
      parts.push(...child.flags);
      lines.push(`${indent}${child.name} [${parts.join(', ')}]`);
    }
  }
}

export function buildFileTree(files: FileStats[], opts: FileTreeOptions = {}): FileTreeResult {
  const rootPath = opts.rootPath ? opts.rootPath.replace(/\/$/, '') : '';
  const maxDepth = Math.min(opts.maxDepth ?? 5, 10);
  const page = Math.max(opts.page ?? 1, 1);
  const pageSize = Math.min(opts.pageSize ?? 200, 500);

  // Filter by rootPath prefix
  let filtered = rootPath
    ? files.filter((f) => f.filePath === rootPath || f.filePath.startsWith(rootPath + '/'))
    : files;

  // Strip rootPath prefix so tree is rooted there
  if (rootPath) {
    filtered = filtered.map((f) => ({
      ...f,
      filePath: f.filePath === rootPath ? f.filePath.split('/').pop()! : f.filePath.slice(rootPath.length + 1),
    }));
  }

  // Apply include/exclude globs
  if (opts.include && opts.include.length > 0) {
    filtered = filtered.filter((f) =>
      opts.include!.some((pat) => minimatch(f.filePath, pat, { dot: true })),
    );
  }
  if (opts.exclude && opts.exclude.length > 0) {
    filtered = filtered.filter((f) =>
      !opts.exclude!.some((pat) => minimatch(f.filePath, pat, { dot: true })),
    );
  }

  if (filtered.length === 0) {
    return { text: 'No indexed files match the given filters.', totalNodes: 0, page: 1, totalPages: 1 };
  }

  // Build tree
  const root: DirNode = { kind: 'dir', name: '', children: new Map() };
  for (const f of filtered) {
    const segments = f.filePath.split('/');
    const filename = segments.pop()!;
    let cur = root;
    for (const seg of segments) {
      cur = getOrCreateDir(cur, seg);
    }
    const originalPath = rootPath ? `${rootPath}/${f.filePath}` : f.filePath;
    cur.children.set(filename, {
      kind: 'file',
      name: filename,
      tokenCount: f.tokenCount,
      displayExt: displayExtension(originalPath),
      flags: classifyFlags(originalPath),
    });
  }

  // Flatten to lines
  const allLines: string[] = [];
  flatten(root, 1, maxDepth, '', allLines);

  const totalNodes = allLines.length;
  const totalPages = Math.ceil(totalNodes / pageSize);
  const clampedPage = Math.min(page, totalPages);
  const start = (clampedPage - 1) * pageSize;
  const pageLines = allLines.slice(start, start + pageSize);

  const text = pageLines.join('\n');
  return { text, totalNodes, page: clampedPage, totalPages };
}
