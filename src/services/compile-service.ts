import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import type { OutputChannel } from 'vscode';

export interface Diagnostic {
  startLine?: number;
  startCol?: number;
  endLine?: number;
  endCol?: number;
  severity?: string;
  message: string;
}

export interface CompileResult {
  success: boolean;
  errors: Diagnostic[];
  warnings: Diagnostic[];
  nodeCount: number;
  recordJson: any | null;
  componentIR: string;
  rawOutput: string;
}

export class CompileService {
  private log: OutputChannel;

  constructor(log: OutputChannel) {
    this.log = log;
  }

  async compile(source: string, filename: string): Promise<CompileResult> {
    return this._compile(source, filename, null);
  }

  async compileToDir(source: string, filename: string, outDir: string): Promise<CompileResult> {
    return this._compile(source, filename, outDir);
  }

  private _compile(source: string, filename: string, outDir: string | null): Promise<CompileResult> {
    return new Promise((resolve) => {
      const tmpDir = path.join(os.tmpdir(), `pg_${randomUUID()}`);
      fs.mkdirSync(tmpDir, { recursive: true });

      const moduleMatch = source.match(/^\s*module\s+([A-Z][A-Za-z0-9_]*)/m);
      const detectedName = moduleMatch ? moduleMatch[1] : null;
      const safeName = (detectedName || filename || 'Untitled').replace(/[^a-zA-Z0-9_]/g, '') || 'Untitled';
      const srcFile = path.join(tmpDir, `${safeName}.pg`);
      const brsonFile = path.join(tmpDir, `${safeName}.brson`);
      const debugFile = path.join(tmpDir, `${safeName}_debug.json`);
      const componentFile = path.join(tmpDir, `${safeName}_components.txt`);

      fs.writeFileSync(srcFile, source, 'utf8');

      const args = [
        'build',
        '--compact-error-messages',
        '--out', brsonFile,
        '--record-debug', debugFile,
        '--component-debug', componentFile,
        '--layout-engine', 'builtin',
        '--skip-restore',
        srcFile,
      ];

      this.log.appendLine(`[Compile] Running: flux-sdk ${args.join(' ')}`);

      const child = spawn('flux-sdk', args, { shell: true, timeout: 30000 });
      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });

      child.on('close', (code) => {
        const output = stdout + stderr;
        const result = this.parseOutput(output, code ?? 1, debugFile, componentFile);

        // Copy output files if outDir specified and compile succeeded
        if (outDir && result.success) {
          try {
            fs.mkdirSync(outDir, { recursive: true });
            if (fs.existsSync(brsonFile)) {
              fs.copyFileSync(brsonFile, path.join(outDir, `${safeName}.brson`));
            }
            if (fs.existsSync(debugFile)) {
              fs.copyFileSync(debugFile, path.join(outDir, `${safeName}_debug.json`));
            }
            if (fs.existsSync(componentFile)) {
              fs.copyFileSync(componentFile, path.join(outDir, `${safeName}_components.txt`));
            }
          } catch (err: any) {
            this.log.appendLine(`[Compile] Failed to copy output files: ${err.message}`);
          }
        }

        // Cleanup temp dir
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

        resolve(result);
      });

      child.on('error', (err) => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
        resolve({
          success: false,
          errors: [{ message: `Failed to run flux-sdk: ${err.message}` }],
          warnings: [],
          nodeCount: 0,
          recordJson: null,
          componentIR: '',
          rawOutput: '',
        });
      });
    });
  }

  private parseOutput(output: string, exitCode: number, debugFile: string, componentFile: string): CompileResult {
    const errors: Diagnostic[] = [];
    const warnings: Diagnostic[] = [];
    let nodeCount = 0;

    const diagnosticRe = /[^(]+\((\d+),(\d+),(\d+),(\d+)\):\s*(error|warning):\s*(.+)/g;
    let match;
    while ((match = diagnosticRe.exec(output)) !== null) {
      const diag: Diagnostic = {
        startLine: parseInt(match[1]),
        startCol: parseInt(match[2]),
        endLine: parseInt(match[3]),
        endCol: parseInt(match[4]),
        severity: match[5],
        message: match[6].trim(),
      };
      if (diag.severity === 'error') errors.push(diag);
      else warnings.push(diag);
    }

    if (output.includes('Compilation failed')) {
      const failMatch = output.match(/Compilation failed[^\n]*/);
      if (failMatch && errors.length === 0) {
        errors.push({ message: failMatch[0] });
      }
    }

    const nodeMatch = output.match(/Packing (\d+) ProtoFlux nodes/);
    if (nodeMatch) nodeCount = parseInt(nodeMatch[1]);

    let componentIR = '';
    try { componentIR = fs.readFileSync(componentFile, 'utf8'); } catch {}

    let recordJson = null;
    try { recordJson = JSON.parse(fs.readFileSync(debugFile, 'utf8')); } catch {}

    // Deduplicate
    const seen = new Set<string>();
    const uniqueErrors = errors.filter(e => {
      const key = `${e.startLine}:${e.startCol}:${e.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const seenW = new Set<string>();
    const uniqueWarnings = warnings.filter(w => {
      const key = `${w.startLine}:${w.startCol}:${w.message}`;
      if (seenW.has(key)) return false;
      seenW.add(key);
      return true;
    });

    const success = exitCode === 0 && uniqueErrors.length === 0;

    return {
      success,
      errors: uniqueErrors,
      warnings: uniqueWarnings,
      nodeCount,
      componentIR,
      recordJson,
      rawOutput: output,
    };
  }
}
