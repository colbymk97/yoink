export function parseCommaSeparatedPatterns(input: string): string[] {
  return input
    ? input.split(',').map((pattern) => pattern.trim()).filter(Boolean)
    : [];
}
