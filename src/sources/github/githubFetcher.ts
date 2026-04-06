import { FetchedFile, FileTreeEntry } from '../dataSource';
import { githubHeaders } from './githubResolver';

const GITHUB_API = 'https://api.github.com';

/**
 * Maximum file size (in bytes) to fetch. Files larger than this are
 * assumed to be binaries or generated artifacts and are skipped.
 */
const MAX_FILE_SIZE = 1_000_000; // 1 MB

/**
 * File extensions that are always skipped (binary / non-textual).
 */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.bmp', '.webp', '.svg',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.exe', '.dll', '.so', '.dylib', '.o', '.a', '.lib',
  '.wasm', '.pyc', '.class', '.jar',
  '.mp3', '.mp4', '.avi', '.mov', '.wav', '.flac',
  '.sqlite', '.db',
]);

export interface RateLimitInfo {
  remaining: number;
  resetAt: Date;
}

export class GitHubFetcher {
  private rateLimitRemaining: number = Infinity;
  private rateLimitResetAt: Date = new Date(0);

  constructor(private readonly getToken: () => Promise<string>) {}

  getRateLimitInfo(): RateLimitInfo {
    return {
      remaining: this.rateLimitRemaining,
      resetAt: this.rateLimitResetAt,
    };
  }

  async getTree(owner: string, repo: string, sha: string): Promise<{ entries: FileTreeEntry[]; truncated: boolean }> {
    const token = await this.getToken();
    const res = await fetch(
      `${GITHUB_API}/repos/${enc(owner)}/${enc(repo)}/git/trees/${enc(sha)}?recursive=1`,
      { headers: githubHeaders(token) },
    );
    this.updateRateLimit(res);

    if (!res.ok) {
      throw new Error(`GitHub Trees API error ${res.status}: ${res.statusText}`);
    }

    const data = (await res.json()) as { tree: FileTreeEntry[]; truncated: boolean };

    const blobs = data.tree.filter((entry) => entry.type === 'blob');
    return { entries: blobs, truncated: data.truncated };
  }

  async getBlob(owner: string, repo: string, sha: string): Promise<string> {
    const token = await this.getToken();
    const res = await fetch(
      `${GITHUB_API}/repos/${enc(owner)}/${enc(repo)}/git/blobs/${enc(sha)}`,
      {
        headers: {
          ...githubHeaders(token),
          Accept: 'application/vnd.github.raw+json',
        },
      },
    );
    this.updateRateLimit(res);

    if (!res.ok) {
      throw new Error(`GitHub Blobs API error ${res.status}: ${res.statusText}`);
    }

    return res.text();
  }

  async fetchFiles(
    owner: string,
    repo: string,
    entries: FileTreeEntry[],
    concurrency: number = 5,
  ): Promise<FetchedFile[]> {
    // Pre-filter: skip binary extensions and oversized files
    const eligible = entries.filter((entry) => {
      if (entry.size > MAX_FILE_SIZE) return false;
      const ext = extname(entry.path);
      return !BINARY_EXTENSIONS.has(ext);
    });

    const results: FetchedFile[] = [];
    const queue = [...eligible];

    const worker = async (): Promise<void> => {
      while (queue.length > 0) {
        // Check rate limit before each request
        await this.waitForRateLimit();

        const entry = queue.shift()!;
        try {
          const content = await this.getBlob(owner, repo, entry.sha);
          results.push({
            path: entry.path,
            content,
            sha: entry.sha,
            size: entry.size,
          });
        } catch {
          // Skip files that fail to fetch (permissions, encoding issues)
          // The caller handles missing files gracefully
        }
      }
    };

    const workerCount = Math.min(concurrency, queue.length);
    const workers = Array.from({ length: workerCount }, () => worker());
    await Promise.all(workers);
    return results;
  }

  async getBranchSha(owner: string, repo: string, branch: string): Promise<string> {
    const token = await this.getToken();
    const res = await fetch(
      `${GITHUB_API}/repos/${enc(owner)}/${enc(repo)}/branches/${enc(branch)}`,
      { headers: githubHeaders(token) },
    );
    this.updateRateLimit(res);

    if (!res.ok) {
      if (res.status === 404) {
        throw new Error(`Branch "${branch}" not found in ${owner}/${repo}.`);
      }
      throw new Error(`GitHub API error ${res.status}: ${res.statusText}`);
    }
    const data = (await res.json()) as { commit: { sha: string } };
    return data.commit.sha;
  }

  private updateRateLimit(res: Response): void {
    const remaining = res.headers.get('X-RateLimit-Remaining');
    const reset = res.headers.get('X-RateLimit-Reset');

    if (remaining !== null) {
      this.rateLimitRemaining = parseInt(remaining, 10);
    }
    if (reset !== null) {
      this.rateLimitResetAt = new Date(parseInt(reset, 10) * 1000);
    }
  }

  private async waitForRateLimit(): Promise<void> {
    if (this.rateLimitRemaining > 10) return;

    const waitMs = this.rateLimitResetAt.getTime() - Date.now();
    if (waitMs > 0 && waitMs < 120_000) {
      // Wait up to 2 minutes for rate limit reset
      await new Promise((resolve) => setTimeout(resolve, waitMs + 1000));
    } else if (this.rateLimitRemaining <= 0) {
      throw new Error(
        'GitHub API rate limit exceeded. Try again after ' +
        this.rateLimitResetAt.toISOString(),
      );
    }
  }
}

function enc(s: string): string {
  return encodeURIComponent(s);
}

function extname(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  if (dot === -1 || dot === filePath.length - 1) return '';
  return filePath.slice(dot).toLowerCase();
}
