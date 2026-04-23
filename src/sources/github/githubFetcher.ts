import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { extract as tarExtract } from 'tar-stream';
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

export interface BlobStreamOptions {
  concurrency?: number;
  onFileError?: (entry: FileTreeEntry, error: Error) => Promise<void> | void;
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

  /**
   * Fetch every eligible file in one API call by downloading the repo tarball.
   * Vastly cheaper than per-blob fetches for full re-indexes. The caller
   * supplies the tree entries it wants indexed (already filtered by the
   * data-source's include/exclude rules); this method applies the same
   * binary-extension and size caps `fetchFiles` uses.
   */
  async fetchAllFiles(
    owner: string,
    repo: string,
    sha: string,
    entries: FileTreeEntry[],
  ): Promise<FetchedFile[]> {
    const results: FetchedFile[] = [];
    await this.streamTarballFiles(owner, repo, sha, entries, async (file) => {
      results.push(file);
    });
    return results;
  }

  async streamTarballFiles(
    owner: string,
    repo: string,
    sha: string,
    entries: FileTreeEntry[],
    onFile: (file: FetchedFile) => Promise<void> | void,
  ): Promise<void> {
    const eligible = filterEligibleEntries(entries);
    if (eligible.length === 0) return;
    const allowedPaths = new Map(eligible.map((entry) => [entry.path, entry]));

    await this.waitForRateLimit();
    const token = await this.getToken();
    const res = await fetch(
      `${GITHUB_API}/repos/${enc(owner)}/${enc(repo)}/tarball/${enc(sha)}`,
      { headers: githubHeaders(token) },
    );
    this.updateRateLimit(res);

    if (!res.ok) {
      throw new Error(`GitHub Tarball API error ${res.status}: ${res.statusText}`);
    }
    if (!res.body) {
      throw new Error('GitHub Tarball API returned an empty body');
    }

    const extract = tarExtract();

    extract.on('entry', (header, stream, next) => {
      const firstSlash = header.name.indexOf('/');
      const relPath = firstSlash === -1 ? '' : header.name.slice(firstSlash + 1);
      const entry = relPath ? allowedPaths.get(relPath) : undefined;

      if (header.type !== 'file' || !entry) {
        stream.resume();
        stream.on('end', next);
        stream.on('error', next);
        return;
      }

      readStreamToBuffer(stream)
        .then(async (buf) => {
          await onFile({
            path: relPath,
            content: buf.toString('utf8'),
            sha: entry.sha,
            size: buf.length,
          });
          next();
        })
        .catch((err) => next(err as Error));
    });

    const nodeStream = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
    await streamPipeline(nodeStream, createGunzip(), extract);
  }

  async fetchFiles(
    owner: string,
    repo: string,
    entries: FileTreeEntry[],
    concurrency: number = 5,
  ): Promise<FetchedFile[]> {
    const results: FetchedFile[] = [];
    await this.streamBlobFiles(owner, repo, entries, async (file) => {
      results.push(file);
    }, { concurrency });
    return results;
  }

  async streamBlobFiles(
    owner: string,
    repo: string,
    entries: FileTreeEntry[],
    onFile: (file: FetchedFile) => Promise<void> | void,
    options: BlobStreamOptions = {},
  ): Promise<void> {
    const eligible = filterEligibleEntries(entries);
    const queue = [...eligible];
    const concurrency = options.concurrency ?? 5;

    const worker = async (): Promise<void> => {
      while (queue.length > 0) {
        await this.waitForRateLimit();
        const entry = queue.shift()!;
        try {
          const content = await this.getBlob(owner, repo, entry.sha);
          await onFile({
            path: entry.path,
            content,
            sha: entry.sha,
            size: entry.size,
          });
        } catch (err) {
          if (options.onFileError) {
            await options.onFileError(
              entry,
              err instanceof Error ? err : new Error(String(err)),
            );
          }
        }
      }
    };

    const workerCount = Math.min(concurrency, queue.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  }

  async getFileContents(owner: string, repo: string, path: string, branch: string): Promise<string> {
    await this.waitForRateLimit();
    const token = await this.getToken();
    const encodedPath = path.split('/').map(enc).join('/');
    const res = await fetch(
      `${GITHUB_API}/repos/${enc(owner)}/${enc(repo)}/contents/${encodedPath}?ref=${enc(branch)}`,
      {
        headers: {
          ...githubHeaders(token),
          Accept: 'application/vnd.github.raw+json',
        },
      },
    );
    this.updateRateLimit(res);

    if (!res.ok) {
      if (res.status === 404) {
        throw new Error(
          `File "${path}" was not found in ${owner}/${repo} on branch "${branch}". ` +
          `The path may have changed since the last index.`,
        );
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error(`Cannot access ${owner}/${repo}: insufficient token permissions.`);
      }
      throw new Error(`GitHub API error ${res.status}: ${res.statusText}`);
    }

    return res.text();
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

export function filterEligibleEntries(entries: FileTreeEntry[]): FileTreeEntry[] {
  return entries.filter((entry) => {
    if (entry.size > MAX_FILE_SIZE) return false;
    return !BINARY_EXTENSIONS.has(extname(entry.path));
  });
}

async function readStreamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function enc(s: string): string {
  return encodeURIComponent(s);
}

function extname(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  if (dot === -1 || dot === filePath.length - 1) return '';
  return filePath.slice(dot).toLowerCase();
}
