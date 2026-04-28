import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildSearchPayload } from '../../src/tools/searchPayload';
import { Retriever } from '../../src/retrieval/retriever';
import {
  buildFileContentsByFile,
  buildRepoMaps,
  loadSearchEvalDataset,
  makeSearchEvalProvider,
  SearchEvalDataset,
  SearchEvalTaskScenario,
} from './searchEvalDataset';
import { createStructuredResponse, OpenAIResponsesConfig } from './openaiResponses';
import { SearchAnswerabilityGrade } from './searchAnswerabilityHarness';

interface TaskFileChoice {
  repository: string;
  filePath: string;
  reason: string;
}

interface TaskPlan {
  canAnswerFromSearch: boolean;
  filesToFetch: TaskFileChoice[];
  reasoning: string;
}

interface TaskAnswer {
  answer: string;
  citedFiles: TaskFileChoice[];
  notes: string;
}

export interface SearchTaskRun {
  taskId: string;
  intent: string;
  plan: TaskPlan;
  fetchedFiles: TaskFileChoice[];
  answer: TaskAnswer;
  grade: SearchAnswerabilityGrade;
  irrelevantFilesFetched: number;
  firstSearchNarrowedCorrectly: boolean;
  searchResultsSufficientToChooseNextTool: boolean;
  searchTurns: number;
}

export interface SearchTaskSummary {
  generatedAt: string;
  artifactPath: string;
  model: string;
  dataset: {
    taskCount: number;
  };
  metrics: {
    successRate: number;
    firstSearchNarrowedRate: number;
    averageIrrelevantFilesFetched: number;
    sufficientNextToolRate: number;
  };
  tasks: SearchTaskRun[];
}

export const SEARCH_TASK_ARTIFACT_PATH = resolve(
  __dirname,
  '../../test-results/search-task-summary.json',
);

export async function runSearchTaskEvaluation(
  retriever: Retriever,
  config: OpenAIResponsesConfig,
  dataset: SearchEvalDataset = loadSearchEvalDataset(),
): Promise<SearchTaskSummary> {
  const provider = makeSearchEvalProvider(dataset);
  const { repoByDataSourceId, dataSourceIdByRepo } = buildRepoMaps(dataset);
  const fileContentsByFile = buildFileContentsByFile(dataset);
  const taskRuns: SearchTaskRun[] = [];

  for (const task of dataset.taskScenarios) {
    const dataSourceIds = task.repository
      ? [dataSourceIdByRepo.get(task.repository)].filter(Boolean) as string[]
      : [];
    const results = await retriever.search(task.searchQuery, dataSourceIds, provider, 5, {
      includeDiagnostics: true,
    });
    const searchPayload = buildSearchPayload(
      results,
      (chunk) => repoByDataSourceId.get(chunk.dataSourceId),
      { searchedRepositories: task.repository ?? 'all indexed repositories', pageSize: 5 },
    );
    const plan = await chooseFilesForTask(config, task, searchPayload);

    const fetchedFiles = plan.filesToFetch.slice(0, task.maxFilesToFetch ?? 2);
    const fetchedFilePayload = fetchedFiles.map((file) => ({
      repository: file.repository,
      filePath: file.filePath,
      content: fileContentsByFile.get(
        `${dataSourceIdByRepo.get(file.repository)}:${file.filePath}`,
      ) ?? '',
    }));

    const answer = await answerTask(config, task, searchPayload, fetchedFilePayload, plan);
    const grade = await gradeTaskAnswer(config, task, searchPayload, fetchedFilePayload, answer);
    const acceptableKeys = new Set(
      task.acceptableFiles.map((file) => `${file.repository}:${file.filePath}`),
    );
    const fetchedKeys = fetchedFiles.map((file) => `${file.repository}:${file.filePath}`);
    const relevantFetched = fetchedKeys.filter((key) => acceptableKeys.has(key)).length;

    taskRuns.push({
      taskId: task.id,
      intent: task.intent,
      plan,
      fetchedFiles,
      answer,
      grade,
      irrelevantFilesFetched: fetchedKeys.length - relevantFetched,
      firstSearchNarrowedCorrectly: relevantFetched > 0 || plan.canAnswerFromSearch,
      searchResultsSufficientToChooseNextTool: relevantFetched > 0 || plan.canAnswerFromSearch,
      searchTurns: 1,
    });
  }

  const summary: SearchTaskSummary = {
    generatedAt: new Date().toISOString(),
    artifactPath: SEARCH_TASK_ARTIFACT_PATH,
    model: config.model,
    dataset: {
      taskCount: dataset.taskScenarios.length,
    },
    metrics: {
      successRate:
        taskRuns.filter((task) => task.grade.correctness === 'exact').length / (taskRuns.length || 1),
      firstSearchNarrowedRate:
        taskRuns.filter((task) => task.firstSearchNarrowedCorrectly).length / (taskRuns.length || 1),
      averageIrrelevantFilesFetched:
        taskRuns.reduce((sum, task) => sum + task.irrelevantFilesFetched, 0) / (taskRuns.length || 1),
      sufficientNextToolRate:
        taskRuns.filter((task) => task.searchResultsSufficientToChooseNextTool).length /
        (taskRuns.length || 1),
    },
    tasks: taskRuns,
  };

  mkdirSync(dirname(SEARCH_TASK_ARTIFACT_PATH), { recursive: true });
  writeFileSync(SEARCH_TASK_ARTIFACT_PATH, JSON.stringify(summary, null, 2));

  return summary;
}

