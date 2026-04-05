import { RepoMetadata } from '../dataSource';

const GITHUB_API = 'https://api.github.com';

const REPO_URL_PATTERN = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/?$/;

export function parseRepoUrl(url: string): { owner: string; repo: string } | null {
  const match = url.match(REPO_URL_PATTERN);
  if (!match) return null;
  return { owner: match[1], repo: match[2].replace(/\.git$/, '') };
}

export class GitHubResolver {
  constructor(private readonly getToken: () => Promise<string>) {}

  async resolve(owner: string, repo: string): Promise<RepoMetadata> {
    const token = await this.getToken();
    const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok) {
      throw new Error(`GitHub API error ${res.status}: ${res.statusText}`);
    }
    const data = (await res.json()) as {
      owner: { login: string };
      name: string;
      default_branch: string;
      description: string | null;
      private: boolean;
    };
    return {
      owner: data.owner.login,
      repo: data.name,
      defaultBranch: data.default_branch,
      description: data.description,
      private: data.private,
    };
  }
}
