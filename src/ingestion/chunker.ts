export interface Chunk {
  content: string;
  startLine: number;
  endLine: number;
  tokenCount: number;
}

export interface ChunkerOptions {
  maxTokens: number;
  overlapTokens: number;
  countTokens: (text: string) => number;
}

const DEFAULT_OPTIONS: ChunkerOptions = {
  maxTokens: 512,
  overlapTokens: 64,
  countTokens: (text: string) => Math.ceil(text.length / 4),
};

export class Chunker {
  private readonly options: ChunkerOptions;

  constructor(options?: Partial<ChunkerOptions>) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  chunkFile(content: string, _filePath: string): Chunk[] {
    const lines = content.split('\n');
    if (lines.length === 0) return [];

    const chunks: Chunk[] = [];
    let startIdx = 0;

    while (startIdx < lines.length) {
      let endIdx = startIdx;
      let currentTokens = 0;

      // Expand chunk until we hit the token limit
      while (endIdx < lines.length) {
        const lineTokens = this.options.countTokens(lines[endIdx] + '\n');
        if (currentTokens + lineTokens > this.options.maxTokens && endIdx > startIdx) {
          break;
        }
        currentTokens += lineTokens;
        endIdx++;
      }

      const chunkContent = lines.slice(startIdx, endIdx).join('\n');
      chunks.push({
        content: chunkContent,
        startLine: startIdx + 1,  // 1-based
        endLine: endIdx,          // 1-based, inclusive
        tokenCount: currentTokens,
      });

      // Advance with overlap
      const overlapLines = this.computeOverlapLines(lines, endIdx, this.options.overlapTokens);
      startIdx = endIdx - overlapLines;

      // Ensure forward progress
      if (startIdx <= chunks[chunks.length - 1].startLine - 1) {
        startIdx = endIdx;
      }
    }

    return chunks;
  }

  private computeOverlapLines(
    lines: string[],
    endIdx: number,
    overlapTokens: number,
  ): number {
    let tokens = 0;
    let count = 0;
    for (let i = endIdx - 1; i >= 0 && tokens < overlapTokens; i--) {
      tokens += this.options.countTokens(lines[i] + '\n');
      count++;
    }
    return count;
  }
}