async function chooseFilesForTask(
  config: OpenAIResponsesConfig,
  task: SearchEvalTaskScenario,
  payload: unknown,
): Promise<TaskPlan> {
  return createStructuredResponse<TaskPlan>(config, {
    instructions:
      'You are deciding which file an agent should inspect next after a search. Use only the search payload. Return JSON only.',
    input: [
      {
        role: 'user',
        content: [
          `Task question:\n${task.question}`,
          `Task steps:\n${task.taskSteps.join('\n')}`,
          `Search payload JSON:\n${JSON.stringify(payload, null, 2)}`,
        ].join('\n\n'),
      },
    ],
    schemaName: 'search_task_plan',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        canAnswerFromSearch: { type: 'boolean' },
        filesToFetch: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              repository: { type: 'string' },
              filePath: { type: 'string' },
              reason: { type: 'string' },
            },
            required: ['repository', 'filePath', 'reason'],
          },
        },
        reasoning: { type: 'string' },
      },
      required: ['canAnswerFromSearch', 'filesToFetch', 'reasoning'],
    },
  });
}

async function answerTask(
  config: OpenAIResponsesConfig,
  task: SearchEvalTaskScenario,
  payload: unknown,
  fetchedFiles: Array<{ repository: string; filePath: string; content: string }>,
  plan: TaskPlan,
): Promise<TaskAnswer> {
  return createStructuredResponse<TaskAnswer>(config, {
    instructions:
      'Answer the task using only the search payload and fetched files. If evidence is missing, say so instead of inventing details. Return JSON only.',
    input: [
      {
        role: 'user',
        content: [
          `Task question:\n${task.question}`,
          `Search payload JSON:\n${JSON.stringify(payload, null, 2)}`,
          `Chosen file plan JSON:\n${JSON.stringify(plan, null, 2)}`,
          `Fetched files JSON:\n${JSON.stringify(fetchedFiles, null, 2)}`,
        ].join('\n\n'),
      },
    ],
    schemaName: 'search_task_answer',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        answer: { type: 'string' },
        citedFiles: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              repository: { type: 'string' },
              filePath: { type: 'string' },
              reason: { type: 'string' },
            },
            required: ['repository', 'filePath', 'reason'],
          },
        },
        notes: { type: 'string' },
      },
      required: ['answer', 'citedFiles', 'notes'],
    },
  });
}

async function gradeTaskAnswer(
  config: OpenAIResponsesConfig,
  task: SearchEvalTaskScenario,
  payload: unknown,
  fetchedFiles: Array<{ repository: string; filePath: string; content: string }>,
  answer: TaskAnswer,
): Promise<SearchAnswerabilityGrade> {
  return createStructuredResponse<SearchAnswerabilityGrade>(config, {
    instructions:
      'Grade task completion for search evaluation. Use the gold answer and required evidence. Return JSON only.',
    input: [
      {
        role: 'user',
        content: [
          `Task question:\n${task.question}`,
          `Gold answer:\n${task.goldAnswer}`,
          `Required evidence JSON:\n${JSON.stringify(task.requiredEvidence, null, 2)}`,
          `Search payload JSON:\n${JSON.stringify(payload, null, 2)}`,
          `Fetched files JSON:\n${JSON.stringify(fetchedFiles, null, 2)}`,
          `Task answer JSON:\n${JSON.stringify(answer, null, 2)}`,
        ].join('\n\n'),
      },
    ],
    schemaName: 'search_task_grade',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        correctness: { type: 'string', enum: ['exact', 'partial', 'incorrect'] },
        abstainQuality: { type: 'string', enum: ['good', 'bad', 'not_applicable'] },
        citationQuality: { type: 'string', enum: ['strong', 'partial', 'weak', 'none'] },
        hallucinated: { type: 'boolean' },
        matchedRequiredEvidence: { type: 'boolean' },
        failureReasons: { type: 'array', items: { type: 'string' } },
        notes: { type: 'string' },
      },
      required: [
        'correctness',
        'abstainQuality',
        'citationQuality',
        'hallucinated',
        'matchedRequiredEvidence',
        'failureReasons',
        'notes',
      ],
    },
  });
}
