import * as vscode from 'vscode';
import { EditBridge } from './edit-bridge';
import { RenderEngine } from '../render/render-engine';
import {
  RENDER_W, RENDER_H, CODE_AREA_TOP, LINE_H,
  GUTTER_RIGHT_X, CODE_LEFT_X, CHAR_W_APPROX, MAX_VISIBLE_LINES,
  PANEL_RIGHT_X, MINIMAP_LEFT_X, FILE_AREA_TOP,
  MAX_FILE_ENTRIES, TRACK_TOP, TRACK_H
} from '../render/display-constants';

export type ParsedEvent =
  | { type: 'keystroke'; key: string; shift?: boolean; ctrl?: boolean; baseKey?: string }
  | { type: 'triggerDown'; x: number; y: number }
  | { type: 'triggerUp'; x: number; y: number }
  | { type: 'pointerMove'; x: number; y: number }
  | { type: 'thumbstickAxis'; x: number; y: number }
  | { type: 'thumbstickDown' }
  | { type: 'thumbstickUp' }
  | { type: 'activeUser'; username: string; id: string }
  | { type: 'pceTouch'; region: string; x: number; y: number }
  | { type: 'pceKey'; key: string; shift: boolean; ctrl: boolean }
  | { type: 'pceScroll'; delta: number }
  | { type: 'pceMove'; x: number; y: number }
  | { type: 'pceRelease'; x: number; y: number };

const APP_NAME = 'ProtoCodeEditor';

const KEY_MAP: Record<string, { key: string; shifted?: string }> = {
  // Letters
  A: { key: 'a', shifted: 'A' }, B: { key: 'b', shifted: 'B' }, C_KEY: { key: 'c', shifted: 'C' },
  D: { key: 'd', shifted: 'D' }, E: { key: 'e', shifted: 'E' }, F: { key: 'f', shifted: 'F' },
  G: { key: 'g', shifted: 'G' }, H: { key: 'h', shifted: 'H' }, I: { key: 'i', shifted: 'I' },
  J: { key: 'j', shifted: 'J' }, K: { key: 'k', shifted: 'K' }, L: { key: 'l', shifted: 'L' },
  M: { key: 'm', shifted: 'M' }, N: { key: 'n', shifted: 'N' }, O: { key: 'o', shifted: 'O' },
  P: { key: 'p', shifted: 'P' }, Q: { key: 'q', shifted: 'Q' }, R: { key: 'r', shifted: 'R' },
  S: { key: 's', shifted: 'S' }, T: { key: 't', shifted: 'T' }, U: { key: 'u', shifted: 'U' },
  V: { key: 'v', shifted: 'V' }, W: { key: 'w', shifted: 'W' }, X: { key: 'x', shifted: 'X' },
  Y: { key: 'y', shifted: 'Y' }, Z: { key: 'z', shifted: 'Z' },
  // Numbers
  '1': { key: '1', shifted: '!' }, '2': { key: '2', shifted: '@' }, '3': { key: '3', shifted: '#' },
  '4': { key: '4', shifted: '$' }, '5': { key: '5', shifted: '%' }, '6': { key: '6', shifted: '^' },
  '7': { key: '7', shifted: '&' }, '8': { key: '8', shifted: '*' }, '9': { key: '9', shifted: '(' },
  '0': { key: '0', shifted: ')' },
  // Symbols
  GRAVE: { key: '`', shifted: '~' }, MINUS: { key: '-', shifted: '_' }, EQUAL: { key: '=', shifted: '+' },
  LBRACKET: { key: '[', shifted: '{' }, RBRACKET: { key: ']', shifted: '}' },
  BACKSLASH: { key: '\\', shifted: '|' }, SEMICOLON: { key: ';', shifted: ':' },
  QUOTE: { key: "'", shifted: '"' }, COMMA: { key: ',', shifted: '<' },
  PERIOD: { key: '.', shifted: '>' }, SLASH: { key: '/', shifted: '?' },
  // Special keys
  BKSP: { key: 'Backspace' }, ENTER: { key: 'Enter' }, SPACE: { key: 'Space' },
  TAB: { key: 'Tab' }, ESC: { key: 'Escape' },
  UP: { key: 'ArrowUp' }, DOWN: { key: 'ArrowDown' },
  LEFT: { key: 'ArrowLeft' }, RIGHT: { key: 'ArrowRight' },
  // Function keys
  F1: { key: 'F1' }, F2: { key: 'F2' }, F3: { key: 'F3' }, F4: { key: 'F4' },
  F5: { key: 'F5' }, F6: { key: 'F6' }, F7: { key: 'F7' }, F8: { key: 'F8' },
  F9: { key: 'F9' }, F10: { key: 'F10' }, F11: { key: 'F11' }, F12: { key: 'F12' },
};

