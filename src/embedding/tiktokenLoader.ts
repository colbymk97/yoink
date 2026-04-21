import type { Tiktoken, TiktokenModel } from 'tiktoken';

type TiktokenModule = typeof import('tiktoken');

let cachedModule: TiktokenModule | null = null;

function getTiktokenModule(): TiktokenModule {
  if (cachedModule === null) {
    // Load tiktoken on demand so a packaged WASM resolution issue cannot
    // fail extension activation before token counting is ever used.
    cachedModule = require('tiktoken') as TiktokenModule;
  }

  return cachedModule;
}

export function encodingForModel(model: string): Tiktoken {
  const { encoding_for_model } = getTiktokenModule();
  return encoding_for_model(model as TiktokenModel);
}
