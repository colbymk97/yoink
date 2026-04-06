import { RepoMetadata } from '../dataSource';

const GITHUB_API = 'https://api.github.com';

/**
 * Patterns that match GitHub HTTPS URLs.
 * Captures owner and repo from paths like:
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo/
 *   https://github.com/owner/repo.git
 *   https://github.com/owner/repo/tree/main
 */
const HTTPS_REPO_PATTERN = /^https?:\/\/github\.com\/([^/]+)\/([^/.]+?)(?:\.git)?(?:\/.*)?$/;

/** SSH URLs like git@github.com:owner/repo.git */
const SSH_REPO_PATTERN = /^git@github\.com:([^/]+)\/([^/.]+?)(?:\.git)?$/;

/** GitHub Enterprise URLs (not supported in v1) */
const ENTERPRISE_PATTERN = /^https?:\/\/(?!github\.com\b)[^/]+\/([^/]+)\/([^/]+)/;

export interface ParseRepoUrlResult {
  owner: string;
  repo: string;
}

export interface ParseRepoUrlError {
  error: string;
}

export function parseRepoUrl(url: string): ParseRepoUrlResult | ParseRepoUrlError {
  const trimmed = url.trim();

  if (!trimmed) {
    return { error: 'URL is empty' };
  }

  // Check SSH URLs — supported for parsing but we inform users to use HTTPS
  const sshMatch = trimmed.match(SSH_REPO_PATTERN);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  // Check GitHub Enterprise URLs
  if (ENTERPRISE_PATTERN.test(trimmed) && !trimmed.includes('github.com')) {
    return { error: 'GitHub Enterprise URLs are not supported in v1. Use a github.com URL.' };
  }

  // Standard HTTPS URL
  const httpsMatch = trimmed.match(HTTPS_REPO_PATTERN);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }

  return { error: 'Enter a valid GitHub repository URL (e.g. https://github.com/owner/repo)' };
}

/**
 * Type guard: returns true if the result is a successful parse.
 */
export function isRepoUrlResult(result: ParseRepoUrlResult | ParseRepoUrlError): result is ParseRepoUrlResult {
  return 'owner' in result;
}

export class GitHubResolver {
  constructor(private readonly getToken: () => Promise<string>) {}

  async resolve(owner: string, repo: string): Promise<RepoMetadata> {
    const token = await this.getToken();
    const res = await fetch(`${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
      headers: githubHeaders(token),
    });
    if (!res.ok) {
      if (res.status === 404) {
        throw new Error(`Repository ${owner}/${repo} not found. Check the URL and your access permissions.`);
      }
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

export function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}
