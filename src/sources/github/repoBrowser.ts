const GITHUB_API = 'https://api.github.com';

export interface RepoSearchResult {
  owner: string;
  repo: string;
  fullName: string;
  description: string | null;
  private: boolean;
  url: string;
}

export class RepoBrowser {
  constructor(private readonly getToken: () => Promise<string>) {}

  async listUserRepos(page: number = 1, perPage: number = 30): Promise<RepoSearchResult[]> {
    const token = await this.getToken();
    const res = await fetch(
      `${GITHUB_API}/user/repos?sort=updated&per_page=${perPage}&page=${page}`,
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
    const data = (await res.json()) as Array<{
      owner: { login: string };
      name: string;
      full_name: string;
      description: string | null;
      private: boolean;
      html_url: string;
    }>;
    return data.map((r) => ({
      owner: r.owner.login,
      repo: r.name,
      fullName: r.full_name,
      description: r.description,
      private: r.private,
      url: r.html_url,
    }));
  }

  async searchRepos(query: string, page: number = 1): Promise<RepoSearchResult[]> {
    const token = await this.getToken();
    const res = await fetch(
      `${GITHUB_API}/search/repositories?q=${encodeURIComponent(query)}&per_page=20&page=${page}`,
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
      items: Array<{
        owner: { login: string };
        name: string;
        full_name: string;
        description: string | null;
        private: boolean;
        html_url: string;
      }>;
    };
    return data.items.map((r) => ({
      owner: r.owner.login,
      repo: r.name,
      fullName: r.full_name,
      description: r.description,
      private: r.private,
      url: r.html_url,
    }));
  }
}
