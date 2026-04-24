import { describe, expect, it } from 'vitest';
import { minimatch } from 'minimatch';
import { REPO_TYPE_PRESETS } from '../../../src/config/repoTypePresets';

describe('REPO_TYPE_PRESETS', () => {
  it('includes README.md for every filtered repo type preset', () => {
    for (const preset of Object.values(REPO_TYPE_PRESETS)) {
      if (preset.includePatterns.length === 0) continue;

      expect(
        preset.includePatterns.some((pattern) => minimatch('README.md', pattern, { dot: true })),
        `${preset.id} should include README.md`,
      ).toBe(true);
    }
  });
});
