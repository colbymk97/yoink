import { githubHeaders } from './githubResolver';

const GITHUB_API = 'https://api.github.com';
const USER_REPO_CACHE_TTL_MS = 5 * 60 * 1000;

export interface RepoSearchResult {
  owner: string;
  repo: string;
  fullName: string;
  description: string | null;
  private: boolean;
  url: string;
}

export class RepoBrowser {
  private userRepoCache: { repos: RepoSearchResult[]; fetchedAt: number } | undefined;
  private userRepoLoad: Promise<RepoSearchResult[]> | undefined;

  constructor(private readonly getToken: () => Promise<string>) {}

  async listUserRepos(page: number = 1, perPage: number = 30): Promise<RepoSearchResult[]> {
    const token = await this.getToken();
    const res = await fetch(
      `${GITHUB_API}/user/repos?sort=updated&per_page=${perPage}&page=${page}`,
      { headers: githubHeaders(token) },
    );
    if (!res.ok) {
      throw new Error(`GitHub API error ${res.status}: ${res.statusText}`);
    }
    return (await res.json() as RepoListItem[]).map(mapRepoItem);
  }

  hasFreshUserRepoCache(now: number = Date.now()): boolean {
    return this.userRepoCache !== undefined &&
      now - this.userRepoCache.fetchedAt < USER_REPO_CACHE_TTL_MS;
  }

  async listAllUserRepos(options: { forceRefresh?: boolean } = {}): Promise<RepoSearchResult[]> {
    if (!options.forceRefresh && this.hasFreshUserRepoCache()) {
      return [...this.userRepoCache!.repos];
    }

    if (!options.forceRefresh && this.userRepoLoad) {
      return [...await this.userRepoLoad];
    }

    this.userRepoLoad = this.fetchAllUserRepos();
    try {
      const repos = await this.userRepoLoad;
      this.userRepoCache = { repos, fetchedAt: Date.now() };
      return [...repos];
    } finally {
      this.userRepoLoad = undefined;
    }
  }

  private async fetchAllUserRepos(): Promise<RepoSearchResult[]> {
    const all: RepoSearchResult[] = [];
    let page = 1;
    while (true) {
      const batch = await this.listUserRepos(page, 100);
      all.push(...batch);
      if (batch.length < 100) break;
      page++;
    }
    return all;
  }

  async listStarredRepos(page: number = 1, perPage: number = 30): Promise<RepoSearchResult[]> {
    const token = await this.getToken();
    const res = await fetch(
      `${GITHUB_API}/user/starred?sort=updated&per_page=${perPage}&page=${page}`,
      { headers: githubHeaders(token) },
    );
    if (!res.ok) {
      throw new Error(`GitHub API error ${res.status}: ${res.statusText}`);
    }
    return (await res.json() as RepoListItem[]).map(mapRepoItem);
  }

  async searchRepos(query: string, page: number = 1): Promise<RepoSearchResult[]> {
    const token = await this.getToken();
    const res = await fetch(
      `${GITHUB_API}/search/repositories?q=${encodeURIComponent(query)}&per_page=20&page=${page}`,
      { headers: githubHeaders(token) },
    );
    if (!res.ok) {
      throw new Error(`GitHub API error ${res.status}: ${res.statusText}`);
    }
    const data = (await res.json()) as { items: RepoListItem[] };
    return data.items.map(mapRepoItem);
  }
}

interface RepoListItem {
  owner: { login: string };
  name: string;
  full_name: string;
  description: string | null;
  private: boolean;
  html_url: string;
}

function mapRepoItem(r: RepoListItem): RepoSearchResult {
  return {
    owner: r.owner.login,
    repo: r.name,
    fullName: r.full_name,
    description: r.description,
    private: r.private,
    url: r.html_url,
  };
}
