import * as vscode from 'vscode';

export function disposeAll(disposables: vscode.Disposable[]): void {
  for (const d of disposables) {
    d.dispose();
  }
  disposables.length = 0;
}
