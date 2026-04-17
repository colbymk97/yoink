import * as vscode from 'vscode';

export class AgentInstaller {
  constructor(private readonly extensionUri: vscode.Uri) {}

  async install(workspaceUri: vscode.Uri): Promise<number> {
    const sourceDir = vscode.Uri.joinPath(this.extensionUri, 'agents');
    const targetDir = vscode.Uri.joinPath(workspaceUri, '.claude', 'agents');

    await vscode.workspace.fs.createDirectory(targetDir);

    const entries = await vscode.workspace.fs.readDirectory(sourceDir);
    const mdFiles = entries.filter(
      ([name, type]) => type === vscode.FileType.File && name.endsWith('.md'),
    );

    let count = 0;
    for (const [filename] of mdFiles) {
      const sourceUri = vscode.Uri.joinPath(sourceDir, filename);
      const targetUri = vscode.Uri.joinPath(targetDir, filename);
      const content = await vscode.workspace.fs.readFile(sourceUri);
      await vscode.workspace.fs.writeFile(targetUri, content);
      count++;
    }

    return count;
  }

  async isInstalled(workspaceUri: vscode.Uri): Promise<boolean> {
    const markerUri = vscode.Uri.joinPath(workspaceUri, '.claude', 'agents', 'yoink-agent.md');
    try {
      await vscode.workspace.fs.stat(markerUri);
      return true;
    } catch {
      return false;
    }
  }
}
