import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EmbeddingProvider } from '../../src/embedding/embeddingProvider';
import { ChunkRecord } from '../../src/storage/chunkStore';

export type SearchEvalIntent =
  | 'semantic-paraphrase'
  | 'identifier-exact'
  | 'path-structure'
  | 'docs-howto'
  | 'workflow-action'
  | 'implementation-location'
  | 'change-impact';

export type SearchEvalFailureBucket =
  | 'semantic-ranking'
  | 'keyword-ranking'
  | 'path-boost'
  | 'snippet-insufficient'
  | 'duplicate-crowding'
  | 'answerability-gap'
  | 'task-navigation';

export type SearchEvalRepoType =
  | 'application'
  | 'documentation'
  | 'platform'
  | 'actions'
  | 'real-snapshot';

export interface SearchEvalDataSource {
  id: string;
  owner: string;
  repo: string;
  branch: string;
  repoType: SearchEvalRepoType;
}

export interface SearchEvalChunk extends ChunkRecord {
  embedding: number[];
}

export interface SearchEvalCorpus {
  dimensions: number;
  dataSources: SearchEvalDataSource[];
  chunks: SearchEvalChunk[];
}

export interface SearchEvalRelevantFile {
  repository: string;
  filePath: string;
  grade: number;
}

export interface SearchEvalRelevantChunk {
  chunkId: string;
  grade: number;
}

export interface SearchEvalEvidence {
  repository: string;
  filePath: string;
  chunkId?: string;
  mustMention?: string[];
}

export interface SearchEvalQuery {
  id: string;
  repository: string | null;
  query: string;
  intent: SearchEvalIntent;
  embedding: number[];
  relevantFiles: SearchEvalRelevantFile[];
  relevantChunks?: SearchEvalRelevantChunk[];
  failureBucket?: SearchEvalFailureBucket;
}

export interface SearchEvalAnswerabilityPrompt {
  id: string;
  repository: string | null;
  query: string;
  question: string;
  intent: SearchEvalIntent;
  embedding: number[];
  goldAnswer: string;
  acceptableFiles: SearchEvalRelevantFile[];
  requiredEvidence: SearchEvalEvidence[];
  failureBucket: SearchEvalFailureBucket;
  topKVariants?: number[];
}

export interface SearchEvalTaskScenario {
  id: string;
  repository: string | null;
  searchQuery: string;
  question: string;
  intent: SearchEvalIntent;
  embedding: number[];
  acceptableFiles: SearchEvalRelevantFile[];
  requiredEvidence: SearchEvalEvidence[];
  goldAnswer: string;
  failureBucket: SearchEvalFailureBucket;
  taskSteps: string[];
  maxFilesToFetch?: number;
}

export interface SearchEvalDataset {
  corpus: SearchEvalCorpus;
  queries: SearchEvalQuery[];
  answerabilityPrompts: SearchEvalAnswerabilityPrompt[];
  taskScenarios: SearchEvalTaskScenario[];
}

const FIXTURE_DIR = resolve(__dirname, '../fixtures/search-eval');

export function loadSearchEvalDataset(): SearchEvalDataset {
  const corpus = parseCorpus(
    JSON.parse(readFileSync(resolve(FIXTURE_DIR, 'corpus.json'), 'utf8')) as unknown,
  );
  const queryFiles = listFixtureFiles(/^queries.*\.json$/);
  const answerabilityFiles = listFixtureFiles(/^answerability.*\.json$/);
  const taskFiles = listFixtureFiles(/^tasks.*\.json$/);

  const queries = queryFiles.flatMap((file) =>
    parseQueries(JSON.parse(readFileSync(file, 'utf8')) as unknown, corpus.dimensions),
  );
  const answerabilityPrompts = answerabilityFiles.flatMap((file) =>
    parseAnswerabilityPrompts(JSON.parse(readFileSync(file, 'utf8')) as unknown, corpus.dimensions),
  );
  const taskScenarios = taskFiles.flatMap((file) =>
    parseTaskScenarios(JSON.parse(readFileSync(file, 'utf8')) as unknown, corpus.dimensions),
  );

  return { corpus, queries, answerabilityPrompts, taskScenarios };
}

