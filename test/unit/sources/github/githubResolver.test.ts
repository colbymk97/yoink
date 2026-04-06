import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parseRepoUrl, isRepoUrlResult, GitHubResolver } from '../../../../src/sources/github/githubResolver';

describe('parseRepoUrl', () => {
  it('parses standard HTTPS URL', () => {
    const result = parseRepoUrl('https://github.com/microsoft/vscode');
    expect(isRepoUrlResult(result)).toBe(true);
    if (isRepoUrlResult(result)) {
      expect(result.owner).toBe('microsoft');
      expect(result.repo).toBe('vscode');
    }
  });

  it('parses URL with trailing slash', () => {
    const result = parseRepoUrl('https://github.com/owner/repo/');
    expect(isRepoUrlResult(result)).toBe(true);
    if (isRepoUrlResult(result)) {
      expect(result.owner).toBe('owner');
      expect(result.repo).toBe('repo');
    }
  });

  it('parses URL with .git suffix', () => {
    const result = parseRepoUrl('https://github.com/owner/repo.git');
    expect(isRepoUrlResult(result)).toBe(true);
    if (isRepoUrlResult(result)) {
      expect(result.owner).toBe('owner');
      expect(result.repo).toBe('repo');
    }
  });

  it('parses URL with tree/branch path', () => {
    const result = parseRepoUrl('https://github.com/owner/repo/tree/main');
    expect(isRepoUrlResult(result)).toBe(true);
    if (isRepoUrlResult(result)) {
      expect(result.owner).toBe('owner');
      expect(result.repo).toBe('repo');
    }
  });

  it('parses URL with blob/file path', () => {
    const result = parseRepoUrl('https://github.com/owner/repo/blob/main/src/index.ts');
    expect(isRepoUrlResult(result)).toBe(true);
    if (isRepoUrlResult(result)) {
      expect(result.owner).toBe('owner');
      expect(result.repo).toBe('repo');
    }
  });

  it('parses HTTP URL (no TLS)', () => {
    const result = parseRepoUrl('http://github.com/owner/repo');
    expect(isRepoUrlResult(result)).toBe(true);
  });

  it('parses SSH URL', () => {
    const result = parseRepoUrl('git@github.com:owner/repo.git');
    expect(isRepoUrlResult(result)).toBe(true);
    if (isRepoUrlResult(result)) {
      expect(result.owner).toBe('owner');
      expect(result.repo).toBe('repo');
    }
  });

  it('parses SSH URL without .git', () => {
    const result = parseRepoUrl('git@github.com:owner/repo');
    expect(isRepoUrlResult(result)).toBe(true);
    if (isRepoUrlResult(result)) {
      expect(result.owner).toBe('owner');
      expect(result.repo).toBe('repo');
    }
  });

  it('rejects GitHub Enterprise URLs', () => {
    const result = parseRepoUrl('https://github.mycompany.com/owner/repo');
    expect(isRepoUrlResult(result)).toBe(false);
    if (!isRepoUrlResult(result)) {
      expect(result.error).toContain('Enterprise');
    }
  });

  it('rejects empty string', () => {
    const result = parseRepoUrl('');
    expect(isRepoUrlResult(result)).toBe(false);
    if (!isRepoUrlResult(result)) {
      expect(result.error).toContain('empty');
    }
  });

  it('rejects whitespace-only string', () => {
    const result = parseRepoUrl('   ');
    expect(isRepoUrlResult(result)).toBe(false);
  });

  it('rejects non-URL strings', () => {
    const result = parseRepoUrl('not a url');
    expect(isRepoUrlResult(result)).toBe(false);
  });

  it('rejects URL with only owner, no repo', () => {
    const result = parseRepoUrl('https://github.com/owner');
    expect(isRepoUrlResult(result)).toBe(false);
  });

  it('trims whitespace', () => {
    const result = parseRepoUrl('  https://github.com/owner/repo  ');
    expect(isRepoUrlResult(result)).toBe(true);
  });

  it('handles hyphens and underscores in names', () => {
    const result = parseRepoUrl('https://github.com/my-org/my_repo-v2');
    expect(isRepoUrlResult(result)).toBe(true);
    if (isRepoUrlResult(result)) {
      expect(result.owner).toBe('my-org');
      expect(result.repo).toBe('my_repo-v2');
    }
  });
});

describe('GitHubResolver', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('resolves repo metadata', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        owner: { login: 'microsoft' },
        name: 'vscode',
        default_branch: 'main',
        description: 'Visual Studio Code',
        private: false,
      }),
    });

    const resolver = new GitHubResolver(async () => 'token');
    const meta = await resolver.resolve('microsoft', 'vscode');

    expect(meta.owner).toBe('microsoft');
    expect(meta.repo).toBe('vscode');
    expect(meta.defaultBranch).toBe('main');
    expect(meta.description).toBe('Visual Studio Code');
    expect(meta.private).toBe(false);
  });

  it('throws descriptive error on 404', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    });

    const resolver = new GitHubResolver(async () => 'token');
    await expect(resolver.resolve('owner', 'nonexistent')).rejects.toThrow(
      'not found',
    );
  });

  it('sends correct auth headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        owner: { login: 'o' },
        name: 'r',
        default_branch: 'main',
        description: null,
        private: true,
      }),
    });
    globalThis.fetch = fetchMock;

    const resolver = new GitHubResolver(async () => 'my-secret-token');
    await resolver.resolve('o', 'r');

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers.Authorization).toBe('Bearer my-secret-token');
    expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28');
  });
});
