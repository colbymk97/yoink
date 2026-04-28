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
   * Hard per-input token cap imposed by the downstream embedding provider.
   * No chunk emitted by the chunker will exceed this. Provider-specific:
   * OpenAI/Azure cap at 8192; local/sentence-transformer models are often
   * much smaller (512). Defaults to 8000 for backward compatibility.
   */
  maxInputTokens: number;
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
const DEFAULT_MAX_INPUT_TOKENS = 8000;

export class Chunker {
  private readonly maxTokens: number;
  private readonly overlapTokens: number;
  private readonly maxInputTokens: number;
  private readonly countTokens: (text: string) => number;
  private readonly forcedStrategy?: ChunkingStrategy;
  private readonly astDeps?: AstChunkerDepsOption;

  constructor(options?: Partial<ChunkerOptions>) {
    this.maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.overlapTokens = options?.overlapTokens ?? DEFAULT_OVERLAP_TOKENS;
    this.maxInputTokens = options?.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS;
    this.countTokens = options?.countTokens ?? DEFAULT_COUNT_TOKENS;
    this.forcedStrategy = options?.strategy;
    this.astDeps = options?.astDeps;
  }

  async chunkFile(content: string, filePath: string): Promise<Chunk[]> {
    if (!content) return [];
    let strategy: ChunkingStrategy;
    if (this.forcedStrategy) {
      strategy = this.forcedStrategy;
    } else {
      strategy = Chunker.routeStrategy(filePath);
      if (strategy === 'ast-based' && !this.astDeps) {
        // Parser registry wasn't wired in — degrade gracefully rather than throw.
        strategy = 'token-split';
      }
    }
    const raw = await this.dispatch(strategy, content, filePath);
    const nonEmpty = raw.filter((c) => c.content.trim().length > 0);
    return this.enforceInputLimit(nonEmpty);
  }

  /**
   * Per-file routing table. Picks a chunking strategy based on path/extension.
   * Callers may override via the `strategy` option but should only do so for tests.
   */
  static routeStrategy(filePath: string): ChunkingStrategy {
    const normalizedPath = filePath.replace(/\\/g, '/');
    const lower = normalizedPath.toLowerCase();
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
    if (strategy === 'file-level') return this.chunkAsWhole(content, filePath);
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
  // where each file is a self-contained semantic unit. When the file exceeds
  // the embedding model's per-input limit, degrade along a filetype-aware path:
  // top-level YAML keys first (preserves `jobs`, `steps`, etc.), then token-split.
  private chunkAsWhole(content: string, filePath: string): Chunk[] {
    const tokenCount = this.countTokens(content);
    if (tokenCount <= this.maxInputTokens) {
      const lines = content.split('\n');
      return [{ content, startLine: 1, endLine: lines.length, tokenCount }];
    }
    if (/\.ya?ml$/i.test(filePath)) {
      const byKey = this.chunkYamlByTopLevelKeys(content);
      if (byKey !== null) return byKey;
    }
    return this.chunkByTokens(content, filePath);
  }

  // Split a YAML document into chunks keyed on top-level map entries
  // (lines matching `key:` in column 0). A block that's still too large
  // after this split is recursively reduced via token-split.
  private chunkYamlByTopLevelKeys(content: string): Chunk[] | null {
    const lines = content.split('\n');
    const keyLineRegex = /^[A-Za-z_][\w-]*:(\s|$)/;
    const boundaries: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (keyLineRegex.test(lines[i])) boundaries.push(i);
    }
    if (boundaries.length < 2) return null;

    if (boundaries[0] !== 0) boundaries.unshift(0);
    boundaries.push(lines.length);

    const chunks: Chunk[] = [];
    for (let i = 0; i < boundaries.length - 1; i++) {
      const startIdx = boundaries[i];
      const endIdx = boundaries[i + 1];
      const sectionContent = lines.slice(startIdx, endIdx).join('\n');
      if (!sectionContent.trim()) continue;
      const tokenCount = this.countTokens(sectionContent);
      if (tokenCount <= this.maxInputTokens) {
        chunks.push({
          content: sectionContent,
          startLine: startIdx + 1,
          endLine: endIdx,
          tokenCount,
        });
      } else {
        chunks.push(...this.chunkByTokens(sectionContent, '', startIdx));
      }
    }
    return chunks.length > 0 ? chunks : null;
  }

  // Final safety net. Any strategy can emit a chunk that still exceeds the
  // per-input limit if a single logical line is enormous (minified JS, inline
  // base64 blobs, generated docs). When that happens we've already exhausted
  // semantic splitting, so we divide by character count as a last resort.
  private enforceInputLimit(chunks: Chunk[]): Chunk[] {
    const out: Chunk[] = [];
    const queue = [...chunks];
    while (queue.length > 0) {
      const chunk = queue.shift()!;
      if (chunk.tokenCount <= this.maxInputTokens) {
        out.push(chunk);
        continue;
      }
      if (chunk.content.length <= 1) {
        out.push(chunk);
        continue;
      }

      const ratio = chunk.content.length / Math.max(chunk.tokenCount, 1);
      const estimatedMaxChars = Math.max(1, Math.floor(this.maxInputTokens * ratio * 0.9));
      const maxChars = Math.min(chunk.content.length - 1, estimatedMaxChars);

      let offset = 0;
      let lineCursor = chunk.startLine;
      while (offset < chunk.content.length) {
        const slice = chunk.content.slice(offset, offset + maxChars);
        const newlines = (slice.match(/\n/g) ?? []).length;
        const splitChunk: Chunk = {
          content: slice,
          startLine: lineCursor,
          endLine: lineCursor + newlines,
          tokenCount: this.countTokens(slice),
        };
        if (splitChunk.tokenCount > this.maxInputTokens && splitChunk.content.length > 1) {
          const midpoint = Math.floor(splitChunk.content.length / 2);
          const left = splitChunk.content.slice(0, midpoint);
          const right = splitChunk.content.slice(midpoint);
          const leftNewlines = (left.match(/\n/g) ?? []).length;
          queue.unshift(
            {
              content: right,
              startLine: splitChunk.startLine + leftNewlines,
              endLine: splitChunk.endLine,
              tokenCount: this.countTokens(right),
            },
            {
              content: left,
              startLine: splitChunk.startLine,
              endLine: splitChunk.startLine + leftNewlines,
              tokenCount: this.countTokens(left),
            },
          );
        } else {
          out.push(splitChunk);
        }
        lineCursor += newlines;
        offset += maxChars;
      }
    }
    return out;
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
