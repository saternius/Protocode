import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as util from 'util';
import { EmbeddedProxy } from '../proxy/embedded-proxy';
import { ResoniteLinkClient } from './resonitelink-client';

const FILENAME_RE = /^[\w\-.]+$/;

function esc(s: string): string {
  return s.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Loads JS files from a configured directory and executes them with a minimal
 * runtime context that exposes a shared ResoniteLinkClient and proxy helpers.
 *
 * SECURITY: scripts run fully unsandboxed in the extension host. They can
 * `require('fs')`, `require('child_process')`, etc. The proxy listens on
 * localhost so any local process can trigger this — only run files you trust.
 */
export class FunctionRunner {
  private proxy: EmbeddedProxy;
  private log: vscode.OutputChannel;
  private getRlPort: () => number;

  private rlClient: ResoniteLinkClient | null = null;
  private connectedPort: number | null = null;
  private connectPromise: Promise<void> | null = null;
  private runCount = 0;
  private inFlight = new Set<Promise<void>>();

  constructor(proxy: EmbeddedProxy, log: vscode.OutputChannel, getRlPort: () => number) {
    this.proxy = proxy;
    this.log = log;
    this.getRlPort = getRlPort;
  }

  async run(uniqueId: string, fileName: string, args: string[]): Promise<void> {
    // Validate uniqueId — must round-trip through tag without breaking the wire format
    if (!uniqueId || uniqueId.includes('\u00B6') || uniqueId.includes('\n') || uniqueId.includes('\r')) {
      this.log.appendLine(`[FunctionRunner] rejected invalid uniqueId: ${JSON.stringify(uniqueId)}`);
      return;
    }

    // Single-shot completion callback. Guarantees Resonite always gets exactly
    // one fnCompleted:<id>¶<value> reply, even on early returns / errors / no
    // explicit call from the script.
    let completed = false;
    const completeWith = (value: unknown, source: 'script' | 'auto' | 'error') => {
      if (completed) return;
      completed = true;
      const str = value === undefined || value === null
        ? ''
        : (typeof value === 'string' ? value : String(value));
      this.proxy.send(`fnCompleted:${uniqueId}`, str);
      this.log.appendLine(`[FunctionRunner] fnCompleted (${source}) id=${uniqueId} len=${str.length}`);
    };

    try {
      // 1. Filename charset validation (no slashes, no .., no nulls)
      if (!fileName || !FILENAME_RE.test(fileName)) {
        this.log.appendLine(`[FunctionRunner] rejected invalid filename: ${JSON.stringify(fileName)}`);
        return;
      }

      // 2. Workspace
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        this.log.appendLine('[FunctionRunner] no workspace folder open');
        return;
      }
      const workspaceRoot = workspaceFolder.uri.fsPath;

      // 3. Resolve functs dir (absolute setting overrides workspace root)
      const functsDirSetting = vscode.workspace.getConfiguration('protocode').get<string>('functsDir', 'functs');
      const functsDirAbs = path.resolve(workspaceRoot, functsDirSetting);

      // 4. Resolve target, append .js if missing, containment check
      const withExt = fileName.endsWith('.js') ? fileName : fileName + '.js';
      const target = path.resolve(functsDirAbs, withExt);
      if (target !== functsDirAbs && !target.startsWith(functsDirAbs + path.sep)) {
        this.log.appendLine(`[FunctionRunner] rejected path outside functs dir: ${target}`);
        return;
      }

      // 5. Read file
      let code: string;
      try {
        code = await fs.promises.readFile(target, 'utf8');
      } catch (err: any) {
        this.log.appendLine(`[FunctionRunner] read failed: ${target}: ${err?.message ?? err}`);
        this.proxy.send('pce_rf_status', `<color=#f87171>${esc(fileName + ': ' + (err?.message ?? 'read failed'))}</color>`);
        return;
      }

      // 6. Lazy-connect RL client (non-fatal on failure)
      const client = await this.ensureClient();

      // 7. Build context
      const n = ++this.runCount;
      const tag = `[func:${fileName}#${n}]`;
      const logFn = (msg: unknown) => {
        const text = typeof msg === 'string' ? msg : util.inspect(msg, { depth: 3 });
        this.log.appendLine(`${tag} ${text}`);
      };
      const sendFn = (t: string, value: string) => this.proxy.send(t, value);
      const sendBoolFn = (t: string, value: boolean) => this.proxy.sendBool(t, value);
      const sendF2Fn = (t: string, x: number, y: number) => this.proxy.sendF2(t, x, y);
      const sendF3Fn = (t: string, x: number, y: number, z: number) => this.proxy.sendF3(t, x, y, z);
      const sleepFn = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
      const fnCompletedFn = (value: unknown) => {
        if (completed) {
          this.log.appendLine(`${tag} fnCompleted called more than once, ignoring`);
          return;
        }
        completeWith(value, 'script');
      };
      const rlPort = this.getRlPort();

      // 8. Compile + run
      let wrapper: Function;
      try {
        wrapper = new (Function as any)(
          'client', 'args', 'log', 'send', 'sendBool', 'sendF2', 'sendF3',
          'sleep', 'fnCompleted', 'rlPort', 'workspaceRoot', 'proxy', 'require',
          `return (async () => {\n${code}\n})();`
        );
      } catch (err: any) {
        this.log.appendLine(`${tag} syntax error: ${err?.message ?? err}`);
        this.proxy.send('pce_rf_status', `<color=#f87171>${esc(fileName + ': ' + (err?.message ?? 'syntax error'))}</color>`);
        return;
      }

      this.log.appendLine(`${tag} start (id=${uniqueId}, args=${args.length}, rlPort=${rlPort}, client=${client ? 'connected' : 'null'})`);

      const runPromise = (async () => {
        try {
          await wrapper(
            client, args, logFn, sendFn, sendBoolFn, sendF2Fn, sendF3Fn,
            sleepFn, fnCompletedFn, rlPort, workspaceRoot, this.proxy, require,
          );
          this.log.appendLine(`${tag} done`);
        } catch (err: any) {
          this.log.appendLine(`${tag} error: ${err?.stack ?? err}`);
          this.proxy.send('pce_rf_status', `<color=#f87171>${esc(fileName + ': ' + (err?.message ?? String(err)))}</color>`);
        }
      })();

      this.inFlight.add(runPromise);
      runPromise.finally(() => this.inFlight.delete(runPromise));
      await runPromise;
    } finally {
      // Guarantee Resonite is unblocked even if script never called fnCompleted
      // or if we returned early. The empty-string fallback acts as a sentinel.
      if (!completed) completeWith('', 'auto');
    }
  }

  private async ensureClient(): Promise<ResoniteLinkClient | null> {
    const port = this.getRlPort();
    if (!port) return null;

    // Tear down stale client if port changed
    if (this.rlClient && this.connectedPort !== port) {
      try { this.rlClient.disconnect(); } catch { /* noop */ }
      this.rlClient = null;
      this.connectedPort = null;
      this.connectPromise = null;
    }

    if (this.rlClient?.connected) return this.rlClient;

    if (!this.connectPromise) {
      const client = new ResoniteLinkClient();
      this.connectPromise = client.connect(`ws://localhost:${port}`)
        .then(() => {
          this.rlClient = client;
          this.connectedPort = port;
        })
        .catch((err) => {
          this.log.appendLine(`[FunctionRunner] RL connect failed: ${err?.message ?? err}`);
        })
        .finally(() => {
          this.connectPromise = null;
        });
    }
    await this.connectPromise;
    return this.rlClient;
  }

  dispose(): void {
    if (this.inFlight.size > 0) {
      this.log.appendLine(`[FunctionRunner] dispose with ${this.inFlight.size} active run(s)`);
    }
    if (this.rlClient) {
      try { this.rlClient.disconnect(); } catch { /* noop */ }
    }
    this.rlClient = null;
    this.connectedPort = null;
    this.connectPromise = null;
  }
}
