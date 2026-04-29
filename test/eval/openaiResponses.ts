export interface OpenAIResponsesConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  organization?: string;
  project?: string;
  supportsReasoningEffort?: boolean;
}

export function loadOpenAIResponsesConfigFromEnv(): OpenAIResponsesConfig | null {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return null;

  return {
    apiKey,
    model: process.env.SEARCH_EVAL_MODEL?.trim() || 'gpt-5-mini',
    baseUrl: (process.env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1').replace(/\/$/, ''),
    organization: process.env.OPENAI_ORGANIZATION?.trim() || undefined,
    project: process.env.OPENAI_PROJECT?.trim() || undefined,
    supportsReasoningEffort: supportsReasoningEffort(
      process.env.SEARCH_EVAL_MODEL?.trim() || 'gpt-5-mini',
    ),
  };
}

export interface StructuredResponseRequest {
  instructions: string;
  input: Array<{
    role: 'developer' | 'user' | 'assistant';
    content: string;
  }>;
  schemaName: string;
  schema: Record<string, unknown>;
}

export async function createStructuredResponse<T>(
  config: OpenAIResponsesConfig,
  request: StructuredResponseRequest,
): Promise<T> {
  const body: Record<string, unknown> = {
    model: config.model,
    instructions: request.instructions,
    input: request.input.map((item) => ({
      role: item.role,
      content: [{ type: 'input_text', text: item.content }],
    })),
    text: {
      format: {
        type: 'json_schema',
        name: request.schemaName,
        strict: true,
        schema: request.schema,
      },
    },
  };

  if (config.supportsReasoningEffort) {
    body.reasoning = { effort: 'low' };
  }

  const res = await fetch(`${config.baseUrl}/responses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
      ...(config.organization ? { 'OpenAI-Organization': config.organization } : {}),
      ...(config.project ? { 'OpenAI-Project': config.project } : {}),
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI Responses API error ${res.status}: ${text}`);
  }

  const payload = (await res.json()) as Record<string, unknown>;
  const outputText = extractOutputText(payload);
  return JSON.parse(outputText) as T;
}

function extractOutputText(payload: Record<string, unknown>): string {
  if (typeof payload.output_text === 'string' && payload.output_text.length > 0) {
    return payload.output_text;
  }

  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    if (!isRecord(item)) continue;
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if (!isRecord(part)) continue;
      if (typeof part.text === 'string' && part.text.length > 0) {
        return part.text;
      }
    }
  }

  throw new Error('OpenAI Responses API did not return output_text');
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null;
}

function supportsReasoningEffort(model: string): boolean {
  return /^(o[1345]|gpt-5)/i.test(model);
}
