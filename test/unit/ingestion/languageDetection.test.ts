import { describe, it, expect } from 'vitest';
import { detectLanguage, lineCommentPrefix } from '../../../src/ingestion/languageDetection';

describe('detectLanguage', () => {
  const cases: Array<[string, ReturnType<typeof detectLanguage>]> = [
    ['foo.ts', 'typescript'],
    ['foo.mts', 'typescript'],
    ['foo.cts', 'typescript'],
    ['foo.tsx', 'tsx'],
    ['foo.js', 'javascript'],
    ['foo.mjs', 'javascript'],
    ['foo.cjs', 'javascript'],
    ['foo.jsx', 'javascript'],
    ['foo.py', 'python'],
    ['foo.go', 'go'],
    ['Foo.java', 'java'],
    ['Foo.cs', 'csharp'],
    ['foo.rs', 'rust'],
    ['foo.rb', 'ruby'],
    ['src/deep/nested/path.ts', 'typescript'],
    ['UPPER.PY', 'python'],
    // Unsupported / unknown
    ['foo.lua', null],
    ['foo.md', null],
    ['foo.yaml', null],
    ['Makefile', null],
    ['no-extension', null],
    ['', null],
  ];

  for (const [input, expected] of cases) {
    it(`maps "${input}" -> ${expected}`, () => {
      expect(detectLanguage(input)).toBe(expected);
    });
  }
});

describe('lineCommentPrefix', () => {
  it('uses # for Python and Ruby', () => {
    expect(lineCommentPrefix('python')).toBe('#');
    expect(lineCommentPrefix('ruby')).toBe('#');
  });

  it('uses // for curly-brace languages', () => {
    expect(lineCommentPrefix('typescript')).toBe('//');
    expect(lineCommentPrefix('javascript')).toBe('//');
    expect(lineCommentPrefix('tsx')).toBe('//');
    expect(lineCommentPrefix('go')).toBe('//');
    expect(lineCommentPrefix('java')).toBe('//');
    expect(lineCommentPrefix('csharp')).toBe('//');
    expect(lineCommentPrefix('rust')).toBe('//');
  });
});
