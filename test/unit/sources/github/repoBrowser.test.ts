import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RepoBrowser } from '../../../../src/sources/github/repoBrowser';

function mockResponse(data: object, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  };
}

const SAMPLE_REPOS = [
  {
    owner: { login: 'alice' },
    name: 'project-a',
    full_name: 'alice/project-a',
    description: 'First project',
    private: false,
    html_url: 'https://github.com/alice/project-a',
  },
  {
    owner: { login: 'alice' },
    name: 'project-b',
    full_name: 'alice/project-b',
    description: null,
    private: true,
    html_url: 'https://github.com/alice/project-b',
  },
];

describe('RepoBrowser', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('lists user repos', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(SAMPLE_REPOS));

    const browser = new RepoBrowser(async () => 'token');
    const repos = await browser.listUserRepos();

    expect(repos).toHaveLength(2);
    expect(repos[0].owner).toBe('alice');
    expect(repos[0].repo).toBe('project-a');
    expect(repos[0].fullName).toBe('alice/project-a');
    expect(repos[0].description).toBe('First project');
    expect(repos[0].private).toBe(false);
    expect(repos[1].private).toBe(true);
    expect(repos[1].description).toBeNull();
  });

  it('passes pagination params', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse([]));
    globalThis.fetch = fetchMock;

    const browser = new RepoBrowser(async () => 'token');
    await browser.listUserRepos(2, 10);

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('page=2');
    expect(url).toContain('per_page=10');
  });

  it('searches repos', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse({ items: SAMPLE_REPOS }),
    );

    const browser = new RepoBrowser(async () => 'token');
    const repos = await browser.searchRepos('typescript');

    expect(repos).toHaveLength(2);
  });

  it('encodes search query', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse({ items: [] }),
    );
    globalThis.fetch = fetchMock;

    const browser = new RepoBrowser(async () => 'token');
    await browser.searchRepos('react hooks language:typescript');

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('q=react%20hooks%20language%3Atypescript');
  });

  it('lists starred repos', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(SAMPLE_REPOS));

    const browser = new RepoBrowser(async () => 'token');
    const repos = await browser.listStarredRepos();

    expect(repos).toHaveLength(2);
  });

  it('throws on API error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse({}, 401),
    );

    const browser = new RepoBrowser(async () => 'bad-token');
    await expect(browser.listUserRepos()).rejects.toThrow('401');
  });
});
