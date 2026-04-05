import { RetrievalResult } from './retriever';
import { ConfigManager } from '../config/configManager';

export class ContextBuilder {
  constructor(private readonly configManager: ConfigManager) {}

  format(results: RetrievalResult[]): string {
    if (results.length === 0) {
      return 'No relevant results found.';
    }

    const sections = results.map((result, index) => {
      const ds = this.configManager.getDataSource(result.chunk.dataSourceId);
      const repoLabel = ds ? `${ds.owner}/${ds.repo}` : 'unknown';
      const lineRange = `L${result.chunk.startLine}-L${result.chunk.endLine}`;

      return [
        `### Result ${index + 1} — ${repoLabel}`,
        `**File:** \`${result.chunk.filePath}\` (${lineRange})`,
        '',
        '```',
        result.chunk.content,
        '```',
      ].join('\n');
    });

    return sections.join('\n\n');
  }
}
