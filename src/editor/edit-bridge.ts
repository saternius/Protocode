import * as vscode from 'vscode';
import { RenderEngine } from '../render/render-engine';

/**
 * Applies VR input as VSCode editor operations.
 * After each edit, VSCode fires onDidChange* events which the FileManager
 * picks up to trigger re-renders. We set skipNextDocChange on the FileManager
 * to avoid double-rendering for edits we initiate + the render we do here.
 */
export class EditBridge {
  private renderEngine: RenderEngine;

  constructor(renderEngine: RenderEngine) {
    this.renderEngine = renderEngine;
  }

  private getEditor(): vscode.TextEditor | undefined {
    return vscode.window.activeTextEditor;
  }

  /** Type a single character */
  async typeChar(char: string): Promise<void> {
    const editor = this.getEditor();
    if (!editor) return;
    await editor.edit((b) => {
      b.insert(editor.selection.active, char);
    });
    this.renderEngine.syncFromEditor();
    this.renderEngine.renderTextEdit();
  }

  /** Enter key — insert newline */
  async enter(): Promise<void> {
    await vscode.commands.executeCommand('type', { text: '\n' });
    this.renderEngine.syncFromEditor();
    this.renderEngine.renderTextEdit();
  }

  /** Backspace */
  async backspace(): Promise<void> {
    await vscode.commands.executeCommand('deleteLeft');
    this.renderEngine.syncFromEditor();
    this.renderEngine.renderTextEdit();
  }

  /** Delete key */
  async deleteKey(): Promise<void> {
    await vscode.commands.executeCommand('deleteRight');
    this.renderEngine.syncFromEditor();
    this.renderEngine.renderTextEdit();
  }

  /** Tab — insert two spaces */
  async tab(): Promise<void> {
    const editor = this.getEditor();
    if (!editor) return;
    await editor.edit((b) => {
      b.insert(editor.selection.active, '  ');
    });
    this.renderEngine.syncFromEditor();
    this.renderEngine.renderTextEdit();
  }

  /** Cursor movement */
  async cursorMove(direction: string, shift: boolean = false): Promise<void> {
    const cmdMap: Record<string, string> = {
      left: shift ? 'cursorLeftSelect' : 'cursorLeft',
      right: shift ? 'cursorRightSelect' : 'cursorRight',
      up: shift ? 'cursorUpSelect' : 'cursorUp',
      down: shift ? 'cursorDownSelect' : 'cursorDown',
      home: shift ? 'cursorHomeSelect' : 'cursorHome',
      end: shift ? 'cursorEndSelect' : 'cursorEnd',
      pageUp: shift ? 'cursorPageUpSelect' : 'cursorPageUp',
      pageDown: shift ? 'cursorPageDownSelect' : 'cursorPageDown',
    };
    const cmd = cmdMap[direction];
    if (cmd) {
      await vscode.commands.executeCommand(cmd);
      this.renderEngine.syncFromEditor();
      this.renderEngine.renderCursorMove();
    }
  }

  /** Select all */
  async selectAll(): Promise<void> {
    await vscode.commands.executeCommand('editor.action.selectAll');
    this.renderEngine.syncFromEditor();
    this.renderEngine.renderCursorMove();
  }

  /** Undo */
  async undo(): Promise<void> {
    await vscode.commands.executeCommand('undo');
    this.renderEngine.syncFromEditor();
    this.renderEngine.fullRender();
  }

  /** Redo */
  async redo(): Promise<void> {
    await vscode.commands.executeCommand('redo');
    this.renderEngine.syncFromEditor();
    this.renderEngine.fullRender();
  }

  /** Cut */
  async cut(): Promise<void> {
    const editor = this.getEditor();
    if (!editor) return;
    const sel = editor.selection;
    const text = sel.isEmpty
      ? editor.document.lineAt(sel.active.line).text + '\n'
      : editor.document.getText(sel);
    await vscode.env.clipboard.writeText(text);
    if (sel.isEmpty) {
      const line = sel.active.line;
      const lineCount = editor.document.lineCount;
      const range = line < lineCount - 1
        ? new vscode.Range(line, 0, line + 1, 0)
        : new vscode.Range(
            line === 0 ? 0 : line - 1,
            line === 0 ? 0 : editor.document.lineAt(line - 1).text.length,
            line,
            editor.document.lineAt(line).text.length,
          );
      await editor.edit(b => b.delete(range));
    } else {
      await editor.edit(b => b.delete(sel));
    }
    this.renderEngine.syncFromEditor();
    this.renderEngine.fullRender();
  }

  /** Copy */
  async copy(): Promise<void> {
    const editor = this.getEditor();
    if (!editor) return;
    const sel = editor.selection;
    const text = sel.isEmpty
      ? editor.document.lineAt(sel.active.line).text + '\n'
      : editor.document.getText(sel);
    await vscode.env.clipboard.writeText(text);
  }

  /** Paste */
  async paste(): Promise<void> {
    const editor = this.getEditor();
    if (!editor) return;
    const text = await vscode.env.clipboard.readText();
    if (!text) return;
    await editor.edit(b => {
      if (!editor.selection.isEmpty) {
        b.replace(editor.selection, text);
      } else {
        b.insert(editor.selection.active, text);
      }
    });
    this.renderEngine.syncFromEditor();
    this.renderEngine.fullRender();
  }

  /** Set cursor to specific line/col (from pointer click) */
  setCursor(line: number, col: number): void {
    const editor = this.getEditor();
    if (!editor) return;
    const pos = new vscode.Position(line, col);
    editor.selection = new vscode.Selection(pos, pos);
    this.renderEngine.syncFromEditor();
    this.renderEngine.renderCursorMove();
  }

  /** Extend selection to line/col (from pointer drag) */
  extendSelection(line: number, col: number): void {
    const editor = this.getEditor();
    if (!editor) return;
    const anchor = editor.selection.anchor;
    const active = new vscode.Position(line, col);
    editor.selection = new vscode.Selection(anchor, active);
    this.renderEngine.syncFromEditor();
    this.renderEngine.renderCursorMove();
  }
}
