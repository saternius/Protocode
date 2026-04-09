import * as vscode from 'vscode';
import { EmbeddedProxy } from '../proxy/embedded-proxy';
import { SyntaxHighlighter } from './syntax-highlighter';
import {
  RENDER_W, RENDER_H, LINE_H, MAX_VISIBLE_LINES,
  CODE_AREA_TOP, CHAR_W_APPROX, CODE_LEFT_X, GUTTER_RIGHT_X,
  LINE_HIGH_W, LINE_HIGH_CENTER_X, MAX_FILE_ENTRIES,
  TRACK_TOP, TRACK_H, SCROLLBAR_W
} from './display-constants';

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

export class RenderEngine {
  private proxy: EmbeddedProxy;
  private highlighter: SyntaxHighlighter;

  // Display state
  scrollOffset: number = 0;
  cursorLine: number = 0;
  cursorCol: number = 0;
  selAnchorLine: number = 0;
  selAnchorCol: number = 0;

  // File panel state
  openFiles: string[] = [];
  activeFileIndex: number = -1;

  // Blink
  private cursorVisible: boolean = true;
  private blinkInterval: ReturnType<typeof setInterval> | null = null;

  // Dirty-check caches
  private displayedCode: (string | null)[] = new Array(MAX_VISIBLE_LINES).fill(null);
  private displayedLineNum: (string | null)[] = new Array(MAX_VISIBLE_LINES).fill(null);
  private displayedStatusText: string | null = null;
  private displayedFileEntry: (string | null)[] = new Array(MAX_FILE_ENTRIES).fill(null);
  private displayedToolbar: string | null = null;
  private displayedScrollbarActive: boolean | null = null;
  private displayedScrollbarPos: string | null = null;
  private displayedScrollbarScale: string | null = null;

  constructor(proxy: EmbeddedProxy) {
    this.proxy = proxy;
    this.highlighter = new SyntaxHighlighter();
    this.startBlinkTimer();
  }

  dispose(): void {
    this.stopBlinkTimer();
  }

  // ------------------------------------------------------------------
  // Document access
  // ------------------------------------------------------------------

  private getDocument(): vscode.TextDocument | undefined {
    return vscode.window.activeTextEditor?.document;
  }

  private getLineCount(): number {
    return this.getDocument()?.lineCount ?? 0;
  }

  private getLineText(lineIdx: number): string {
    const doc = this.getDocument();
    if (!doc || lineIdx < 0 || lineIdx >= doc.lineCount) return '';
    return doc.lineAt(lineIdx).text;
  }

  // ------------------------------------------------------------------
  // Cursor blink
  // ------------------------------------------------------------------

  private startBlinkTimer(): void {
    this.blinkInterval = setInterval(() => {
      try {
        this.cursorVisible = !this.cursorVisible;
        this.proxy.sendBool('pce_ca', this.cursorVisible);
      } catch { /* prevent unhandled errors from propagating as toast spam */ }
    }, 530);
  }

  private stopBlinkTimer(): void {
    if (this.blinkInterval) {
      clearInterval(this.blinkInterval);
      this.blinkInterval = null;
    }
  }

  resetBlink(): void {
    this.cursorVisible = true;
    this.proxy.sendBool('pce_ca', true);
    this.stopBlinkTimer();
    this.startBlinkTimer();
  }

  // ------------------------------------------------------------------
  // Selection helpers
  // ------------------------------------------------------------------

  hasSelection(): boolean {
    return this.selAnchorLine !== this.cursorLine || this.selAnchorCol !== this.cursorCol;
  }

  getSelectionRange(): { startLine: number; startCol: number; endLine: number; endCol: number } {
    let startLine = this.selAnchorLine, startCol = this.selAnchorCol;
    let endLine = this.cursorLine, endCol = this.cursorCol;
    if (startLine > endLine || (startLine === endLine && startCol > endCol)) {
      [startLine, endLine] = [endLine, startLine];
      [startCol, endCol] = [endCol, startCol];
    }
    return { startLine, startCol, endLine, endCol };
  }

  // ------------------------------------------------------------------
  // Selection markup
  // ------------------------------------------------------------------

