import { FetchedFile, FileTreeEntry } from '../dataSource';

const GITHUB_API = 'https://api.github.com';

export class GitHubFetcher {
  constructor(private readonly getToken: () => Promise<string>) {}

  async getTree(owner: string, repo: string, sha: string): Promise<FileTreeEntry[]> {
    const token = await this.getToken();
    const res = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`,
      { headers: this.headers(token) },
    );
    if (!res.ok) {
      throw new Error(`GitHub API error ${res.status}: ${res.statusText}`);
    }
    const data = (await res.json()) as { tree: FileTreeEntry[]; truncated: boolean };
    if (data.truncated) {
      // Tree is too large — logged but not fatal for v1
    }
    return data.tree.filter((entry) => entry.type === 'blob');
  }

  async getBlob(owner: string, repo: string, sha: string): Promise<string> {
    const token = await this.getToken();
    const res = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/git/blobs/${sha}`,
      { headers: { ...this.headers(token), Accept: 'application/vnd.github.raw+json' } },
    );
    if (!res.ok) {
      throw new Error(`GitHub API error ${res.status}: ${res.statusText}`);
    }
    return res.text();
  }

  async fetchFiles(
    owner: string,
    repo: string,
    entries: FileTreeEntry[],
    concurrency: number = 5,
  ): Promise<FetchedFile[]> {
    const results: FetchedFile[] = [];
    const queue = [...entries];

    const worker = async (): Promise<void> => {
      while (queue.length > 0) {
        const entry = queue.shift()!;
        const content = await this.getBlob(owner, repo, entry.sha);
        results.push({
          path: entry.path,
          content,
          sha: entry.sha,
          size: entry.size,
        });
      }
    };

    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, () => worker());
    await Promise.all(workers);
    return results;
  }

  async getBranchSha(owner: string, repo: string, branch: string): Promise<string> {
    const token = await this.getToken();
    const res = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`,
      { headers: this.headers(token) },
    );
    if (!res.ok) {
      throw new Error(`GitHub API error ${res.status}: ${res.statusText}`);
    }
    const data = (await res.json()) as { commit: { sha: string } };
    return data.commit.sha;
  }

  private headers(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }
}
