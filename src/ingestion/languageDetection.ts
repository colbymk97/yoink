// Maps a file path extension to a tree-sitter language id used by
// ParserRegistry. Returns null for anything not in the v1 supported set.

export type SupportedLanguage =
  | 'typescript'
  | 'tsx'
  | 'javascript'
  | 'python'
  | 'go'
  | 'java'
  | 'csharp'
  | 'rust'
  | 'ruby';

const EXTENSION_TO_LANGUAGE: Record<string, SupportedLanguage> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  py: 'python',
  go: 'go',
  java: 'java',
  cs: 'csharp',
  rs: 'rust',
  rb: 'ruby',
};

export function detectLanguage(filePath: string): SupportedLanguage | null {
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = filePath.slice(dot + 1).toLowerCase();
  return EXTENSION_TO_LANGUAGE[ext] ?? null;
}

// Comment syntax used when prepending parent-class context to method chunks.
export function lineCommentPrefix(language: SupportedLanguage): string {
  if (language === 'python' || language === 'ruby') return '#';
  return '//';
}
