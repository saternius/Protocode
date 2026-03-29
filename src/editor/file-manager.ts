import * as vscode from 'vscode';
import { RenderEngine } from '../render/render-engine';

export class FileManager {
  private disposables: vscode.Disposable[] = [];
  private renderEngine: RenderEngine;
  private lastRenderTime: number = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private minRenderInterval: number; // ms

  // Dirty flags — accumulated across events, flushed together
  private dirtyText: boolean = false;
  private dirtyCursor: boolean = false;
  private dirtyScroll: boolean = false;
  private dirtyFull: boolean = false;
  private dirtyTabs: boolean = false;

  // Flag to skip render when edits originate from Resonite input
  skipNextDocChange: boolean = false;

  constructor(renderEngine: RenderEngine) {
    this.renderEngine = renderEngine;

    const config = vscode.workspace.getConfiguration('protocode');
    const fps = config.get<number>('renderFps', 30);
    this.minRenderInterval = Math.floor(1000 / fps);

    // Document content changes
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (this.skipNextDocChange) {
          this.skipNextDocChange = false;
          return;
        }
        if (e.document === vscode.window.activeTextEditor?.document) {
          this.dirtyText = true;
          this.scheduleFlush();
        }
      })
    );

    // Cursor/selection changes
    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor === vscode.window.activeTextEditor) {
          this.dirtyCursor = true;
          this.scheduleFlush();
        }
      })
    );

    // Scroll changes
    this.disposables.push(
      vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
        if (e.textEditor === vscode.window.activeTextEditor) {
          this.dirtyScroll = true;
          this.scheduleFlush();
        }
      })
    );

    // Active editor changes
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.dirtyFull = true;
        this.scheduleFlush();
      })
    );

    // Tab changes (open/close/reorder)
    this.disposables.push(
      vscode.window.tabGroups.onDidChangeTabs(() => {
        this.dirtyTabs = true;
        this.scheduleFlush();
      })
    );
  }

  private scheduleFlush(): void {
    const now = Date.now();
    const elapsed = now - this.lastRenderTime;

    if (elapsed >= this.minRenderInterval) {
      // Can flush immediately
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
      this.flush();
    } else if (!this.flushTimer) {
      // Schedule flush — don't replace existing timer, flags accumulate
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flush();
      }, this.minRenderInterval - elapsed);
    }
    // If timer already pending, just let flags accumulate
  }

  private flush(): void {
    this.lastRenderTime = Date.now();
    this.renderEngine.syncFromEditor();

    if (this.dirtyFull) {
      this.renderEngine.fullRender();
      this.dirtyText = false;
      this.dirtyCursor = false;
      this.dirtyScroll = false;
      this.dirtyFull = false;
      this.dirtyTabs = false;
      return;
    }

    if (this.dirtyText) {
      this.renderEngine.renderTextEdit();
    } else {
      if (this.dirtyScroll) this.renderEngine.renderScroll();
      if (this.dirtyCursor) this.renderEngine.renderCursorMove();
    }

    if (this.dirtyTabs) {
      this.renderEngine.updateOpenFiles();
      this.renderEngine.renderFilePanel();
    }

    this.dirtyText = false;
    this.dirtyCursor = false;
    this.dirtyScroll = false;
    this.dirtyFull = false;
    this.dirtyTabs = false;
  }

  dispose(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}