  /**
   * Post-process syntax-highlighted rich text to wrap selected characters
   * in <mark=#264f78> tags. Walks through the string tracking visible
   * character positions while skipping over rich text tags and counting
   * HTML entities (&amp; &lt;) as single visible characters.
   */
  private applySelectionMarkup(lineIdx: number, highlighted: string): string {
    if (!this.hasSelection()) return highlighted;

    const { startLine, startCol, endLine, endCol } = this.getSelectionRange();
    if (lineIdx < startLine || lineIdx > endLine) return highlighted;

    // Determine the visible-character column range for this line
    const lineStartCol = lineIdx === startLine ? startCol : 0;
    const lineEndCol = lineIdx === endLine ? endCol : Infinity;
    if (lineStartCol === lineEndCol) return highlighted;

    // Full-line selection (middle lines) — fast path
    if (lineStartCol === 0 && lineEndCol === Infinity) {
      return `<mark=#264f78>${highlighted}</mark>`;
    }

    // Partial selection — walk the rich text, tracking visible char index
    let result = '';
    let visibleIdx = 0;
    let opened = false;
    let i = 0;
    const src = highlighted;
    const len = src.length;

    while (i < len) {
      // Rich text tag — copy verbatim, does not advance visible index
      if (src[i] === '<') {
        const tagEnd = src.indexOf('>', i);
        if (tagEnd !== -1) {
          // If we need to open mark right at this visible position, do it before the tag
          if (!opened && visibleIdx >= lineStartCol && visibleIdx < lineEndCol) {
            result += '<mark=#264f78>';
            opened = true;
          }
          result += src.substring(i, tagEnd + 1);
          i = tagEnd + 1;
          continue;
        }
      }

      // HTML entity — counts as 1 visible character
      let charStr: string;
      if (src[i] === '&') {
        const semiIdx = src.indexOf(';', i);
        if (semiIdx !== -1 && semiIdx - i <= 6) {
          charStr = src.substring(i, semiIdx + 1);
          i = semiIdx + 1;
        } else {
          charStr = src[i];
          i++;
        }
      } else {
        charStr = src[i];
        i++;
      }

      // Insert <mark> at selection start
      if (!opened && visibleIdx === lineStartCol) {
        result += '<mark=#264f78>';
        opened = true;
      }

      result += charStr;
      visibleIdx++;

      // Insert </mark> at selection end
      if (opened && visibleIdx === lineEndCol) {
        result += '</mark>';
        opened = false;
      }
    }

    // If selection extends past end of line, close the mark
    if (opened) {
      result += '</mark>';
    }

    return result;
  }

  // ------------------------------------------------------------------
  // Display cache
  // ------------------------------------------------------------------

  private invalidateDisplayCache(): void {
    this.displayedCode.fill(null);
    this.displayedLineNum.fill(null);
    this.displayedStatusText = null;
    this.displayedFileEntry.fill(null);
    this.displayedToolbar = null;
    this.displayedScrollbarActive = null;
    this.displayedScrollbarPos = null;
    this.displayedScrollbarScale = null;
  }

  // ------------------------------------------------------------------
  // Syntax highlighting toggle
  // ------------------------------------------------------------------