export function makeSearchEvalProvider(dataset: SearchEvalDataset): EmbeddingProvider {
  const promptEmbeddings = new Map<string, number[]>();
  for (const query of dataset.queries) promptEmbeddings.set(query.query, query.embedding);
  for (const prompt of dataset.answerabilityPrompts) promptEmbeddings.set(prompt.query, prompt.embedding);
  for (const task of dataset.taskScenarios) promptEmbeddings.set(task.searchQuery, task.embedding);

  return {
    id: 'search-eval-fixture',
    maxBatchSize: 100,
    maxInputTokens: 16000,
    dimensions: dataset.corpus.dimensions,
    embed: async (texts: string[]) =>
      texts.map((text) => {
        const embedding = promptEmbeddings.get(text);
        if (!embedding) {
          throw new Error(`Missing search-eval embedding for prompt: ${text}`);
        }
        return embedding;
      }),
    countTokens: (text: string) => Math.ceil(text.length / 4),
  };
}

export function buildRepoMaps(dataset: SearchEvalDataset): {
  repoByDataSourceId: Map<string, string>;
  dataSourceIdByRepo: Map<string, string>;
  repoTypeByRepo: Map<string, SearchEvalRepoType>;
} {
  const repoByDataSourceId = new Map(
    dataset.corpus.dataSources.map((source) => [source.id, `${source.owner}/${source.repo}`]),
  );
  const dataSourceIdByRepo = new Map(
    dataset.corpus.dataSources.map((source) => [`${source.owner}/${source.repo}`, source.id]),
  );
  const repoTypeByRepo = new Map(
    dataset.corpus.dataSources.map((source) => [`${source.owner}/${source.repo}`, source.repoType]),
  );

  return { repoByDataSourceId, dataSourceIdByRepo, repoTypeByRepo };
}

export function buildFileContentsByFile(dataset: SearchEvalDataset): Map<string, string> {
  const grouped = new Map<string, SearchEvalChunk[]>();
  for (const chunk of dataset.corpus.chunks) {
    const key = `${chunk.dataSourceId}:${chunk.filePath}`;
    const chunks = grouped.get(key) ?? [];
    chunks.push(chunk);
    grouped.set(key, chunks);
  }

  const fileContents = new Map<string, string>();
  for (const [key, chunks] of grouped) {
    const content = [...chunks]
      .sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine)
      .map((chunk) => chunk.content)
      .join('\n');
    fileContents.set(key, content);
  }
  return fileContents;
}

function listFixtureFiles(pattern: RegExp): string[] {
  return readdirSync(FIXTURE_DIR)
    .filter((name) => pattern.test(name))
    .map((name) => resolve(FIXTURE_DIR, name))
    .sort();
}

function parseCorpus(input: unknown): SearchEvalCorpus {
  if (!isRecord(input)) {
    throw new Error('search-eval corpus must be an object');
  }

  const dimensions = asNumber(input.dimensions, 'corpus.dimensions');
  const dataSources = asArray(input.dataSources, 'corpus.dataSources').map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`corpus.dataSources[${index}] must be an object`);
    }
    return {
      id: asString(entry.id, `corpus.dataSources[${index}].id`),
      owner: asString(entry.owner, `corpus.dataSources[${index}].owner`),
      repo: asString(entry.repo, `corpus.dataSources[${index}].repo`),
      branch: asString(entry.branch, `corpus.dataSources[${index}].branch`),
      repoType: asRepoType(entry.repoType, `corpus.dataSources[${index}].repoType`),
    };
  });
  const chunks = asArray(input.chunks, 'corpus.chunks').map((entry, index) =>
    parseChunk(entry, index, dimensions),
  );

  return { dimensions, dataSources, chunks };
}

function parseQueries(input: unknown, dimensions: number): SearchEvalQuery[] {
  return asArray(input, 'queries').map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`queries[${index}] must be an object`);
    }

    return {
      id: asString(entry.id, `queries[${index}].id`),
      repository: nullableString(entry.repository, `queries[${index}].repository`),
      query: asString(entry.query, `queries[${index}].query`),
      intent: asIntent(entry.intent, `queries[${index}].intent`),
      embedding: asEmbedding(entry.embedding, `queries[${index}].embedding`, dimensions),
      relevantFiles: asArray(entry.relevantFiles, `queries[${index}].relevantFiles`).map(
        (file, fileIndex) => parseRelevantFile(file, index, fileIndex),
      ),
      relevantChunks:
        entry.relevantChunks === undefined
          ? undefined
          : asArray(entry.relevantChunks, `queries[${index}].relevantChunks`).map(
            (chunk, chunkIndex) => parseRelevantChunk(chunk, index, chunkIndex),
          ),
      failureBucket:
        entry.failureBucket === undefined
          ? undefined
          : asFailureBucket(entry.failureBucket, `queries[${index}].failureBucket`),
    };
  });
}

