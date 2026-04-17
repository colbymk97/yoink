import { chunkByAst, AstChunkerLogger } from './astChunker';
import { detectLanguage } from './languageDetection';
import type { ParserRegistry } from './parserRegistry';

export interface Chunk {
  content: string;
  startLine: number;
  endLine: number;
  tokenCount: number;
}

export type ChunkingStrategy = 'token-split' | 'file-level' | 'markdown-heading' | 'ast-based';

export interface AstChunkerDepsOption {
  parserRegistry: ParserRegistry;
  logger?: AstChunkerLogger;
}

export interface ChunkerOptions {
  maxTokens: number;
  overlapTokens: number;
  countTokens: (text: string) => number;
  /**
   * Force a single strategy for every file, bypassing per-file routing.
   * Primarily for tests; production callers should rely on routing.
   */
  strategy?: ChunkingStrategy;
  astDeps?: AstChunkerDepsOption;
}

const DEFAULT_MAX_TOKENS = 512;
const DEFAULT_OVERLAP_TOKENS = 64;
const DEFAULT_COUNT_TOKENS = (text: string): number => Math.ceil(text.length / 4);

export class Chunker {
  private readonly maxTokens: number;
  private readonly overlapTokens: number;
  private readonly countTokens: (text: string) => number;
  private readonly forcedStrategy?: ChunkingStrategy;
  private readonly astDeps?: AstChunkerDepsOption;

  constructor(options?: Partial<ChunkerOptions>) {
    this.maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.overlapTokens = options?.overlapTokens ?? DEFAULT_OVERLAP_TOKENS;
    this.countTokens = options?.countTokens ?? DEFAULT_COUNT_TOKENS;
    this.forcedStrategy = options?.strategy;
    this.astDeps = options?.astDeps;
  }

  async chunkFile(content: string, filePath: string): Promise<Chunk[]> {
    if (!content) return [];
    if (this.forcedStrategy) {
      return this.dispatch(this.forcedStrategy, content, filePath);
    }
    let strategy = Chunker.routeStrategy(filePath);
    if (strategy === 'ast-based' && !this.astDeps) {
      // Parser registry wasn't wired in — degrade gracefully rather than throw.
      strategy = 'token-split';
    }
    return this.dispatch(strategy, content, filePath);
  }

  /**
   * Per-file routing table. Picks a chunking strategy based on path/extension.
   * Callers may override via the `strategy` option but should only do so for tests.
   */
  static routeStrategy(filePath: string): ChunkingStrategy {
    const lower = filePath.toLowerCase();
    if (lower.endsWith('.md') || lower.endsWith('.mdx')) return 'markdown-heading';
    if (
      lower.includes('.github/workflows/') &&
      (lower.endsWith('.yml') || lower.endsWith('.yaml'))
    ) {
      return 'file-level';
    }
    const base = lower.split('/').pop() ?? '';
    if (base === 'action.yml' || base === 'action.yaml') return 'file-level';
    if (detectLanguage(filePath) !== null) return 'ast-based';
    return 'token-split';
  }

  private dispatch(strategy: ChunkingStrategy, content: string, filePath: string): Promise<Chunk[]> | Chunk[] {
    if (strategy === 'ast-based') return this.chunkByAst(content, filePath);
    if (strategy === 'file-level') return this.chunkAsWhole(content);
    if (strategy === 'markdown-heading') return this.chunkByHeadings(content);
    return this.chunkByTokens(content, filePath);
  }

  private chunkByAst(content: string, filePath: string): Promise<Chunk[]> {
    if (!this.astDeps) {
      throw new Error(
        "Chunker configured with strategy 'ast-based' but astDeps.parserRegistry was not provided",
      );
    }
    return chunkByAst(content, filePath, {
      parserRegistry: this.astDeps.parserRegistry,
      countTokens: this.countTokens,
      maxTokens: this.maxTokens,
      fallback: (text, path) => this.chunkByTokens(text, path),
      logger: this.astDeps.logger,
    });
  }

