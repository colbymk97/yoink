import * as vscode from 'vscode';
import { ConfigManager } from '../../config/configManager';
import { SETTING_KEYS } from '../../config/settingsSchema';

export class SyncScheduler implements vscode.Disposable {
  private dailyTimer: ReturnType<typeof setInterval> | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly configManager: ConfigManager,
    private readonly onSyncTriggered: (dataSourceId: string) => void,
  ) {}

  start(): void {
    const syncOnStartup = vscode.workspace
      .getConfiguration()
      .get<boolean>(SETTING_KEYS.SYNC_ON_STARTUP, true);

    if (syncOnStartup) {
      this.triggerOnStartupSources();
    }

    // Daily sync check every hour
    this.dailyTimer = setInterval(() => this.triggerDailySources(), 60 * 60 * 1000);
  }

  private triggerOnStartupSources(): void {
    for (const ds of this.configManager.getDataSources()) {
      if (ds.status === 'deleting') continue;
      if (ds.syncSchedule === 'onStartup') {
        this.onSyncTriggered(ds.id);
      }
    }
  }

  private triggerDailySources(): void {
    const now = Date.now();
    for (const ds of this.configManager.getDataSources()) {
      if (ds.status === 'deleting') continue;
      if (ds.syncSchedule !== 'daily') continue;
      if (!ds.lastSyncedAt) {
        this.onSyncTriggered(ds.id);
        continue;
      }
      const elapsed = now - new Date(ds.lastSyncedAt).getTime();
      if (elapsed >= 24 * 60 * 60 * 1000) {
        this.onSyncTriggered(ds.id);
      }
    }
  }

  dispose(): void {
    if (this.dailyTimer) {
      clearInterval(this.dailyTimer);
    }
    this.disposables.forEach((d) => d.dispose());
  }
}