function parseAnswerabilityPrompts(
  input: unknown,
  dimensions: number,
): SearchEvalAnswerabilityPrompt[] {
  return asArray(input, 'answerability').map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`answerability[${index}] must be an object`);
    }

    return {
      id: asString(entry.id, `answerability[${index}].id`),
      repository: nullableString(entry.repository, `answerability[${index}].repository`),
      query: asString(entry.query, `answerability[${index}].query`),
      question: asString(entry.question, `answerability[${index}].question`),
      intent: asIntent(entry.intent, `answerability[${index}].intent`),
      embedding: asEmbedding(entry.embedding, `answerability[${index}].embedding`, dimensions),
      goldAnswer: asString(entry.goldAnswer, `answerability[${index}].goldAnswer`),
      acceptableFiles: asArray(entry.acceptableFiles, `answerability[${index}].acceptableFiles`).map(
        (file, fileIndex) => parseRelevantFile(file, index, fileIndex, 'answerability'),
      ),
      requiredEvidence: asArray(entry.requiredEvidence, `answerability[${index}].requiredEvidence`).map(
        (evidence, evidenceIndex) => parseEvidence(evidence, index, evidenceIndex, 'answerability'),
      ),
      failureBucket: asFailureBucket(
        entry.failureBucket,
        `answerability[${index}].failureBucket`,
      ),
      topKVariants:
        entry.topKVariants === undefined
          ? undefined
          : asArray(entry.topKVariants, `answerability[${index}].topKVariants`).map((value, valueIndex) =>
            asNumber(value, `answerability[${index}].topKVariants[${valueIndex}]`),
          ),
    };
  });
}

function parseTaskScenarios(
  input: unknown,
  dimensions: number,
): SearchEvalTaskScenario[] {
  return asArray(input, 'tasks').map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`tasks[${index}] must be an object`);
    }

    return {
      id: asString(entry.id, `tasks[${index}].id`),
      repository: nullableString(entry.repository, `tasks[${index}].repository`),
      searchQuery: asString(entry.searchQuery, `tasks[${index}].searchQuery`),
      question: asString(entry.question, `tasks[${index}].question`),
      intent: asIntent(entry.intent, `tasks[${index}].intent`),
      embedding: asEmbedding(entry.embedding, `tasks[${index}].embedding`, dimensions),
      acceptableFiles: asArray(entry.acceptableFiles, `tasks[${index}].acceptableFiles`).map(
        (file, fileIndex) => parseRelevantFile(file, index, fileIndex, 'tasks'),
      ),
      requiredEvidence: asArray(entry.requiredEvidence, `tasks[${index}].requiredEvidence`).map(
        (evidence, evidenceIndex) => parseEvidence(evidence, index, evidenceIndex, 'tasks'),
      ),
      goldAnswer: asString(entry.goldAnswer, `tasks[${index}].goldAnswer`),
      failureBucket: asFailureBucket(entry.failureBucket, `tasks[${index}].failureBucket`),
      taskSteps: asArray(entry.taskSteps, `tasks[${index}].taskSteps`).map((step, stepIndex) =>
        asString(step, `tasks[${index}].taskSteps[${stepIndex}]`),
      ),
      maxFilesToFetch:
        entry.maxFilesToFetch === undefined
          ? undefined
          : asNumber(entry.maxFilesToFetch, `tasks[${index}].maxFilesToFetch`),
    };
  });
}

function parseChunk(input: unknown, index: number, dimensions: number): SearchEvalChunk {
  if (!isRecord(input)) {
    throw new Error(`corpus.chunks[${index}] must be an object`);
  }

  return {
    id: asString(input.id, `corpus.chunks[${index}].id`),
    dataSourceId: asString(input.dataSourceId, `corpus.chunks[${index}].dataSourceId`),
    filePath: asString(input.filePath, `corpus.chunks[${index}].filePath`),
    startLine: asNumber(input.startLine, `corpus.chunks[${index}].startLine`),
    endLine: asNumber(input.endLine, `corpus.chunks[${index}].endLine`),
    tokenCount: asNumber(input.tokenCount, `corpus.chunks[${index}].tokenCount`),
    content: asString(input.content, `corpus.chunks[${index}].content`),
    embedding: asEmbedding(input.embedding, `corpus.chunks[${index}].embedding`, dimensions),
  };
}

function parseRelevantFile(
  input: unknown,
  groupIndex: number,
  fileIndex: number,
  namespace = 'queries',
): SearchEvalRelevantFile {
  if (!isRecord(input)) {
    throw new Error(`${namespace}[${groupIndex}].relevantFiles[${fileIndex}] must be an object`);
  }

  return {
    repository: asString(
      input.repository,
      `${namespace}[${groupIndex}].relevantFiles[${fileIndex}].repository`,
    ),
    filePath: asString(
      input.filePath,
      `${namespace}[${groupIndex}].relevantFiles[${fileIndex}].filePath`,
    ),
    grade: asNumber(input.grade, `${namespace}[${groupIndex}].relevantFiles[${fileIndex}].grade`),
  };
}

