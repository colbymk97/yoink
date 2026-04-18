import * as vscode from 'vscode';

export interface IndexingProgress {
  dataSourceId: string;
  totalFiles: number;
  processedFiles: number;
  totalTokens: number;
}

export class ProgressTracker implements vscode.Disposable {
  private readonly state = new Map<string, IndexingProgress>();
  private readonly _onDidChange = new vscode.EventEmitter<string>();
  readonly onDidChange = this._onDidChange.event;

  start(dataSourceId: string, totalFiles: number): void {
    this.state.set(dataSourceId, {
      dataSourceId,
      totalFiles,
      processedFiles: 0,
      totalTokens: 0,
    });
    this._onDidChange.fire(dataSourceId);
  }

  fileProcessed(dataSourceId: string, chunkCount: number, tokenCount: number): void {
    const s = this.state.get(dataSourceId);
    if (!s) return;
    s.processedFiles += 1;
    s.totalTokens += tokenCount;
    this._onDidChange.fire(dataSourceId);
  }

  complete(dataSourceId: string): void {
    this.state.delete(dataSourceId);
    this._onDidChange.fire(dataSourceId);
  }

  get(dataSourceId: string): IndexingProgress | undefined {
    return this.state.get(dataSourceId);
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
