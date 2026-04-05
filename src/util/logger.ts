import * as vscode from 'vscode';
import { SETTING_KEYS } from '../config/settingsSchema';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export class Logger implements vscode.Disposable {
  private readonly channel: vscode.OutputChannel;

  constructor() {
    this.channel = vscode.window.createOutputChannel('RepoLens');
  }

  debug(message: string): void {
    this.log('debug', message);
  }

  info(message: string): void {
    this.log('info', message);
  }

  warn(message: string): void {
    this.log('warn', message);
  }

  error(message: string): void {
    this.log('error', message);
  }

  private log(level: LogLevel, message: string): void {
    const configLevel = vscode.workspace
      .getConfiguration()
      .get<LogLevel>(SETTING_KEYS.LOG_LEVEL, 'info');

    if (LOG_PRIORITY[level] < LOG_PRIORITY[configLevel]) return;

    const timestamp = new Date().toISOString();
    this.channel.appendLine(`[${timestamp}] [${level.toUpperCase()}] ${message}`);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
