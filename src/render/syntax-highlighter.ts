// One Dark theme colors
const C_KEYWORD = '#c678dd';
const C_STRING  = '#98c379';
const C_NUMBER  = '#d19a66';
const C_COMMENT = '#5c6370';
const C_FUNC    = '#61afef';
const C_THIS    = '#e06c75';
const C_DEFAULT = '#abb2bf';
const C_BOOL    = '#d19a66';

// --- JavaScript ---

const JS_KEYWORDS = new Set([
  'function', 'const', 'let', 'var', 'if', 'else', 'return', 'for', 'while', 'do',
  'switch', 'case', 'break', 'continue', 'async', 'await', 'this', 'new', 'class',
  'import', 'export', 'from', 'default', 'throw', 'try', 'catch', 'finally',
  'typeof', 'instanceof', 'in', 'of', 'delete', 'void', 'yield',
]);
const JS_BOOLEANS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity']);

// --- ProtoGraph ---

const PG_KEYWORDS = new Set([
  'module', 'in', 'out', 'where', 'sync', 'use', 'from', 'as',
  'switch', 'impulse', 'if', 'then', 'else',
  'pack', 'element', 'global', 'this',
]);
const PG_TYPES = new Set([
  'int', 'float', 'string', 'bool',
  'float2', 'float3', 'float4', 'floatQ', 'colorX',
  'slot', 'user', 'object',
  'int2', 'int3', 'int4',
  'double', 'long', 'ulong', 'byte', 'short', 'ushort', 'uint',
]);
const PG_WORD_OPS = new Set([
  'mod', 'and', 'or', 'xor', 'not', 'nor', 'nand', 'xnor',
]);
const PG_BOOLEANS = new Set(['true', 'false', 'null']);

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

function highlightJS(line: string): string {
  if (!line) return '';
  let result = '';
  let i = 0;
  const len = line.length;

  while (i < len) {
    // Single-line comment
    if (line[i] === '/' && line[i + 1] === '/') {
      result += `<color=${C_COMMENT}>${escHtml(line.substring(i))}</color>`;
      break;
    }

    // String (single, double, backtick)
    if (line[i] === '"' || line[i] === "'" || line[i] === '`') {
      const quote = line[i];
      let j = i + 1;
      while (j < len && line[j] !== quote) {
        if (line[j] === '\\') j++; // skip escaped char
        j++;
      }
      if (j < len) j++; // include closing quote
      result += `<color=${C_STRING}>${escHtml(line.substring(i, j))}</color>`;
      i = j;
      continue;
    }

    // Number
    if (/[0-9]/.test(line[i]) && (i === 0 || !/[a-zA-Z_$]/.test(line[i - 1]))) {
      let j = i;
      while (j < len && /[0-9.xXa-fA-F_]/.test(line[j])) j++;
      result += `<color=${C_NUMBER}>${escHtml(line.substring(i, j))}</color>`;
      i = j;
      continue;
    }

    // Word (identifier / keyword)
    if (/[a-zA-Z_$]/.test(line[i])) {
      let j = i;
      while (j < len && /[a-zA-Z0-9_$]/.test(line[j])) j++;
      const word = line.substring(i, j);

      if (word === 'this') {
        result += `<color=${C_THIS}>${word}</color>`;
      } else if (JS_KEYWORDS.has(word)) {
        result += `<color=${C_KEYWORD}>${word}</color>`;
      } else if (JS_BOOLEANS.has(word)) {
        result += `<color=${C_BOOL}>${word}</color>`;
      } else if (j < len && line[j] === '(') {
        result += `<color=${C_FUNC}>${escHtml(word)}</color>`;
      } else {
        result += `<color=${C_DEFAULT}>${escHtml(word)}</color>`;
      }
      i = j;
      continue;
    }

    // Default: operators, punctuation, whitespace
    result += `<color=${C_DEFAULT}>${escHtml(line[i])}</color>`;
    i++;
  }
  return result;
}