  private isHighlightable(): boolean {
    const langId = this.getDocument()?.languageId;
    if (!langId) return false;
    if (langId === 'javascript' || langId === 'typescript' || langId === 'javascriptreact' || langId === 'typescriptreact') {
      this.highlighter.lang = 'js';
      return true;
    }
    if (langId === 'protograph') {
      this.highlighter.lang = 'pg';
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------
  // Render methods
  // ------------------------------------------------------------------

  renderVisibleLines(): void {
    const lineCount = this.getLineCount();
    const offset = this.scrollOffset;
    const useHighlight = this.highlighter.enabled && this.isHighlightable();

    for (let i = 0; i < MAX_VISIBLE_LINES; i++) {
      const lineIdx = offset + i;
      const lineContent = lineIdx < lineCount ? this.getLineText(lineIdx) : '';
      let highlighted = useHighlight
        ? this.highlighter.highlight(lineContent)
        : `<color=#abb2bf>${escHtml(lineContent)}</color>`;
      highlighted = this.applySelectionMarkup(offset + i, highlighted);

      if (this.displayedCode[i] !== highlighted) {
        this.displayedCode[i] = highlighted;
        this.proxy.send('pce_c' + i, highlighted);
      }

      const num = lineIdx < lineCount ? String(lineIdx + 1) : '';
      if (this.displayedLineNum[i] !== num) {
        this.displayedLineNum[i] = num;
        this.proxy.send('pce_n' + i, num);
      }
    }
  }

  updateCursorPosition(): void {
    const visibleLine = this.cursorLine - this.scrollOffset;
    const x = CODE_LEFT_X + this.cursorCol * CHAR_W_APPROX;
    const y = CODE_AREA_TOP - (visibleLine * LINE_H) - LINE_H / 2;
    this.proxy.sendF3('pce_cp', x, y, 0.04);
  }

  updateLineHighlight(): void {
    const visibleLine = this.cursorLine - this.scrollOffset;
    const y = CODE_AREA_TOP - (visibleLine * LINE_H) - LINE_H / 2;
    this.proxy.sendF3('pce_lh', LINE_HIGH_CENTER_X, y, 0.012);
  }

  updateStatusBar(): void {
    const doc = this.getDocument();
    const fileName = doc ? (doc.isUntitled ? 'Untitled' : doc.fileName.split(/[\\/]/).pop()!) : 'No file';
    const langId = doc?.languageId ?? '';

    let text = `Ln ${this.cursorLine + 1}, Col ${this.cursorCol + 1}`;

    if (this.hasSelection()) {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        const sel = editor.selection;
        const selText = doc!.getText(sel);
        const selLines = selText.split('\n').length;
        if (selLines > 1) {
          text += ` (${selText.length} chars, ${selLines} lines selected)`;
        } else {
          text += ` (${selText.length} chars selected)`;
        }
      }
    }

    text += ` | ${fileName}`;
    if (langId) text += ` | ${langId}`;

    const richText = `<color=#5c6271>${escHtml(text)}</color>`;
    if (this.displayedStatusText !== richText) {
      this.displayedStatusText = richText;
      this.proxy.send('pce_s', richText);
    }
  }

  // ------------------------------------------------------------------
  // File panel
  // ------------------------------------------------------------------

  updateOpenFiles(): void {
    const files: string[] = [];
    let activeIdx = -1;

    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input && typeof (tab.input as any).uri !== 'undefined') {
          const uri = (tab.input as any).uri as vscode.Uri;
          const name = uri.path.split('/').pop() || 'Untitled';
          files.push(name);
          if (tab.isActive && group.isActive) {
            activeIdx = files.length - 1;
          }
        }
      }
    }

    this.openFiles = files;
    this.activeFileIndex = activeIdx;
  }

  renderFilePanel(): void {
    for (let i = 0; i < MAX_FILE_ENTRIES; i++) {
      let entry: string;
      if (i < this.openFiles.length) {
        const isActive = i === this.activeFileIndex;
        const color = isActive ? '#e5c07b' : '#5c6271';
        const prefix = isActive ? '> ' : '  ';
        entry = `<color=${color}>${escHtml(prefix + this.openFiles[i])}</color>`;
      } else {
        entry = '';
      }

      if (this.displayedFileEntry[i] !== entry) {
        this.displayedFileEntry[i] = entry;
        this.proxy.send('pce_f' + i, entry);
      }
    }

    // File panel header
    const headerText = `<color=#61afef>OPEN FILES (${this.openFiles.length})</color>`;
    this.proxy.send('pce_fh', headerText);

    // File panel header path
    const doc = this.getDocument();
    const folder = doc ? doc.uri.path.split('/').slice(-2, -1)[0] || '' : '';
    const pathText = `<color=#5c6271>${escHtml(folder)}</color>`;
    this.proxy.send('pce_fhp', pathText);
  }

  // ------------------------------------------------------------------
  // Toolbar
  // ------------------------------------------------------------------

  renderToolbar(): void {
    const clientCount = this.proxy.clientCount;
    const status = clientCount > 0 ? `Connected (${clientCount})` : 'Waiting...';
    const toolbarText = `<color=#5c6271>${escHtml(status)}</color>`;
    if (this.displayedToolbar !== toolbarText) {
      this.displayedToolbar = toolbarText;
      this.proxy.send('pce_tb', toolbarText);
    }
  }

  // ------------------------------------------------------------------
  // Scrollbar thumb
  // ------------------------------------------------------------------

  private static readonly SCROLLBAR_CENTER_X = (RENDER_W / 2) - (SCROLLBAR_W / 2);

  private sendScrollbar(): void {
    const totalLines = this.getLineCount();

    if (totalLines <= MAX_VISIBLE_LINES) {
      if (this.displayedScrollbarActive !== false) {
        this.displayedScrollbarActive = false;
        this.proxy.sendBool('pce_sta', false);
      }
      return;
    }

    if (this.displayedScrollbarActive !== true) {
      this.displayedScrollbarActive = true;
      this.proxy.sendBool('pce_sta', true);
    }

    const thumbH = Math.max(20, TRACK_H * MAX_VISIBLE_LINES / totalLines);
    const scrollableLines = totalLines - MAX_VISIBLE_LINES;
    const scrollFraction = scrollableLines > 0 ? this.scrollOffset / scrollableLines : 0;
    const thumbTravel = TRACK_H - thumbH;
    const thumbY = TRACK_TOP - thumbH / 2 - scrollFraction * thumbTravel;

    const posKey = `${thumbY}`;
    if (this.displayedScrollbarPos !== posKey) {
      this.displayedScrollbarPos = posKey;
      this.proxy.sendF3('pce_stp', RenderEngine.SCROLLBAR_CENTER_X, thumbY, -60);
    }

    const scaleY = thumbH / TRACK_H;
    const scaleKey = `${scaleY}`;
    if (this.displayedScrollbarScale !== scaleKey) {
      this.displayedScrollbarScale = scaleKey;
      this.proxy.sendF3('pce_sts', 1, scaleY, 1);
    }
  }

  // ------------------------------------------------------------------
  // Scroll
  // ------------------------------------------------------------------

  ensureCursorVisible(): void {
    if (this.cursorLine < this.scrollOffset) {
      this.scrollOffset = this.cursorLine;
    } else if (this.cursorLine >= this.scrollOffset + MAX_VISIBLE_LINES) {
      this.scrollOffset = this.cursorLine - MAX_VISIBLE_LINES + 1;
    }
  }

  // ------------------------------------------------------------------
  // Composite render functions
  // ------------------------------------------------------------------

  renderTextEdit(): void {
    this.renderVisibleLines();
    this.updateCursorPosition();
    this.updateLineHighlight();
    this.updateStatusBar();
    this.sendScrollbar();
  }

  renderCursorMove(): void {
    this.renderVisibleLines();
    this.updateCursorPosition();
    this.updateLineHighlight();
    this.updateStatusBar();
    this.sendScrollbar();
  }

  renderScroll(): void {
    this.renderVisibleLines();
    this.updateCursorPosition();
    this.updateLineHighlight();
    this.sendScrollbar();
  }

  fullRender(): void {
    this.invalidateDisplayCache();
    this.updateOpenFiles();
    this.renderVisibleLines();
    this.updateCursorPosition();
    this.updateLineHighlight();
    this.updateStatusBar();
    this.renderFilePanel();
    this.renderToolbar();
    this.sendScrollbar();
  }

  /** Send the active file's name and syntax-highlighted content on demand */
  /** Send just the active file name to Resonite */
  sendFileName(): void {
    const doc = this.getDocument();
    const fileName = doc
      ? (doc.isUntitled ? 'Untitled' : doc.fileName.split(/[\\/]/).pop()!)
      : 'No file';
    this.proxy.send('fileInfo:name', fileName);
  }

  /** Send the active file's name and syntax-highlighted content on demand */
  sendFileInfo(): void {
    const doc = this.getDocument();
    const fileName = doc
      ? (doc.isUntitled ? 'Untitled' : doc.fileName.split(/[\\/]/).pop()!)
      : 'No file';
    this.proxy.send('fileInfo:name', fileName);

    if (!doc) {
      this.proxy.send('fileInfo:content', '');
      return;
    }

    const useHighlight = this.highlighter.enabled && this.isHighlightable();
    const lines: string[] = [];
    for (let i = 0; i < doc.lineCount; i++) {
      const text = doc.lineAt(i).text;
      lines.push(useHighlight
        ? this.highlighter.highlight(text)
        : `<color=#abb2bf>${escHtml(text)}</color>`);
    }
    this.proxy.send('fileInfo:content', lines.join('\n'));
  }

  /** Sync cursor/scroll from VSCode editor state */
  syncFromEditor(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const pos = editor.selection.active;
    this.cursorLine = pos.line;
    this.cursorCol = pos.character;

    const anchor = editor.selection.anchor;
    this.selAnchorLine = anchor.line;
    this.selAnchorCol = anchor.character;

    // Sync scroll from visible ranges
    const visibleRanges = editor.visibleRanges;
    if (visibleRanges.length > 0) {
      this.scrollOffset = visibleRanges[0].start.line;
    }
  }
}
