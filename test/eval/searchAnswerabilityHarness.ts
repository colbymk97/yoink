import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildSearchPayload } from '../../src/tools/searchPayload';
import { Retriever } from '../../src/retrieval/retriever';
import {
  buildRepoMaps,
  loadSearchEvalDataset,
  makeSearchEvalProvider,
  SearchEvalAnswerabilityPrompt,
  SearchEvalDataset,
  SearchEvalIntent,
} from './searchEvalDataset';
import { createStructuredResponse, OpenAIResponsesConfig } from './openaiResponses';

export interface SearchAnswerabilityAnswer {
  answer: string;
  abstained: boolean;
  confidence: 'low' | 'medium' | 'high';
  citedResults: Array<{ repository: string; filePath: string }>;
  notes: string;
}

export interface SearchAnswerabilityGrade {
  correctness: 'exact' | 'partial' | 'incorrect';
  abstainQuality: 'good' | 'bad' | 'not_applicable';
  citationQuality: 'strong' | 'partial' | 'weak' | 'none';
  hallucinated: boolean;
  matchedRequiredEvidence: boolean;
  failureReasons: string[];
  notes: string;
}

export interface SearchAnswerabilityPromptRun {
  promptId: string;
  intent: SearchEvalIntent;
  topK: number;
  query: string;
  question: string;
  answer: SearchAnswerabilityAnswer;
  grade: SearchAnswerabilityGrade;
}

export interface SearchAnswerabilityMetrics {
  exactRate: number;
  partialRate: number;
  hallucinationRate: number;
  citationStrongRate: number;
  abstainGoodRate: number;
}

export interface SearchAnswerabilitySummary {
  generatedAt: string;
  artifactPath: string;
  model: string;
  dataset: {
    promptCount: number;
    promptCountByIntent: Record<string, number>;
  };
  byTopK: Record<string, SearchAnswerabilityMetrics>;
  byIntent: Record<string, SearchAnswerabilityMetrics>;
  prompts: SearchAnswerabilityPromptRun[];
  weaknessReport: {
    topFailedIntents: Array<{ intent: string; failures: number }>;
    topFailureReasons: Array<{ reason: string; count: number }>;
    topSnippetRiskPrompts: Array<{ promptId: string; reasonCount: number }>;
  };
}

export const SEARCH_ANSWERABILITY_ARTIFACT_PATH = resolve(
  __dirname,
  '../../test-results/search-answerability-summary.json',
);

export async function runSearchAnswerabilityEvaluation(
  retriever: Retriever,
  config: OpenAIResponsesConfig,
  dataset: SearchEvalDataset = loadSearchEvalDataset(),
): Promise<SearchAnswerabilitySummary> {
  const provider = makeSearchEvalProvider(dataset);
  const { repoByDataSourceId, dataSourceIdByRepo } = buildRepoMaps(dataset);
  const promptRuns: SearchAnswerabilityPromptRun[] = [];

  for (const prompt of dataset.answerabilityPrompts) {
    for (const topK of prompt.topKVariants ?? [1, 3, 5]) {
      const dataSourceIds = prompt.repository
        ? [dataSourceIdByRepo.get(prompt.repository)].filter(Boolean) as string[]
        : [];
      const results = await retriever.search(
        prompt.query,
        dataSourceIds,
        provider,
        topK,
        { includeDiagnostics: true },
      );
      const searchPayload = buildSearchPayload(
        results,
        (chunk) => repoByDataSourceId.get(chunk.dataSourceId),
        { searchedRepositories: prompt.repository ?? 'all indexed repositories', pageSize: topK },
      );

      const answer = await answerPrompt(config, prompt, searchPayload);
      const grade = await gradeAnswer(config, prompt, searchPayload, answer);
      promptRuns.push({
        promptId: prompt.id,
        intent: prompt.intent,
        topK,
        query: prompt.query,
        question: prompt.question,
        answer,
        grade,
      });
    }
  }

  const summary: SearchAnswerabilitySummary = {
    generatedAt: new Date().toISOString(),
    artifactPath: SEARCH_ANSWERABILITY_ARTIFACT_PATH,
    model: config.model,
    dataset: {
      promptCount: dataset.answerabilityPrompts.length,
      promptCountByIntent: Object.fromEntries(
        [...new Set(dataset.answerabilityPrompts.map((prompt) => prompt.intent))].map((intent) => [
          intent,
          dataset.answerabilityPrompts.filter((prompt) => prompt.intent === intent).length,
        ]),
      ),
    },
    byTopK: Object.fromEntries(
      [...new Set(promptRuns.map((run) => String(run.topK)))].map((topK) => [
        topK,
        summarizeAnswerabilityRuns(promptRuns.filter((run) => String(run.topK) === topK)),
      ]),
    ),
    byIntent: Object.fromEntries(
      [...new Set(promptRuns.map((run) => run.intent))].map((intent) => [
        intent,
        summarizeAnswerabilityRuns(promptRuns.filter((run) => run.intent === intent)),
      ]),
    ),
    prompts: promptRuns,
    weaknessReport: buildWeaknessReport(promptRuns),
  };

  mkdirSync(dirname(SEARCH_ANSWERABILITY_ARTIFACT_PATH), { recursive: true });
  writeFileSync(SEARCH_ANSWERABILITY_ARTIFACT_PATH, JSON.stringify(summary, null, 2));

  return summary;
}

