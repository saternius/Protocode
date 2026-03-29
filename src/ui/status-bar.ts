import * as vscode from 'vscode';

export class StatusBar {
  private item: vscode.StatusBarItem;
  private resizeItem: vscode.StatusBarItem;
  private rlItem: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = 'protocode.stop';

    this.resizeItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    this.resizeItem.command = 'protocode.resizeWindow';
    this.resizeItem.text = '$(screen-normal)';
    this.resizeItem.tooltip = 'Resize window to ProtoCode editor size';

    this.rlItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
    this.rlItem.command = 'protocode.setResonitelinkPort';
    this.updateResonitelink(0, 'none');
    this.rlItem.show();
  }

  showListening(port: number): void {
    this.item.text = `$(radio-tower) ProtoCode :${port}`;
    this.item.tooltip = 'Click to stop ProtoCode';
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    this.item.show();
    this.resizeItem.show();
  }

  updateClients(count: number): void {
    const port = this.item.text.match(/:(\d+)/)?.[1] || '?';
    if (count > 0) {
      const suffix = ` (${count} client${count > 1 ? 's' : ''})`;
      this.item.text = `$(check) ProtoCode :${port}${suffix}`;
      this.item.backgroundColor = undefined;
    } else {
      this.item.text = `$(radio-tower) ProtoCode :${port}`;
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
  }

  showStopped(): void {
    this.item.backgroundColor = undefined;
    this.item.hide();
    this.resizeItem.hide();
  }

  updateResonitelink(port: number, status: 'none' | 'pending' | 'connected' | 'failed'): void {
    if (!port || status === 'none') {
      this.rlItem.text = '$(plug) RL: --';
      this.rlItem.tooltip = 'Click to set ResoniteLink port';
      this.rlItem.backgroundColor = undefined;
    } else if (status === 'pending') {
      this.rlItem.text = `$(plug) RL: ${port}`;
      this.rlItem.tooltip = `ResoniteLink port ${port}`;
      this.rlItem.backgroundColor = undefined;
    } else if (status === 'connected') {
      this.rlItem.text = `$(check) RL: ${port}`;
      this.rlItem.tooltip = `ResoniteLink connected on port ${port}`;
      this.rlItem.backgroundColor = undefined;
    } else {
      this.rlItem.text = `$(error) RL: ${port}`;
      this.rlItem.tooltip = `ResoniteLink failed on port ${port}`;
      this.rlItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    }
  }

  dispose(): void {
    this.item.dispose();
    this.resizeItem.dispose();
    this.rlItem.dispose();
  }
}
