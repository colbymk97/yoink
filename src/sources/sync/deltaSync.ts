import { FileTreeEntry } from '../dataSource';

const GITHUB_API = 'https://api.github.com';

export interface DeltaSyncResult {
  added: FileTreeEntry[];
  modified: FileTreeEntry[];
  deleted: string[];       // file paths
  unchanged: string[];     // file paths
  newCommitSha: string;
}

export class DeltaSync {
  constructor(private readonly getToken: () => Promise<string>) {}

  async computeDelta(
    owner: string,
    repo: string,
    baseSha: string,
    headSha: string,
  ): Promise<DeltaSyncResult> {
    const token = await this.getToken();
    const res = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/compare/${baseSha}...${headSha}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );
    if (!res.ok) {
      throw new Error(`GitHub API error ${res.status}: ${res.statusText}`);
    }

    const data = (await res.json()) as {
      files: Array<{
        filename: string;
        status: 'added' | 'modified' | 'removed' | 'renamed';
        sha: string;
      }>;
    };

    const added: FileTreeEntry[] = [];
    const modified: FileTreeEntry[] = [];
    const deleted: string[] = [];

    for (const file of data.files) {
      switch (file.status) {
        case 'added':
          added.push({ path: file.filename, sha: file.sha, size: 0, type: 'blob' });
          break;
        case 'modified':
          modified.push({ path: file.filename, sha: file.sha, size: 0, type: 'blob' });
          break;
        case 'removed':
          deleted.push(file.filename);
          break;
        case 'renamed':
          // Treat rename as delete old + add new
          modified.push({ path: file.filename, sha: file.sha, size: 0, type: 'blob' });
          break;
      }
    }

    return { added, modified, deleted, unchanged: [], newCommitSha: headSha };
  }
}
