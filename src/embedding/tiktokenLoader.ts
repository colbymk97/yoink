import { createRequire } from 'node:module';
import type { Tiktoken, TiktokenModel } from 'tiktoken';

type TiktokenModule = typeof import('tiktoken');

let cachedModule: TiktokenModule | null = null;
const runtimeRequire = createRequire(__filename);

function getTiktokenModule(): TiktokenModule {
  if (cachedModule === null) {
    // Load tiktoken on demand so a packaged WASM resolution issue cannot
    // fail extension activation before token counting is ever used.
    cachedModule = runtimeRequire('tiktoken') as TiktokenModule;
  }

  return cachedModule;
}

export function encodingForModel(model: string): Tiktoken {
  const { encoding_for_model } = getTiktokenModule();
  return encoding_for_model(model as TiktokenModel);
}
