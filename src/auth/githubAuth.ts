import * as vscode from 'vscode';

const GITHUB_AUTH_PROVIDER_ID = 'github';
const SCOPES = ['repo'];

export class GitHubAuth {
  async getSession(): Promise<vscode.AuthenticationSession> {
    const session = await vscode.authentication.getSession(
      GITHUB_AUTH_PROVIDER_ID,
      SCOPES,
      { createIfNone: true },
    );
    return session;
  }

  async getToken(): Promise<string> {
    const session = await this.getSession();
    return session.accessToken;
  }

  async isAuthenticated(): Promise<boolean> {
    const session = await vscode.authentication.getSession(
      GITHUB_AUTH_PROVIDER_ID,
      SCOPES,
      { createIfNone: false },
    );
    return session !== undefined;
  }
}
