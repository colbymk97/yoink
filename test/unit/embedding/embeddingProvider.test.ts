import { describe, it, expect } from 'vitest';
import { estimateTokens } from '../../../src/embedding/embeddingProvider';

describe('estimateTokens', () => {
  it('estimates ~4 chars per token', () => {
    expect(estimateTokens('1234')).toBe(1);
    expect(estimateTokens('12345678')).toBe(2);
  });

  it('rounds up', () => {
    expect(estimateTokens('12345')).toBe(2);
    expect(estimateTokens('1')).toBe(1);
  });

  it('handles empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('handles long strings', () => {
    const text = 'a'.repeat(1000);
    expect(estimateTokens(text)).toBe(250);
  });
});