export class InputHandler {
  private editBridge: EditBridge;
  private renderEngine: RenderEngine;
  private log: vscode.OutputChannel;

  // Keyboard modifier state
  private shiftActive = false;
  private ctrlActive = false;
  private altActive = false;
  private capsActive = false;

  // Drag state
  private isSelectingText: boolean = false;
  private lastDragRenderTime: number = 0;
  private readonly DRAG_RENDER_MS = 50;

  constructor(editBridge: EditBridge, renderEngine: RenderEngine, log: vscode.OutputChannel) {
    this.editBridge = editBridge;
    this.renderEngine = renderEngine;
    this.log = log;
  }

  handle(raw: string): void {
    const event = this.parse(raw);
    if (!event) return;
    this.dispatch(event);
  }

  private parse(raw: string): ParsedEvent | null {
    // pce_* messages from embedded script
    if (raw.startsWith('pce_')) {
      const pilcrowIdx = raw.indexOf('\u00B6');
      const tag = pilcrowIdx >= 0 ? raw.substring(0, pilcrowIdx) : raw;
      const data = pilcrowIdx >= 0 ? raw.substring(pilcrowIdx + 1) : '';

      switch (tag) {
        case 'pce_touch': {
          // region:x,y
          const colonIdx = data.indexOf(':');
          if (colonIdx === -1) return null;
          const region = data.substring(0, colonIdx);
          const coords = data.substring(colonIdx + 1).split(',');
          return {
            type: 'pceTouch',
            region,
            x: parseFloat(coords[0]) || 0,
            y: parseFloat(coords[1]) || 0
          };
        }
        case 'pce_key': {
          // key+shift+ctrl
          const parts = data.split('+');
          return {
            type: 'pceKey',
            key: parts[0] || '',
            shift: parts[1] === 'true',
            ctrl: parts[2] === 'true'
          };
        }
        case 'pce_scroll': {
          return { type: 'pceScroll', delta: parseFloat(data) || 0 };
        }
        case 'pce_move': {
          const parts = data.split(',');
          return {
            type: 'pceMove',
            x: parseFloat(parts[0]) || 0,
            y: parseFloat(parts[1]) || 0
          };
        }
        case 'pce_release': {
          const parts = data.split(',');
          return {
            type: 'pceRelease',
            x: parseFloat(parts[0]) || 0,
            y: parseFloat(parts[1]) || 0
          };
        }
      }
      return null;
    }

    // keyStroke:AppName:key or keyStroke:AppName:key with modifiers
    if (raw.startsWith('keyStroke:')) {
      const rest = raw.substring('keyStroke:'.length);
      const colonIdx = rest.indexOf(':');
      if (colonIdx === -1) return null;
      const app = rest.substring(0, colonIdx);
      if (app !== APP_NAME) return null;

      const keyPart = rest.substring(colonIdx + 1);

      // Parse modifier info if present (format: key or with metadata)
      let baseKey = keyPart;
      let shift = false;
      let ctrl = false;

      // Check for JSON-encoded keystroke data
      if (keyPart.startsWith('{')) {
        try {
          const data = JSON.parse(keyPart);
          baseKey = data.baseKey || data.key || keyPart;
          shift = !!data.shiftKey;
          ctrl = !!data.ctrlKey;
        } catch {
          baseKey = keyPart;
        }
      }

      return { type: 'keystroke', key: keyPart, baseKey, shift, ctrl };
    }

    // appEvent:AppName:event¶x,y
    if (raw.startsWith('appEvent:')) {
      const rest = raw.substring('appEvent:'.length);
      const colonIdx = rest.indexOf(':');
      if (colonIdx === -1) return null;
      const app = rest.substring(0, colonIdx);
      if (app !== APP_NAME) return null;

      const remainder = rest.substring(colonIdx + 1);
      const pilcrowIdx = remainder.indexOf('\u00B6');
      const eventName = pilcrowIdx >= 0 ? remainder.substring(0, pilcrowIdx) : remainder;
      const data = pilcrowIdx >= 0 ? remainder.substring(pilcrowIdx + 1) : '';

      let x = 0, y = 0;
      if (data) {
        const parts = data.split(',');
        x = parseFloat(parts[0]) || 0;
        y = parseFloat(parts[1]) || 0;
      }

      switch (eventName) {
        case 'triggerDown': return { type: 'triggerDown', x, y };
        case 'triggerUp': return { type: 'triggerUp', x, y };
        case 'pointerMove':
        case 'pointDrag': return { type: 'pointerMove', x, y };
        default: return null;
      }
    }

    // controllerInput:App:event:data
    if (raw.startsWith('controllerInput:')) {
      const parts = raw.split(':');
      if (parts.length < 4 || parts[1] !== APP_NAME) return null;
      const event = parts[2];
      const data = parts.slice(3).join(':');

      if (event === 'thumbstickAxis') {
        // Parse [x;y] format
        const match = data.match(/\[?\s*([^;\]]+)\s*;\s*([^;\]]+)\s*\]?/);
        if (match) {
          return { type: 'thumbstickAxis', x: parseFloat(match[1]), y: parseFloat(match[2]) };
        }
        return null;
      }
      if (event === 'thumbstickDown') return { type: 'thumbstickDown' };
      if (event === 'thumbstickUp') return { type: 'thumbstickUp' };
      return null;
    }

    // setActiveUser:Username:Id
    if (raw.startsWith('setActiveUser:')) {
      const parts = raw.split(':');
      if (parts.length >= 3) {
        return { type: 'activeUser', username: parts[1], id: parts.slice(2).join(':') };
      }
      return null;
    }

    // click:AppName:ButtonId (keyboard buttons)
    if (raw.startsWith('click:')) {
      const parts = raw.split(':');
      if (parts.length >= 3) {
        const buttonId = parts.slice(2).join(':');
        if (buttonId.startsWith('kb_')) {
          return this.parseKeyboardClick(buttonId.substring(3));
        }
      }
      return null;
    }

    return null;
  }

  private parseKeyboardClick(tag: string): ParsedEvent | null {
    // Modifier toggles — no keystroke emitted
    if (tag === 'SHIFT' || tag === 'RSHIFT') { this.shiftActive = !this.shiftActive; return null; }
    if (tag === 'LCTRL' || tag === 'RCTRL') { this.ctrlActive = !this.ctrlActive; return null; }
    if (tag === 'LALT' || tag === 'RALT') { this.altActive = !this.altActive; return null; }
    if (tag === 'CAPS') { this.capsActive = !this.capsActive; return null; }

    const entry = KEY_MAP[tag];
    if (!entry) return null;

    const isShifted = this.shiftActive || this.capsActive;
    // When ctrl is active, use base key (not shifted) so Ctrl+Z works
    const baseKey = (!this.ctrlActive && isShifted && entry.shifted) ? entry.shifted : entry.key;

    const ctrl = this.ctrlActive;
    const shift = this.shiftActive;

    // Reset one-shot modifiers (shift, ctrl, alt — NOT caps which persists)
    this.shiftActive = false;
    this.ctrlActive = false;
    this.altActive = false;

    return { type: 'keystroke', key: baseKey, baseKey, shift, ctrl };
  }

  private dispatch(event: ParsedEvent): void {
    switch (event.type) {
      case 'keystroke':
        this.log.appendLine(`[Input] keystroke: ${event.baseKey || event.key}${event.ctrl ? ' ctrl' : ''}${event.shift ? ' shift' : ''}`);
        this.handleKeystroke(event);
        break;
      case 'triggerDown':
        this.log.appendLine(`[Input] triggerDown: ${event.x.toFixed(3)}, ${event.y.toFixed(3)}`);
        this.handleTriggerDown(event.x, event.y);
        break;
      case 'triggerUp':
        this.log.appendLine('[Input] triggerUp');
        this.handleTriggerUp();
        break;
      case 'pointerMove':
        this.handlePointerMove(event.x, event.y);
        break;
      case 'thumbstickAxis':
        this.handleThumbstickAxis(event.y);
        break;
      case 'pceTouch':
        this.log.appendLine(`[Input] pceTouch: ${event.region} ${event.x.toFixed(3)}, ${event.y.toFixed(3)}`);
        this.handlePceTouchDown(event.region, event.x, event.y);
        break;
      case 'pceKey':
        this.log.appendLine(`[Input] pceKey: ${event.key}${event.ctrl ? ' ctrl' : ''}${event.shift ? ' shift' : ''}`);
        this.handleKeystroke({ baseKey: event.key, key: event.key, shift: event.shift, ctrl: event.ctrl });
        break;
      case 'pceScroll':
        this.log.appendLine(`[Input] pceScroll: ${event.delta}`);
        this.handlePceScroll(event.delta);
        break;
      case 'pceMove':
        this.handlePointerMove(event.x, event.y);
        break;
      case 'pceRelease':
        this.log.appendLine('[Input] pceRelease');
        this.handleTriggerUp();
        break;
      case 'activeUser':
        this.log.appendLine(`[Input] activeUser: ${event.username} (${event.id})`);
        break;
    }
  }

  private handleKeystroke(event: { baseKey?: string; key: string; shift?: boolean; ctrl?: boolean }): void {
    const baseKey = event.baseKey || event.key;
    const shift = !!event.shift;
    const ctrl = !!event.ctrl;

    this.renderEngine.resetBlink();

    // Ctrl combos
    if (ctrl) {
      switch (baseKey.toLowerCase()) {
        case 'a':
          this.editBridge.selectAll();
          return;
        case 'z':
          if (shift) this.editBridge.redo();
          else this.editBridge.undo();
          return;
        case 'y':
          this.editBridge.redo();
          return;
      }
    }

    // Navigation & editing keys
    switch (baseKey) {
      case 'Backspace': this.editBridge.backspace(); return;
      case 'Delete': this.editBridge.deleteKey(); return;
      case 'Enter': this.editBridge.enter(); return;
      case 'Tab': this.editBridge.tab(); return;
      case 'Space': this.editBridge.typeChar(' '); return;
      case 'ArrowLeft': this.editBridge.cursorMove('left', shift); return;
      case 'ArrowRight': this.editBridge.cursorMove('right', shift); return;
      case 'ArrowUp': this.editBridge.cursorMove('up', shift); return;
      case 'ArrowDown': this.editBridge.cursorMove('down', shift); return;
      case 'Home': this.editBridge.cursorMove('home', shift); return;
      case 'End': this.editBridge.cursorMove('end', shift); return;
      case 'PageUp': this.editBridge.cursorMove('pageUp', shift); return;
      case 'PageDown': this.editBridge.cursorMove('pageDown', shift); return;
      case 'Escape': return;
    }

    // Single printable character
    if (baseKey.length === 1) {
      this.editBridge.typeChar(baseKey);
    }
  }

  private handleTriggerDown(normX: number, normY: number): void {
    this.renderEngine.resetBlink();

    const pxX = (normX - 0.5) * RENDER_W;
    const pxY = (0.5 - normY) * RENDER_H;

    // File panel region (left of PANEL_RIGHT_X)
    if (pxX < PANEL_RIGHT_X) {
      const visIdx = Math.floor((FILE_AREA_TOP - pxY) / LINE_H);
      this.handleFileClick(visIdx);
      return;
    }

    // Minimap region (right of MINIMAP_LEFT_X)
    if (pxX >= MINIMAP_LEFT_X) {
      this.handleMinimapClick(pxY);
      return;
    }

    // Code area
    if (pxX >= GUTTER_RIGHT_X) {
      const visLine = Math.floor((CODE_AREA_TOP - pxY) / LINE_H);
      const actualLine = this.renderEngine.scrollOffset + visLine;
      const lineCount = this.renderEngine['getLineCount']();

      if (actualLine >= 0 && actualLine < lineCount) {
        const colApprox = Math.round((pxX - CODE_LEFT_X) / CHAR_W_APPROX);
        const lineText = this.renderEngine['getLineText'](actualLine);
        const col = Math.max(0, Math.min(colApprox, lineText.length));

        this.editBridge.setCursor(actualLine, col);
        this.isSelectingText = true;
      }
    }
  }

  private handlePceTouchDown(region: string, normX: number, normY: number): void {
    this.renderEngine.resetBlink();

    switch (region) {
      case 'code': {
        const pxX = (normX - 0.5) * RENDER_W;
        const pxY = (0.5 - normY) * RENDER_H;
        const visLine = Math.floor((CODE_AREA_TOP - pxY) / LINE_H);
        const actualLine = this.renderEngine.scrollOffset + visLine;
        const lineCount = this.renderEngine['getLineCount']();

        if (actualLine >= 0 && actualLine < lineCount) {
          const colApprox = Math.round((pxX - CODE_LEFT_X) / CHAR_W_APPROX);
          const lineText = this.renderEngine['getLineText'](actualLine);
          const col = Math.max(0, Math.min(colApprox, lineText.length));
          this.editBridge.setCursor(actualLine, col);
          this.isSelectingText = true;
        }
        break;
      }
      case 'file': {
        // normY is 0..1 within file panel area
        const idx = Math.floor(normY * MAX_FILE_ENTRIES);
        this.handleFileClick(idx);
        break;
      }
      case 'minimap': {
        // normY is 0..1 within minimap area
        const pxY = (0.5 - normY) * RENDER_H;
        this.handleMinimapClick(pxY);
        break;
      }
    }
  }

  private handleFileClick(index: number): void {
    if (index < 0 || index >= this.renderEngine.openFiles.length) return;

    // Find the corresponding tab and show its document
    let tabIdx = 0;
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input && typeof (tab.input as any).uri !== 'undefined') {
          if (tabIdx === index) {
            const uri = (tab.input as any).uri as vscode.Uri;
            vscode.window.showTextDocument(uri);
            return;
          }
          tabIdx++;
        }
      }
    }
  }

  private handleMinimapClick(pxY: number): void {
    const totalLines = this.renderEngine['getLineCount']();
    const maxScroll = Math.max(0, totalLines - MAX_VISIBLE_LINES);
    if (maxScroll <= 0) return;

    const scrollFraction = Math.max(0, Math.min(1, (TRACK_TOP - pxY) / TRACK_H));
    this.renderEngine.scrollOffset = Math.round(scrollFraction * maxScroll);
    this.renderEngine.renderScroll();
  }

  private handlePceScroll(delta: number): void {
    const lineCount = this.renderEngine['getLineCount']();
    const maxScroll = Math.max(0, lineCount - MAX_VISIBLE_LINES);
    if (maxScroll <= 0) return;

    const lines = Math.round(delta);
    this.renderEngine.scrollOffset = Math.max(0, Math.min(maxScroll, this.renderEngine.scrollOffset + lines));
    this.renderEngine.renderScroll();
  }

  private handlePointerMove(normX: number, normY: number): void {
    if (!this.isSelectingText) return;

    const pxX = (normX - 0.5) * RENDER_W;
    const pxY = (0.5 - normY) * RENDER_H;

    const visLine = Math.floor((CODE_AREA_TOP - pxY) / LINE_H);
    let actualLine = this.renderEngine.scrollOffset + visLine;
    const lineCount = this.renderEngine['getLineCount']();

    actualLine = Math.max(0, Math.min(lineCount - 1, actualLine));
    const colApprox = Math.round((pxX - CODE_LEFT_X) / CHAR_W_APPROX);
    const lineText = this.renderEngine['getLineText'](actualLine);
    const col = Math.max(0, Math.min(colApprox, lineText.length));

    // Throttle drag renders
    const now = Date.now();
    if (now - this.lastDragRenderTime >= this.DRAG_RENDER_MS) {
      this.lastDragRenderTime = now;
      this.editBridge.extendSelection(actualLine, col);
    }
  }

  private handleTriggerUp(): void {
    this.isSelectingText = false;
  }

  private handleThumbstickAxis(joyY: number): void {
    if (Math.abs(joyY) < 0.15) return;
    const lineCount = this.renderEngine['getLineCount']();
    const scrollableLines = lineCount - MAX_VISIBLE_LINES;
    if (scrollableLines <= 0) return;
    const delta = Math.round(-joyY * 3);
    this.renderEngine.scrollOffset = Math.max(0, Math.min(scrollableLines, this.renderEngine.scrollOffset + delta));
    this.renderEngine.renderScroll();
  }
}
