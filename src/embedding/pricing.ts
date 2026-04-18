const PRICING_TABLE: Record<string, number> = {
  'text-embedding-3-small': 0.02 / 1_000_000,
  'text-embedding-3-large': 0.13 / 1_000_000,
  'text-embedding-ada-002': 0.10 / 1_000_000,
};

export function getPricingForModel(modelId: string): { costPerToken: number } {
  return { costPerToken: PRICING_TABLE[modelId] ?? 0 };
}

export function formatCost(totalTokens: number, costPerToken: number): string {
  if (costPerToken === 0) return '';
  const cost = totalTokens * costPerToken;
  if (cost === 0) return '$0.00';
  if (cost < 0.01) return '<$0.01';
  return `$${cost.toFixed(2)}`;
}
