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
      // Temp dir only holds the source file — flux-sdk output goes straight to outDir
      // (or to tmpDir when no outDir was provided, for ephemeral compiles like Compile RL).
      const tmpDir = path.join(os.tmpdir(), `pg_${randomUUID()}`);
      fs.mkdirSync(tmpDir, { recursive: true });

      const moduleMatch = source.match(/^\s*module\s+([A-Z][A-Za-z0-9_]*)/m);
      const detectedName = moduleMatch ? moduleMatch[1] : null;
      const safeName = (detectedName || filename || 'Untitled').replace(/[^a-zA-Z0-9_]/g, '') || 'Untitled';
      const srcFile = path.join(tmpDir, `${safeName}.pg`);

      const outputDir = outDir ?? tmpDir;
      if (outDir) {
        try {
          fs.mkdirSync(outDir, { recursive: true });
        } catch (err: any) {
          fs.rmSync(tmpDir, { recursive: true, force: true });
          resolve({
            success: false,
            errors: [{ message: `Failed to create output directory ${outDir}: ${err.message}` }],
            warnings: [],
            nodeCount: 0,
            recordJson: null,
            componentIR: '',
            rawOutput: '',
          });
          return;
        }
      }

      const brsonFile = path.join(outputDir, `${safeName}.brson`);
      const debugFile = path.join(outputDir, `${safeName}_debug.json`);
      const componentFile = path.join(outputDir, `${safeName}_components.txt`);

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
      this.log.appendLine(`[Compile] cwd: ${tmpDir}`);

      // cwd must be tmpDir: flux-sdk uses cwd as the project directory and resolves
      // the target .pg path relative to it. Inheriting cwd from the extension host
      // lands us in a workspace with no relation to the temp source, and flux-sdk
      // fails with "not found at expected path" (see INTERNAL.pg error).
      const child = spawn('flux-sdk', args, { shell: true, timeout: 30000, cwd: tmpDir });
      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });

      child.on('close', (code) => {
        const output = stdout + stderr;
        const result = this.parseOutput(output, code ?? 1, debugFile, componentFile);

        // Cleanup temp source dir (output files live in outputDir which we keep)
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
