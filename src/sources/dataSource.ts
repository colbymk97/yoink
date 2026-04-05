export interface FetchedFile {
  path: string;
  content: string;
  sha: string;
  size: number;
}

export interface FileTreeEntry {
  path: string;
  sha: string;
  size: number;
  type: 'blob' | 'tree';
}

export interface RepoMetadata {
  owner: string;
  repo: string;
  defaultBranch: string;
  description: string | null;
  private: boolean;
}
