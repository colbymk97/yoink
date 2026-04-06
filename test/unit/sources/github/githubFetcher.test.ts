import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GitHubFetcher } from '../../../../src/sources/github/githubFetcher';

function makeFetcher() {
  return new GitHubFetcher(async () => 'test-token');
}

function mockResponse(data: object, status = 200, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Headers({
      'X-RateLimit-Remaining': '4999',
      'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + 3600),
      ...headers,
    }),
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

describe('GitHubFetcher', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('getTree', () => {
    it('returns blob entries from tree', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        mockResponse({
          tree: [
            { path: 'src/index.ts', sha: 'aaa', size: 100, type: 'blob' },
            { path: 'src', sha: 'bbb', size: 0, type: 'tree' },
            { path: 'src/util.ts', sha: 'ccc', size: 200, type: 'blob' },
          ],
          truncated: false,
        }),
      );

      const fetcher = makeFetcher();
      const { entries, truncated } = await fetcher.getTree('owner', 'repo', 'abc123');

      expect(entries).toHaveLength(2);
      expect(entries[0].path).toBe('src/index.ts');
      expect(entries[1].path).toBe('src/util.ts');
      expect(truncated).toBe(false);
    });

    it('reports truncated tree', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        mockResponse({ tree: [], truncated: true }),
      );

      const fetcher = makeFetcher();
      const { truncated } = await fetcher.getTree('owner', 'repo', 'abc');
      expect(truncated).toBe(true);
    });

    it('throws on API error', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        mockResponse({}, 403, {}),
      );

      const fetcher = makeFetcher();
      await expect(fetcher.getTree('owner', 'repo', 'abc')).rejects.toThrow('403');
    });
  });

  describe('getBlob', () => {
    it('returns file content as text', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'X-RateLimit-Remaining': '100', 'X-RateLimit-Reset': '9999999999' }),
        text: async () => 'const x = 1;',
      });

      const fetcher = makeFetcher();
      const content = await fetcher.getBlob('owner', 'repo', 'sha123');
      expect(content).toBe('const x = 1;');
    });

    it('sends raw content accept header', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'X-RateLimit-Remaining': '100', 'X-RateLimit-Reset': '9999999999' }),
        text: async () => '',
      });
      globalThis.fetch = fetchMock;

      const fetcher = makeFetcher();
      await fetcher.getBlob('owner', 'repo', 'sha');

      expect(fetchMock.mock.calls[0][1].headers.Accept).toBe(
        'application/vnd.github.raw+json',
      );
    });
  });

  describe('getBranchSha', () => {
    it('returns commit SHA for branch', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        mockResponse({ commit: { sha: 'deadbeef' } }),
      );

      const fetcher = makeFetcher();
      const sha = await fetcher.getBranchSha('owner', 'repo', 'main');
      expect(sha).toBe('deadbeef');
    });

    it('throws descriptive error on 404', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        mockResponse({}, 404),
      );

      const fetcher = makeFetcher();
      await expect(
        fetcher.getBranchSha('owner', 'repo', 'nonexistent'),
      ).rejects.toThrow('Branch "nonexistent" not found');
    });
  });

  describe('fetchFiles', () => {
    it('fetches eligible files concurrently', async () => {
      const fetchMock = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/trees/')) {
          return mockResponse({ tree: [], truncated: false });
        }
        // Blob requests
        const sha = url.split('/blobs/')[1];
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'X-RateLimit-Remaining': '100', 'X-RateLimit-Reset': '9999999999' }),
          text: async () => `content-of-${sha}`,
        };
      });
      globalThis.fetch = fetchMock;

      const fetcher = makeFetcher();
      const entries = [
        { path: 'a.ts', sha: 'aaa', size: 100, type: 'blob' as const },
        { path: 'b.ts', sha: 'bbb', size: 200, type: 'blob' as const },
      ];
      const files = await fetcher.fetchFiles('owner', 'repo', entries, 2);

      expect(files).toHaveLength(2);
      expect(files.find((f) => f.path === 'a.ts')?.content).toBe('content-of-aaa');
      expect(files.find((f) => f.path === 'b.ts')?.content).toBe('content-of-bbb');
    });

    it('skips binary file extensions', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'X-RateLimit-Remaining': '100', 'X-RateLimit-Reset': '9999999999' }),
        text: async () => 'content',
      });

      const fetcher = makeFetcher();
      const entries = [
        { path: 'image.png', sha: 'aaa', size: 100, type: 'blob' as const },
        { path: 'font.woff2', sha: 'bbb', size: 200, type: 'blob' as const },
        { path: 'code.ts', sha: 'ccc', size: 50, type: 'blob' as const },
      ];
      const files = await fetcher.fetchFiles('owner', 'repo', entries, 2);

      expect(files).toHaveLength(1);
      expect(files[0].path).toBe('code.ts');
    });

    it('skips files larger than 1MB', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'X-RateLimit-Remaining': '100', 'X-RateLimit-Reset': '9999999999' }),
        text: async () => 'content',
      });

      const fetcher = makeFetcher();
      const entries = [
        { path: 'huge.ts', sha: 'aaa', size: 2_000_000, type: 'blob' as const },
        { path: 'small.ts', sha: 'bbb', size: 500, type: 'blob' as const },
      ];
      const files = await fetcher.fetchFiles('owner', 'repo', entries, 2);

      expect(files).toHaveLength(1);
      expect(files[0].path).toBe('small.ts');
    });

    it('skips files that fail to fetch without throwing', async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            ok: false,
            status: 403,
            statusText: 'Forbidden',
            headers: new Headers({ 'X-RateLimit-Remaining': '100', 'X-RateLimit-Reset': '9999999999' }),
            text: async () => 'forbidden',
          };
        }
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'X-RateLimit-Remaining': '100', 'X-RateLimit-Reset': '9999999999' }),
          text: async () => 'good content',
        };
      });

      const fetcher = makeFetcher();
      const entries = [
        { path: 'forbidden.ts', sha: 'aaa', size: 100, type: 'blob' as const },
        { path: 'allowed.ts', sha: 'bbb', size: 100, type: 'blob' as const },
      ];
      const files = await fetcher.fetchFiles('owner', 'repo', entries, 1);

      // Should only get the file that succeeded
      expect(files).toHaveLength(1);
      expect(files[0].path).toBe('allowed.ts');
    });
  });

  describe('rate limit tracking', () => {
    it('tracks rate limit from response headers', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        mockResponse(
          { commit: { sha: 'abc' } },
          200,
          { 'X-RateLimit-Remaining': '42', 'X-RateLimit-Reset': '1700000000' },
        ),
      );

      const fetcher = makeFetcher();
      await fetcher.getBranchSha('owner', 'repo', 'main');

      const info = fetcher.getRateLimitInfo();
      expect(info.remaining).toBe(42);
      expect(info.resetAt.getTime()).toBe(1700000000 * 1000);
    });

    it('throws when rate limit is exhausted', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        mockResponse(
          { tree: [], truncated: false },
          200,
          {
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + 7200),
          },
        ),
      );

      const fetcher = makeFetcher();
      // First call succeeds but sets remaining to 0
      await fetcher.getTree('owner', 'repo', 'sha');

      // fetchFiles should throw because rate limit is exhausted
      const entries = [{ path: 'a.ts', sha: 'aaa', size: 10, type: 'blob' as const }];
      await expect(
        fetcher.fetchFiles('owner', 'repo', entries, 1),
      ).rejects.toThrow('rate limit exceeded');
    });
  });
});