function highlightPG(line: string): string {
  if (!line) return '';
  let result = '';
  let i = 0;
  const len = line.length;

  while (i < len) {
    // Doc comment (///)
    if (line[i] === '/' && line[i + 1] === '/' && line[i + 2] === '/') {
      result += `<color=${C_COMMENT}>${escHtml(line.substring(i))}</color>`;
      break;
    }

    // Line comment (//)
    if (line[i] === '/' && line[i + 1] === '/') {
      result += `<color=${C_COMMENT}>${escHtml(line.substring(i))}</color>`;
      break;
    }

    // Interpolated string ($"...")
    if (line[i] === '$' && line[i + 1] === '"') {
      let j = i + 2;
      let str = '$"';
      while (j < len && line[j] !== '"') {
        if (line[j] === '\\') { str += line[j] + (line[j + 1] || ''); j += 2; continue; }
        str += line[j];
        j++;
      }
      if (j < len) { str += '"'; j++; }
      result += `<color=${C_STRING}>${escHtml(str)}</color>`;
      i = j;
      continue;
    }

    // Regular string ("...")
    if (line[i] === '"') {
      let j = i + 1;
      while (j < len && line[j] !== '"') {
        if (line[j] === '\\') j++;
        j++;
      }
      if (j < len) j++;
      result += `<color=${C_STRING}>${escHtml(line.substring(i, j))}</color>`;
      i = j;
      continue;
    }

    // Number (float)
    if (/[0-9]/.test(line[i]) && (i === 0 || !/[a-zA-Z_]/.test(line[i - 1]))) {
      let j = i;
      while (j < len && /[0-9.]/.test(line[j])) j++;
      if (j < len && line[j] === 'f') j++;
      result += `<color=${C_NUMBER}>${escHtml(line.substring(i, j))}</color>`;
      i = j;
      continue;
    }

    // Arrow operators (->, |>, <-)
    if ((line[i] === '-' && line[i + 1] === '>') ||
        (line[i] === '|' && line[i + 1] === '>') ||
        (line[i] === '<' && line[i + 1] === '-')) {
      result += `<color=${C_KEYWORD}>${escHtml(line.substring(i, i + 2))}</color>`;
      i += 2;
      continue;
    }

    // Word (identifier / keyword / type)
    if (/[a-zA-Z_]/.test(line[i])) {
      let j = i;
      while (j < len && /[a-zA-Z0-9_]/.test(line[j])) j++;
      const word = line.substring(i, j);

      if (PG_BOOLEANS.has(word)) {
        result += `<color=${C_BOOL}>${word}</color>`;
      } else if (PG_KEYWORDS.has(word)) {
        result += `<color=${C_KEYWORD}>${word}</color>`;
      } else if (PG_TYPES.has(word)) {
        result += `<color=${C_FUNC}>${word}</color>`;
      } else if (PG_WORD_OPS.has(word)) {
        result += `<color=${C_KEYWORD}>${word}</color>`;
      } else if (/^[A-Z]/.test(word)) {
        // PascalCase → type/node name
        result += `<color=${C_FUNC}>${escHtml(word)}</color>`;
      } else {
        result += `<color=${C_DEFAULT}>${escHtml(word)}</color>`;
      }
      i = j;
      continue;
    }

    // Default
    result += `<color=${C_DEFAULT}>${escHtml(line[i])}</color>`;
    i++;
  }
  return result;
}

const CACHE_MAX = 3000;
const CACHE_EVICT = 500;

export type HighlightLang = 'js' | 'pg';

export class SyntaxHighlighter {
  private cache: Map<string, string> = new Map();
  private _enabled: boolean = true;
  private _lang: HighlightLang = 'js';

  get enabled(): boolean { return this._enabled; }
  set enabled(v: boolean) { this._enabled = v; }

  get lang(): HighlightLang { return this._lang; }
  set lang(v: HighlightLang) {
    if (this._lang !== v) {
      this._lang = v;
      this.cache.clear();
    }
  }

  highlight(line: string): string {
    if (!line) return '';
    if (!this._enabled) {
      return `<color=${C_DEFAULT}>${escHtml(line)}</color>`;
    }

    const cached = this.cache.get(line);
    if (cached !== undefined) return cached;

    if (this.cache.size >= CACHE_MAX) {
      let evicted = 0;
      for (const k of this.cache.keys()) {
        this.cache.delete(k);
        if (++evicted >= CACHE_EVICT) break;
      }
    }

    const result = this._lang === 'pg' ? highlightPG(line) : highlightJS(line);
    this.cache.set(line, result);
    return result;
  }

  clearCache(): void {
    this.cache.clear();
  }
}
