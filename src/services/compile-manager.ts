import * as vscode from 'vscode';
import * as path from 'path';
import { EmbeddedProxy } from '../proxy/embedded-proxy';
import { CompileService } from './compile-service';
import { Deployer } from './deployer';
import { ResoniteLinkClient } from './resonitelink-client';

function esc(s: string): string {
  return s.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export class CompileManager {
  private proxy: EmbeddedProxy;
  private compileService: CompileService;
  private log: vscode.OutputChannel;
  private getRlConnected: () => boolean;
  private windowVisible = false;
  private disposables: vscode.Disposable[] = [];

  constructor(proxy: EmbeddedProxy, log: vscode.OutputChannel, getRlConnected: () => boolean) {
    this.proxy = proxy;
    this.log = log;
    this.getRlConnected = getRlConnected;
    this.compileService = new CompileService(log);

    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => {
        if (this.windowVisible) this.updateWindowState();
      })
    );
  }

  toggleWindow(): void {
    this.windowVisible = !this.windowVisible;
    this.proxy.sendBool('pce_cw_active', this.windowVisible);
    if (this.windowVisible) this.updateWindowState();
  }

  updateWindowState(): void {
    const doc = vscode.window.activeTextEditor?.document;
    const fileName = doc ? path.basename(doc.fileName) : 'No file';
    const isPg = fileName.endsWith('.pg');

    this.proxy.send('pce_cw_file', isPg
      ? `<color=#4ade80>${esc(fileName)}</color>`
      : `<color=#f87171>${esc(fileName)}</color>`);

    const config = vscode.workspace.getConfiguration('protocode');
    const rlPort = config.get<number>('resonitelinkPort', 0);
    const rlOk = this.getRlConnected();

    this.proxy.send('pce_cw_rl', rlOk
      ? `<color=#4ade80>Connected :${rlPort}</color>`
      : `<color=#f87171>Disconnected</color>`);
  }

  async compileLocal(): Promise<void> {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc) {
      this.sendStatus('<color=#f87171>No active file</color>');
      return;
    }

    const fileName = path.basename(doc.fileName);
    if (!fileName.endsWith('.pg')) {
      this.sendStatus(`<color=#f87171>${esc(fileName)} is not a .pg file</color>`);
      return;
    }

    this.sendStatus('<color=#facc15>Compiling...</color>');

    const source = doc.getText();
    const moduleName = fileName.replace(/\.pg$/, '');

    // Output to workspace out/<module>/
    const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const outDir = wsFolder
      ? path.join(wsFolder, 'out', moduleName)
      : null;

    const result = outDir
      ? await this.compileService.compileToDir(source, moduleName, outDir)
      : await this.compileService.compile(source, moduleName);

    if (result.success) {
      let msg = `<color=#4ade80>OK</color> ${result.nodeCount} nodes`;
      if (result.warnings.length > 0) {
        msg += `\n<color=#facc15>${result.warnings.length} warning(s)</color>`;
      }
      if (outDir) {
        msg += `\n<color=#94a3b8>Output: out/${moduleName}/</color>`;
      }
      this.sendStatus(msg);
    } else {
      let msg = `<color=#f87171>${result.errors.length} error(s)</color>`;
      for (const e of result.errors.slice(0, 5)) {
        const loc = e.startLine ? ` L${e.startLine}:${e.startCol}` : '';
        msg += `\n<color=#f87171>${loc} ${esc(e.message)}</color>`;
      }
      if (result.errors.length > 5) {
        msg += `\n<color=#94a3b8>...and ${result.errors.length - 5} more</color>`;
      }
      this.sendStatus(msg);
    }

    this.updateWindowState();
  }

  async compileAndDeploy(refFieldCompId: string): Promise<void> {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc) {
      this.sendStatus('<color=#f87171>No active file</color>');
      return;
    }

    const fileName = path.basename(doc.fileName);
    if (!fileName.endsWith('.pg')) {
      this.sendStatus(`<color=#f87171>${esc(fileName)} is not a .pg file</color>`);
      return;
    }

    if (!this.getRlConnected()) {
      this.sendStatus('<color=#f87171>ResoniteLink not connected</color>');
      return;
    }

    const config = vscode.workspace.getConfiguration('protocode');
    const rlPort = config.get<number>('resonitelinkPort', 0);
    if (!rlPort) {
      this.sendStatus('<color=#f87171>ResoniteLink port not configured</color>');
      return;
    }

    // Step 1: Compile
    this.sendStatus('<color=#facc15>Compiling...</color>');
    const source = doc.getText();
    const moduleName = fileName.replace(/\.pg$/, '');
    const result = await this.compileService.compile(source, moduleName);

    if (!result.success) {
      let msg = `<color=#f87171>${result.errors.length} error(s)</color>`;
      for (const e of result.errors.slice(0, 5)) {
        const loc = e.startLine ? ` L${e.startLine}:${e.startCol}` : '';
        msg += `\n<color=#f87171>${loc} ${esc(e.message)}</color>`;
      }
      this.sendStatus(msg);
      return;
    }

    this.sendStatus(`<color=#4ade80>Compiled</color> ${result.nodeCount} nodes\n<color=#facc15>Connecting to RL...</color>`);

    // Step 2: Connect to ResoniteLink
    const rlClient = new ResoniteLinkClient();
    try {
      await rlClient.connect(`ws://localhost:${rlPort}`);
    } catch (err: any) {
      this.sendStatus(`<color=#f87171>RL connect failed: ${esc(err.message)}</color>`);
      return;
    }

    try {
      // Step 3: Read target slot from ReferenceField
      this.sendStatus(`<color=#4ade80>Compiled</color> ${result.nodeCount} nodes\n<color=#facc15>Reading target slot...</color>`);

      const refComp = await rlClient.getComponent(refFieldCompId);
      const targetId = refComp?.members?.Reference?.targetId;
      if (!targetId) {
        this.sendStatus('<color=#f87171>No target slot selected. Drop a slot onto the Target Slot field.</color>');
        return;
      }

      // Step 4: Deploy
      const deployer = new Deployer(this.log);
      deployer.onProgress = (msg) => {
        this.sendStatus(`<color=#4ade80>Compiled</color> ${result.nodeCount} nodes\n<color=#facc15>${esc(msg)}</color>`);
      };

      const deployResult = await deployer.deploy(rlClient, result, targetId, moduleName);
      if (deployResult) {
        this.sendStatus(
          `<color=#4ade80>Deployed!</color>\n` +
          `${deployResult.slots} slots, ${deployResult.components} components, ${deployResult.wires} wires`
        );
      } else {
        this.sendStatus('<color=#f87171>Deployment failed (see output log)</color>');
      }
    } finally {
      rlClient.disconnect();
    }

    this.updateWindowState();
  }

  private sendStatus(text: string): void {
    this.proxy.send('pce_cw_status', text);
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }
}