function parseRelevantChunk(
  input: unknown,
  queryIndex: number,
  chunkIndex: number,
): SearchEvalRelevantChunk {
  if (!isRecord(input)) {
    throw new Error(`queries[${queryIndex}].relevantChunks[${chunkIndex}] must be an object`);
  }

  return {
    chunkId: asString(input.chunkId, `queries[${queryIndex}].relevantChunks[${chunkIndex}].chunkId`),
    grade: asNumber(input.grade, `queries[${queryIndex}].relevantChunks[${chunkIndex}].grade`),
  };
}

function parseEvidence(
  input: unknown,
  groupIndex: number,
  evidenceIndex: number,
  namespace: 'answerability' | 'tasks',
): SearchEvalEvidence {
  if (!isRecord(input)) {
    throw new Error(`${namespace}[${groupIndex}].requiredEvidence[${evidenceIndex}] must be an object`);
  }

  return {
    repository: asString(
      input.repository,
      `${namespace}[${groupIndex}].requiredEvidence[${evidenceIndex}].repository`,
    ),
    filePath: asString(
      input.filePath,
      `${namespace}[${groupIndex}].requiredEvidence[${evidenceIndex}].filePath`,
    ),
    chunkId:
      input.chunkId === undefined
        ? undefined
        : asString(input.chunkId, `${namespace}[${groupIndex}].requiredEvidence[${evidenceIndex}].chunkId`),
    mustMention:
      input.mustMention === undefined
        ? undefined
        : asArray(input.mustMention, `${namespace}[${groupIndex}].requiredEvidence[${evidenceIndex}].mustMention`).map(
          (value, valueIndex) =>
            asString(
              value,
              `${namespace}[${groupIndex}].requiredEvidence[${evidenceIndex}].mustMention[${valueIndex}]`,
            ),
        ),
  };
}

function asIntent(input: unknown, label: string): SearchEvalIntent {
  const value = asString(input, label);
  const intents: SearchEvalIntent[] = [
    'semantic-paraphrase',
    'identifier-exact',
    'path-structure',
    'docs-howto',
    'workflow-action',
    'implementation-location',
    'change-impact',
  ];
  if (!intents.includes(value as SearchEvalIntent)) {
    throw new Error(`${label} must be one of ${intents.join(', ')}`);
  }
  return value as SearchEvalIntent;
}

function asFailureBucket(input: unknown, label: string): SearchEvalFailureBucket {
  const value = asString(input, label);
  const buckets: SearchEvalFailureBucket[] = [
    'semantic-ranking',
    'keyword-ranking',
    'path-boost',
    'snippet-insufficient',
    'duplicate-crowding',
    'answerability-gap',
    'task-navigation',
  ];
  if (!buckets.includes(value as SearchEvalFailureBucket)) {
    throw new Error(`${label} must be one of ${buckets.join(', ')}`);
  }
  return value as SearchEvalFailureBucket;
}

function asRepoType(input: unknown, label: string): SearchEvalRepoType {
  const value = asString(input, label);
  const repoTypes: SearchEvalRepoType[] = [
    'application',
    'documentation',
    'platform',
    'actions',
    'real-snapshot',
  ];
  if (!repoTypes.includes(value as SearchEvalRepoType)) {
    throw new Error(`${label} must be one of ${repoTypes.join(', ')}`);
  }
  return value as SearchEvalRepoType;
}

function asEmbedding(input: unknown, label: string, dimensions: number): number[] {
  const embedding = asArray(input, label).map((value, index) =>
    asNumber(value, `${label}[${index}]`),
  );
  if (embedding.length !== dimensions) {
    throw new Error(`${label} must have ${dimensions} dimensions, got ${embedding.length}`);
  }
  return embedding;
}

function asArray(input: unknown, label: string): unknown[] {
  if (!Array.isArray(input)) {
    throw new Error(`${label} must be an array`);
  }
  return input;
}

function asString(input: unknown, label: string): string {
  if (typeof input !== 'string') {
    throw new Error(`${label} must be a string`);
  }
  return input;
}

function nullableString(input: unknown, label: string): string | null {
  if (input === null) return null;
  return asString(input, label);
}

function asNumber(input: unknown, label: string): number {
  if (typeof input !== 'number' || Number.isNaN(input)) {
    throw new Error(`${label} must be a number`);
  }
  return input;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null;
}