  // One chunk spanning the entire file. Used for action.yml and workflow files
  // where each file is a self-contained semantic unit.
  private chunkAsWhole(content: string): Chunk[] {
    const lines = content.split('\n');
    return [{
      content,
      startLine: 1,
      endLine: lines.length,
      tokenCount: this.countTokens(content),
    }];
  }

  // Split on Markdown headings (lines starting with '#'). Each heading and its
  // following content becomes one chunk. Sections that exceed maxTokens are
  // sub-chunked with the token-split strategy.
  private chunkByHeadings(content: string): Chunk[] {
    const lines = content.split('\n');
    const chunks: Chunk[] = [];

    // Collect sections: each entry is [startIdx, lines[]]
    const sections: Array<{ startIdx: number; lines: string[] }> = [];
    let sectionStart = 0;
    let sectionLines: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const isHeading = lines[i].startsWith('#');
      if (isHeading && sectionLines.length > 0) {
        sections.push({ startIdx: sectionStart, lines: sectionLines });
        sectionStart = i;
        sectionLines = [];
      }
      sectionLines.push(lines[i]);
    }
    if (sectionLines.length > 0) {
      sections.push({ startIdx: sectionStart, lines: sectionLines });
    }

    for (const section of sections) {
      const sectionContent = section.lines.join('\n');
      const tokenCount = this.countTokens(sectionContent);

      if (tokenCount <= this.maxTokens) {
        chunks.push({
          content: sectionContent,
          startLine: section.startIdx + 1,
          endLine: section.startIdx + section.lines.length,
          tokenCount,
        });
      } else {
        // Section is too large — sub-chunk with token-split and adjust line numbers
        const subChunks = this.chunkByTokens(sectionContent, '', section.startIdx);
        chunks.push(...subChunks);
      }
    }

    return chunks;
  }

  // Greedy token-based chunking with overlap. lineOffset shifts output line
  // numbers when chunking a sub-section of a larger file (used by chunkByHeadings).
  private chunkByTokens(content: string, _filePath: string, lineOffset: number = 0): Chunk[] {
    const lines = content.split('\n');
    const chunks: Chunk[] = [];
    let startIdx = 0;

    while (startIdx < lines.length) {
      let endIdx = startIdx;
      let currentTokens = 0;

      // Expand chunk line by line until we hit the token limit
      while (endIdx < lines.length) {
        const lineText = endIdx < lines.length - 1 ? lines[endIdx] + '\n' : lines[endIdx];
        const lineTokens = this.countTokens(lineText);

        if (currentTokens + lineTokens > this.maxTokens && endIdx > startIdx) {
          break;
        }
        currentTokens += lineTokens;
        endIdx++;
      }

      const chunkContent = lines.slice(startIdx, endIdx).join('\n');
      chunks.push({
        content: chunkContent,
        startLine: lineOffset + startIdx + 1, // 1-based
        endLine: lineOffset + endIdx,          // 1-based, inclusive
        tokenCount: currentTokens,
      });

      if (endIdx >= lines.length) break;

      // Compute overlap: walk backwards from endIdx to find how many
      // lines fit within overlapTokens
      const overlapStart = this.findOverlapStart(lines, endIdx, this.overlapTokens);
      startIdx = overlapStart;

      // Guarantee forward progress
      if (startIdx <= chunks[chunks.length - 1].startLine - lineOffset - 1) {
        startIdx = endIdx;
      }
    }

    return chunks;
  }

  private findOverlapStart(lines: string[], endIdx: number, overlapTokens: number): number {
    let tokens = 0;
    let idx = endIdx;
    while (idx > 0) {
      idx--;
      const lineText = idx < lines.length - 1 ? lines[idx] + '\n' : lines[idx];
      tokens += this.countTokens(lineText);
      if (tokens >= overlapTokens) break;
    }
    return idx;
  }
}
