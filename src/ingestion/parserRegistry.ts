import { readFile } from 'fs/promises';
import { join } from 'path';
import { Language, Parser, Query } from 'web-tree-sitter';
import { SupportedLanguage } from './languageDetection';

const WASM_FILENAME: Record<SupportedLanguage, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  python: 'tree-sitter-python.wasm',
  go: 'tree-sitter-go.wasm',
  java: 'tree-sitter-java.wasm',
  csharp: 'tree-sitter-c-sharp.wasm',
  rust: 'tree-sitter-rust.wasm',
  ruby: 'tree-sitter-ruby.wasm',
};

export interface LoadedLanguage {
  parser: Parser;
  query: Query;
}

export interface ParserRegistryLogger {
  debug?(message: string): void;
  warn?(message: string): void;
}

export interface ParserRegistryOptions {
  extensionPath: string;
  queryDir: string;
  logger?: ParserRegistryLogger;
}

export class ParserRegistry {
  private coreInit?: Promise<void>;
  private readonly languages = new Map<SupportedLanguage, Promise<LoadedLanguage>>();
  private readonly extensionPath: string;
  private readonly queryDir: string;
  private readonly logger?: ParserRegistryLogger;

  constructor(options: ParserRegistryOptions) {
    this.extensionPath = options.extensionPath;
    this.queryDir = options.queryDir;
    this.logger = options.logger;
  }

  async get(language: SupportedLanguage): Promise<LoadedLanguage> {
    await this.ensureCore();
    let entry = this.languages.get(language);
    if (!entry) {
      entry = this.load(language);
      this.languages.set(language, entry);
    }
    return entry;
  }

  private ensureCore(): Promise<void> {
    if (!this.coreInit) {
      this.coreInit = (async () => {
        const corePath = join(
          this.extensionPath,
          'node_modules',
          'web-tree-sitter',
          'web-tree-sitter.wasm',
        );
        const wasmBinary = await readFile(corePath);
        await Parser.init({ wasmBinary });
      })();
    }
    return this.coreInit;
  }

  private async load(language: SupportedLanguage): Promise<LoadedLanguage> {
    const wasmPath = join(
      this.extensionPath,
      'node_modules',
      '@vscode',
      'tree-sitter-wasm',
      'wasm',
      WASM_FILENAME[language],
    );
    const wasmBytes = await readFile(wasmPath);
    const grammar = await Language.load(new Uint8Array(wasmBytes));

    const parser = new Parser();
    parser.setLanguage(grammar);

    const queryText = await readFile(join(this.queryDir, `${language}.scm`), 'utf8');
    const query = new Query(grammar, queryText);

    this.logger?.debug?.(`ast: loaded grammar ${language}`);
    return { parser, query };
  }
}
