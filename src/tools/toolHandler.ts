import * as vscode from 'vscode';
import { ConfigManager } from '../config/configManager';
import { EmbeddingProviderRegistry } from '../embedding/registry';
import { Retriever } from '../retrieval/retriever';
import { ContextBuilder } from '../retrieval/contextBuilder';
import { ChunkStore } from '../storage/chunkStore';
import { GitHubFetcher } from '../sources/github/githubFetcher';
import { SETTING_KEYS } from '../config/settingsSchema';

const MAX_LINES = 3000;
const MAX_CHARS = 80_000;

export class ToolHandler {
  constructor(
    private readonly configManager: ConfigManager,
    private readonly providerRegistry: EmbeddingProviderRegistry,
    private readonly retriever: Retriever,
    private readonly contextBuilder: ContextBuilder,
    private readonly chunkStore: ChunkStore,
    private readonly fetcher: GitHubFetcher,
  ) {}

  async handle(
    toolId: string,
    options: vscode.LanguageModelToolInvocationOptions<{ query: string }>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const tool = this.configManager.getTool(toolId);
    if (!tool) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Tool "${toolId}" not found.`),
      ]);
    }

    return this.executeSearch(options.input.query, tool.dataSourceIds);
  }

  async handleList(
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const dataSources = this.configManager.getDataSources();
    const tools = this.configManager.getTools();

    const lines: string[] = [];

    lines.push('## Data Sources');
    if (dataSources.length === 0) {
      lines.push('No data sources configured.');
    } else {
      for (const ds of dataSources) {
        let line = `- **${ds.owner}/${ds.repo}@${ds.branch}** (${ds.status})`;
        if (ds.status === 'ready') {
          const stats = this.chunkStore.getDataSourceStats(ds.id);
          line += ` — ${stats.fileCount} files, ${stats.chunkCount} chunks, ${stats.totalTokens.toLocaleString()} tokens`;
        }
        lines.push(line);
      }
    }

    lines.push('');
    lines.push('## Tools');
    if (tools.length === 0) {
      lines.push('No tools configured.');
    } else {
      for (const tool of tools) {
        const repos = tool.dataSourceIds
          .map((id) => {
            const ds = this.configManager.getDataSource(id);
            return ds ? `${ds.owner}/${ds.repo}@${ds.branch}` : null;
          })
          .filter((ref): ref is string => ref !== null)
          .join(', ');
        lines.push(`- **${tool.name}**: ${tool.description} → ${repos || '(no data sources)'}`);
      }
    }

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(lines.join('\n')),
    ]);
  }

  async handleGlobalSearch(
    options: vscode.LanguageModelToolInvocationOptions<{ query: string; repository?: string; tool?: string }>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const readySources = this.configManager
      .getDataSources()
      .filter((ds) => ds.status === 'ready');

    if (readySources.length === 0) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          'No repositories are indexed yet. Add a repository via the Yoink sidebar and wait for indexing to complete.',
        ),
      ]);
    }

    let targetIds: string[];
    const repoFilter = options.input.repository?.toLowerCase();
    const toolFilter = options.input.tool;

    // repository takes precedence over tool
    if (repoFilter) {
      const matched = readySources.filter(
        (ds) =>
          `${ds.owner}/${ds.repo}`.toLowerCase() === repoFilter ||
          ds.repo.toLowerCase() === repoFilter,
      );
      if (matched.length === 0) {
        const available = readySources.map((ds) => `${ds.owner}/${ds.repo}`).join(', ');
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            `Repository "${options.input.repository}" is not indexed. Indexed repositories: ${available}`,
          ),
        ]);
      }
      targetIds = matched.map((ds) => ds.id);
    } else if (toolFilter) {
      const tool = this.configManager.getTools().find(
        (t) => t.name.toLowerCase() === toolFilter.toLowerCase(),
      );
      if (!tool) {
        const available = this.configManager.getTools().map((t) => t.name).join(', ');
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            `Tool "${toolFilter}" not found.${available ? ` Available tools: ${available}` : ' No tools configured.'}`,
          ),
        ]);
      }
      targetIds = tool.dataSourceIds.filter((id) =>
        readySources.some((ds) => ds.id === id),
      );
      if (targetIds.length === 0) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            `Tool "${tool.name}" has no ready data sources. Wait for indexing to complete.`,
          ),
        ]);
      }
    } else {
      targetIds = readySources.map((ds) => ds.id);
    }

    const searchedRepos = readySources
      .filter((ds) => targetIds.includes(ds.id))
      .map((ds) => `${ds.owner}/${ds.repo}`)
      .join(', ');

    return this.executeSearch(options.input.query, targetIds, searchedRepos);
  }

  async handleGetFile(
    options: vscode.LanguageModelToolInvocationOptions<{
      repository: string;
      filePath: string;
      startLine?: number;
      endLine?: number;
    }>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { repository, filePath, startLine, endLine } = options.input;

    const ds = this.configManager
      .getDataSources()
      .find((s) => `${s.owner}/${s.repo}`.toLowerCase() === repository.toLowerCase());

    if (!ds) {
      const available = this.configManager
        .getDataSources()
        .map((s) => `${s.owner}/${s.repo}`)
        .join(', ') || 'none';
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Repository "${repository}" is not indexed. Indexed repositories: ${available}`,
        ),
      ]);
    }

    try {
      const raw = await this.fetcher.getFileContents(ds.owner, ds.repo, filePath, ds.branch);
      const lines = raw.split('\n');
      const totalLines = lines.length;

      let sliced: string[];
      let rangeStart: number;
      let rangeEnd: number;
      let truncated = false;

      if (startLine !== undefined && endLine !== undefined) {
        rangeStart = Math.max(1, startLine);
        rangeEnd = Math.min(totalLines, endLine);
        sliced = lines.slice(rangeStart - 1, rangeEnd);
      } else {
        rangeStart = 1;
        let charCount = 0;
        let cutAt = lines.length;
        for (let i = 0; i < lines.length; i++) {
          charCount += lines[i].length + 1;
          if (i + 1 === MAX_LINES || charCount >= MAX_CHARS) {
            cutAt = i + 1;
            break;
          }
        }
        truncated = cutAt < totalLines;
        sliced = lines.slice(0, cutAt);
        rangeEnd = cutAt;
      }

      const lang = langHint(filePath);
      const header =
        `**${ds.owner}/${ds.repo}** · Branch: \`${ds.branch}\` · \`${filePath}\`\n` +
        `Lines ${rangeStart}–${rangeEnd} of ${totalLines}`;
      const body = `\`\`\`${lang}\n${sliced.join('\n')}\n\`\`\``;
      const notice = truncated
        ? `\n[File truncated — showing lines 1–${rangeEnd} of ${totalLines}. ` +
          `Call again with startLine/endLine to fetch a specific range.]`
        : '';

      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`${header}\n\n${body}${notice}`),
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(message),
      ]);
    }
  }

  async handleListWorkflows(
    options: vscode.LanguageModelToolInvocationOptions<{ repository?: string }>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const sources = this.getReadySources(options.input.repository);
    if (typeof sources === 'string') {
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(sources)]);
    }

    const lines: string[] = [];
    for (const ds of sources) {
      const fileStats = this.chunkStore.getFileStats(ds.id);
      const workflowFiles = fileStats.filter(
        (f) =>
          f.filePath.includes('.github/workflows/') &&
          (f.filePath.endsWith('.yml') || f.filePath.endsWith('.yaml')),
      );
      if (workflowFiles.length === 0) continue;

      const contentMap = buildContentMap(this.chunkStore.getByDataSource(ds.id));

      lines.push(`## ${ds.owner}/${ds.repo}`);
      for (const { filePath } of workflowFiles) {
        const content = contentMap.get(filePath) ?? '';
        const name = extractYamlScalar(content, 'name');
        const triggers = extractWorkflowTriggers(content);
        const label = name ? `**${name}**` : filePath.split('/').pop() ?? filePath;
        const triggerStr = triggers.length > 0 ? ` · triggers: ${triggers.map((t) => `\`${t}\``).join(', ')}` : '';
        lines.push(`- \`${filePath}\` — ${label}${triggerStr}`);
      }
      lines.push('');
    }

    if (lines.length === 0) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart('No workflow files found in indexed repositories.'),
      ]);
    }

    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(lines.join('\n'))]);
  }

  async handleListActions(
    options: vscode.LanguageModelToolInvocationOptions<{ repository?: string }>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const sources = this.getReadySources(options.input.repository);
    if (typeof sources === 'string') {
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(sources)]);
    }

    const lines: string[] = [];
    for (const ds of sources) {
      const fileStats = this.chunkStore.getFileStats(ds.id);
      const actionFiles = fileStats.filter(
        (f) =>
          f.filePath === 'action.yml' ||
          f.filePath === 'action.yaml' ||
          f.filePath.endsWith('/action.yml') ||
          f.filePath.endsWith('/action.yaml'),
      );
      if (actionFiles.length === 0) continue;

      const contentMap = buildContentMap(this.chunkStore.getByDataSource(ds.id));

      lines.push(`## ${ds.owner}/${ds.repo}`);
      for (const { filePath } of actionFiles) {
        const content = contentMap.get(filePath) ?? '';
        const name = extractYamlScalar(content, 'name');
        const description = extractYamlScalar(content, 'description');
        const inputs = extractActionInputs(content);
        const label = name ? `**${name}**` : filePath;
        const descStr = description ? ` · ${description}` : '';
        lines.push(`- \`${filePath}\` — ${label}${descStr}`);
        if (inputs.length > 0) {
          const inputStr = inputs
            .map((i) => (i.required ? `\`${i.name}\` (required)` : `\`${i.name}\``))
            .join(', ');
          lines.push(`  Inputs: ${inputStr}`);
        }
      }
      lines.push('');
    }

    if (lines.length === 0) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart('No composite actions found in indexed repositories.'),
      ]);
    }

    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(lines.join('\n'))]);
  }

  private getReadySources(repositoryFilter?: string): import('../config/configSchema').DataSourceConfig[] | string {
    const readySources = this.configManager
      .getDataSources()
      .filter((ds) => ds.status === 'ready');

    if (readySources.length === 0) {
      return 'No repositories are indexed yet. Add a repository via the Yoink sidebar and wait for indexing to complete.';
    }

    if (!repositoryFilter) return readySources;

    const filter = repositoryFilter.toLowerCase();
    const matched = readySources.filter(
      (ds) =>
        `${ds.owner}/${ds.repo}`.toLowerCase() === filter ||
        ds.repo.toLowerCase() === filter,
    );

    if (matched.length === 0) {
      const available = readySources.map((ds) => `${ds.owner}/${ds.repo}`).join(', ');
      return `Repository "${repositoryFilter}" is not indexed. Indexed repositories: ${available}`;
    }

    return matched;
  }

  private async executeSearch(
    query: string,
    dataSourceIds: string[],
    searchedRepos?: string,
  ): Promise<vscode.LanguageModelToolResult> {
    try {
      const topK = vscode.workspace
        .getConfiguration()
        .get<number>(SETTING_KEYS.SEARCH_TOP_K, 10);

      const provider = await this.providerRegistry.getProvider();
      const results = await this.retriever.search(query, dataSourceIds, provider, topK);
      const formatted = this.contextBuilder.format(results);

      const header = searchedRepos
        ? `*Searched repositories: ${searchedRepos}*\n\n`
        : '';

      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(header + formatted),
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Search failed: ${message}`),
      ]);
    }
  }
}

function buildContentMap(chunks: import('../storage/chunkStore').ChunkRecord[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const chunk of chunks) {
    if (!map.has(chunk.filePath)) {
      map.set(chunk.filePath, chunk.content);
    }
  }
  return map;
}

function extractYamlScalar(content: string, key: string): string | null {
  const match = content.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return match ? match[1].trim().replace(/^['"]|['"]$/g, '') : null;
}

function extractWorkflowTriggers(content: string): string[] {
  // Inline array: on: [push, pull_request]
  const inlineMatch = content.match(/^on:\s*\[([^\]]+)\]/m);
  if (inlineMatch) {
    return inlineMatch[1].split(',').map((s) => s.trim()).filter(Boolean);
  }
  // Single string: on: push
  const stringMatch = content.match(/^on:\s*(\w[\w_-]*)\s*$/m);
  if (stringMatch) return [stringMatch[1]];
  // Block mapping: on:\n  push:\n  pull_request:
  const blockMatch = content.match(/^on:\s*\n((?:[ \t]+\S[^\n]*\n?)+)/m);
  if (blockMatch) {
    return [...blockMatch[1].matchAll(/^[ \t]{2}(\w[\w_-]*):/mg)].map((m) => m[1]);
  }
  return [];
}

function extractActionInputs(content: string): Array<{ name: string; required: boolean }> {
  const blockMatch = content.match(/^inputs:\s*\n((?:[ \t]+\S[^\n]*\n?)*)/m);
  if (!blockMatch) return [];

  const inputs: Array<{ name: string; required: boolean }> = [];
  const block = blockMatch[1];
  const keyMatches = [...block.matchAll(/^  (\w[\w-]*):\s*$/mg)];

  for (let i = 0; i < keyMatches.length; i++) {
    const name = keyMatches[i][1];
    const start = keyMatches[i].index! + keyMatches[i][0].length;
    const end = i + 1 < keyMatches.length ? keyMatches[i + 1].index! : block.length;
    const subBlock = block.slice(start, end);
    const required = /required:\s*true/.test(subBlock);
    inputs.push({ name, required });
  }

  return inputs;
}

function langHint(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  if (dot === -1) return '';
  const ext = filePath.slice(dot + 1).toLowerCase();
  const map: Record<string, string> = {
    ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js',
    py: 'py', rb: 'rb', go: 'go', rs: 'rs',
    java: 'java', kt: 'kt', cs: 'cs', cpp: 'cpp', c: 'c', h: 'h',
    json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
    md: 'md', html: 'html', css: 'css', scss: 'scss',
    sh: 'sh', bash: 'sh', zsh: 'sh',
    sql: 'sql', graphql: 'graphql',
  };
  return map[ext] ?? '';
}