async function answerPrompt(
  config: OpenAIResponsesConfig,
  prompt: SearchEvalAnswerabilityPrompt,
  payload: unknown,
): Promise<SearchAnswerabilityAnswer> {
  return createStructuredResponse<SearchAnswerabilityAnswer>(config, {
    instructions:
      'You are evaluating search usefulness for an LLM. Use only the provided JSON search payload. ' +
      'If the payload is insufficient, abstain clearly instead of guessing. Return JSON only.',
    input: [
      {
        role: 'developer',
        content:
          'Answer the question using only evidence from the search payload. Do not invent missing facts.',
      },
      {
        role: 'user',
        content: [
          `Question:\n${prompt.question}`,
          `Search query:\n${prompt.query}`,
          `Search payload JSON:\n${JSON.stringify(payload, null, 2)}`,
        ].join('\n\n'),
      },
    ],
    schemaName: 'search_answerability_answer',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        answer: { type: 'string' },
        abstained: { type: 'boolean' },
        confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
        citedResults: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              repository: { type: 'string' },
              filePath: { type: 'string' },
            },
            required: ['repository', 'filePath'],
          },
        },
        notes: { type: 'string' },
      },
      required: ['answer', 'abstained', 'confidence', 'citedResults', 'notes'],
    },
  });
}

async function gradeAnswer(
  config: OpenAIResponsesConfig,
  prompt: SearchEvalAnswerabilityPrompt,
  payload: unknown,
  answer: SearchAnswerabilityAnswer,
): Promise<SearchAnswerabilityGrade> {
  return createStructuredResponse<SearchAnswerabilityGrade>(config, {
    instructions:
      'You are grading whether a search payload was sufficient for an LLM to answer correctly. ' +
      'Use the gold answer and required evidence rubric. Return JSON only.',
    input: [
      {
        role: 'developer',
        content:
          'Mark correctness as exact, partial, or incorrect. Mark hallucinated true if the answer introduces unsupported facts.',
      },
      {
        role: 'user',
        content: [
          `Question:\n${prompt.question}`,
          `Gold answer:\n${prompt.goldAnswer}`,
          `Required evidence JSON:\n${JSON.stringify(prompt.requiredEvidence, null, 2)}`,
          `Acceptable files JSON:\n${JSON.stringify(prompt.acceptableFiles, null, 2)}`,
          `Search payload JSON:\n${JSON.stringify(payload, null, 2)}`,
          `Model answer JSON:\n${JSON.stringify(answer, null, 2)}`,
        ].join('\n\n'),
      },
    ],
    schemaName: 'search_answerability_grade',
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

function summarizeAnswerabilityRuns(runs: SearchAnswerabilityPromptRun[]): SearchAnswerabilityMetrics {
  const denominator = runs.length || 1;
  return {
    exactRate: runs.filter((run) => run.grade.correctness === 'exact').length / denominator,
    partialRate: runs.filter((run) => run.grade.correctness === 'partial').length / denominator,
    hallucinationRate: runs.filter((run) => run.grade.hallucinated).length / denominator,
    citationStrongRate:
      runs.filter((run) => run.grade.citationQuality === 'strong').length / denominator,
    abstainGoodRate:
      runs.filter((run) => run.grade.abstainQuality === 'good').length / denominator,
  };
}

function buildWeaknessReport(runs: SearchAnswerabilityPromptRun[]) {
  const failuresByIntent = new Map<string, number>();
  const failuresByReason = new Map<string, number>();
  for (const run of runs) {
    if (run.grade.correctness === 'exact' && !run.grade.hallucinated) continue;
    failuresByIntent.set(run.intent, (failuresByIntent.get(run.intent) ?? 0) + 1);
    for (const reason of run.grade.failureReasons) {
      failuresByReason.set(reason, (failuresByReason.get(reason) ?? 0) + 1);
    }
  }

  return {
    topFailedIntents: [...failuresByIntent.entries()]
      .map(([intent, failures]) => ({ intent, failures }))
      .sort((a, b) => b.failures - a.failures)
      .slice(0, 5),
    topFailureReasons: [...failuresByReason.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8),
    topSnippetRiskPrompts: runs
      .filter((run) => run.grade.failureReasons.some((reason) => reason.includes('snippet')))
      .map((run) => ({
        promptId: run.promptId,
        reasonCount: run.grade.failureReasons.length,
      }))
      .slice(0, 5),
  };
}
