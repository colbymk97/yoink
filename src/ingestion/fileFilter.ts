import { minimatch } from 'minimatch';

export class FileFilter {
  constructor(
    private readonly includePatterns: string[],
    private readonly excludePatterns: string[],
  ) {}

  matches(filePath: string): boolean {
    // If include patterns are specified, file must match at least one
    if (this.includePatterns.length > 0) {
      const included = this.includePatterns.some((pattern) =>
        minimatch(filePath, pattern, { dot: true }),
      );
      if (!included) return false;
    }

    // File must not match any exclude pattern
    return !this.excludePatterns.some((pattern) =>
      minimatch(filePath, pattern, { dot: true }),
    );
  }

  filterPaths(paths: string[]): string[] {
    return paths.filter((p) => this.matches(p));
  }
}
