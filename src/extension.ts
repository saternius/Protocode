import * as vscode from 'vscode';
import * as cp from 'child_process';
import WebSocket from 'ws';
import { EmbeddedProxy } from './proxy/embedded-proxy';
import { StatusBar } from './ui/status-bar';
import { RenderEngine } from './render/render-engine';
import { FileManager } from './editor/file-manager';
import { FileTree } from './editor/file-tree';
import { InputHandler } from './editor/input-handler';
import { EditBridge } from './editor/edit-bridge';
import { CompileManager } from './services/compile-manager';
import { FunctionRunner } from './services/function-runner';
import { RENDER_W, RENDER_H } from './render/display-constants';

let proxy: EmbeddedProxy | null = null;
let statusBar: StatusBar | null = null;
let renderEngine: RenderEngine | null = null;
let fileManager: FileManager | null = null;
let fileTree: FileTree | null = null;
let inputHandler: InputHandler | null = null;
let editBridge: EditBridge | null = null;
let compileManager: CompileManager | null = null;
let functionRunner: FunctionRunner | null = null;
let log: vscode.OutputChannel | null = null;
let extensionUri: vscode.Uri | null = null;
let rlPollInterval: ReturnType<typeof setInterval> | null = null;
let rlConnected: boolean = false;

export function activate(context: vscode.ExtensionContext) {
  log = vscode.window.createOutputChannel('ProtoCode');
  extensionUri = context.extensionUri;
  context.subscriptions.push(log);

  statusBar = new StatusBar();
  context.subscriptions.push({ dispose: () => statusBar?.dispose() });

  // Initialize RL status bar with current config
  const initRlPort = vscode.workspace.getConfiguration('protocode').get<number>('resonitelinkPort', 0);
  statusBar.updateResonitelink(initRlPort, initRlPort ? 'pending' : 'none');

  context.subscriptions.push(
    vscode.commands.registerCommand('protocode.start', () => startProtoCode()),
    vscode.commands.registerCommand('protocode.stop', () => stopProtoCode()),
    vscode.commands.registerCommand('protocode.resizeWindow', () => resizeWindow()),
    vscode.commands.registerCommand('protocode.setWsPort', () => setWsPort()),
    vscode.commands.registerCommand('protocode.setResonitelinkPort', () => setResonitelinkPort()),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('protocode.wsPort')) {
        handleWsPortChange();
      }
      if (e.affectsConfiguration('protocode.resonitelinkPort')) {
        handleResonitelinkPortChange();
      }
      if (e.affectsConfiguration('protocode.verboseProxyLog')) {
        const v = vscode.workspace.getConfiguration('protocode').get<boolean>('verboseProxyLog', false);
        proxy?.setVerbose(v);
      }
    })
  );
}

async function startProtoCode(): Promise<void> {
  if (proxy) {
    vscode.window.showWarningMessage('ProtoCode is already running.');
    return;
  }

  const config = vscode.workspace.getConfiguration('protocode');
  const port = config.get<number>('wsPort', 3001);

  proxy = new EmbeddedProxy(port, log!);
  proxy.setVerbose(config.get<boolean>('verboseProxyLog', false));

  try {
    await proxy.start();
  } catch (err: any) {
    vscode.window.showErrorMessage(`ProtoCode failed to start on port ${port}: ${err.message}`);
    proxy = null;
    return;
  }

  // Create render engine wired to proxy
  renderEngine = new RenderEngine(proxy);

  // Build the file tree for the extension's example/ directory.
  if (extensionUri) {
    fileTree = new FileTree(extensionUri, 'example', log!);
    try {
      await fileTree.build();
      renderEngine.setFileTree(fileTree);
    } catch (err: any) {
      log!.appendLine(`[ProtoCode] FileTree build failed: ${err?.message ?? err}`);
    }
  }

  // Create edit bridge for applying VR input to VSCode
  editBridge = new EditBridge(renderEngine);

  // Create compile manager
  compileManager = new CompileManager(proxy, log!, () => rlConnected);

  // Create function runner (executes JS files from configured functs dir)
  functionRunner = new FunctionRunner(
    proxy,
    log!,
    () => vscode.workspace.getConfiguration('protocode').get<number>('resonitelinkPort', 0),
  );

  // Create input handler to parse Resonite messages
  inputHandler = new InputHandler(editBridge, renderEngine, log!, compileManager, functionRunner);

  // Create file manager to listen to VSCode events
  fileManager = new FileManager(renderEngine, fileTree);

  // Wire proxy incoming messages to input handler
  proxy.on('message', (raw: string) => {
    inputHandler?.handle(raw);
  });

  proxy.on('clientConnected', (count: number) => {
    statusBar?.updateClients(count);
    // Full render when first client connects
    if (count === 1) {
      renderEngine?.fullRender();
    }
  });

  proxy.on('clientDisconnected', (count: number) => {
    statusBar?.updateClients(count);
  });

  // If a Resonite client connected during setup (before the clientConnected
  // listener was wired up), the initial fullRender was missed — force one now.
  if (proxy.clientCount > 0) {
    renderEngine.fullRender();
  }

  statusBar?.showListening(port);
  log!.appendLine(`[ProtoCode] Started on port ${port}`);
  vscode.window.showInformationMessage(`ProtoCode listening on port ${port}`);

  startRlPolling();
}

async function handleWsPortChange(): Promise<void> {
  if (!proxy) { return; } // Not running; new port used on next start
  const config = vscode.workspace.getConfiguration('protocode');
  const newPort = config.get<number>('wsPort', 3001);
  log?.appendLine(`[ProtoCode] wsPort changed to ${newPort}, restarting...`);
  stopProtoCode();
  await startProtoCode();
}

function handleResonitelinkPortChange(): void {
  const config = vscode.workspace.getConfiguration('protocode');
  const port = config.get<number>('resonitelinkPort', 0);

  // Update status bar immediately
  statusBar?.updateResonitelink(port, port ? 'pending' : 'none');

  // Restart polling if proxy is running, otherwise just update UI
  if (proxy) {
    stopRlPolling();
    startRlPolling();
  }
}

async function pingResoniteLink(port: number): Promise<boolean> {
  try {
    return await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`ws://localhost:${port}`);
      const cleanup = () => {
        ws.removeAllListeners();
        ws.terminate();
      };
      const timeout = setTimeout(() => {
        cleanup();
        resolve(false);
      }, 3000);

      ws.on('open', () => {
        ws.send(JSON.stringify({
          $type: 'getSlot',
          messageId: 'ping-' + Date.now(),
          slotId: 'Root',
          depth: 0,
          includeComponentData: false
        }));
      });

      ws.on('message', () => {
        clearTimeout(timeout);
        cleanup();
        resolve(true);
      });

      ws.on('error', () => {
        clearTimeout(timeout);
        cleanup();
        resolve(false);
      });
    });
  } catch {
    return false;
  }
}

function startRlPolling(): void {
  stopRlPolling();

  const config = vscode.workspace.getConfiguration('protocode');
  const port = config.get<number>('resonitelinkPort', 0);

  if (!port) {
    rlConnected = false;
    statusBar?.updateResonitelink(0, 'none');
    proxy?.sendBool('pce_rl', false);
    return;
  }

  const poll = async () => {
    const ok = await pingResoniteLink(port);
    if (ok !== rlConnected) {
      rlConnected = ok;
      statusBar?.updateResonitelink(port, ok ? 'connected' : 'failed');
    }
    proxy?.sendBool('pce_rl', rlConnected);
  };

  poll(); // immediate first check
  rlPollInterval = setInterval(poll, 2000);
}

function stopRlPolling(): void {
  if (rlPollInterval) {
    clearInterval(rlPollInterval);
    rlPollInterval = null;
  }
  rlConnected = false;
}

async function setWsPort(): Promise<void> {
  const config = vscode.workspace.getConfiguration('protocode');
  const current = config.get<number>('wsPort', 3001);
  const input = await vscode.window.showInputBox({
    prompt: 'WebSocket server port',
    value: String(current),
  });
  if (input === undefined) { return; }
  const port = parseInt(input, 10);
  if (isNaN(port) || port <= 0) {
    vscode.window.showErrorMessage('Invalid port number.');
    return;
  }
  await config.update('wsPort', port, vscode.ConfigurationTarget.Global);
}

async function setResonitelinkPort(): Promise<void> {
  const config = vscode.workspace.getConfiguration('protocode');
  const current = config.get<number>('resonitelinkPort', 0);
  const input = await vscode.window.showInputBox({
    prompt: 'ResoniteLink port',
    value: current ? String(current) : '',
  });
  if (input === undefined) { return; }
  const port = parseInt(input, 10);
  if (isNaN(port) || port <= 0) {
    vscode.window.showErrorMessage('Invalid port number.');
    return;
  }
  await config.update('resonitelinkPort', port, vscode.ConfigurationTarget.Global);
}

function stopProtoCode(): void {
  stopRlPolling();

  if (!proxy) {
    vscode.window.showWarningMessage('ProtoCode is not running.');
    return;
  }

  fileManager?.dispose();
  fileManager = null;
  fileTree?.dispose();
  fileTree = null;
  inputHandler = null;
  editBridge = null;
  functionRunner?.dispose();
  functionRunner = null;
  compileManager?.dispose();
  compileManager = null;
  renderEngine?.dispose();
  renderEngine = null;
  proxy.removeAllListeners();
  proxy.stop();
  proxy = null;
  statusBar?.showStopped();
  log?.appendLine('[ProtoCode] Stopped');
  vscode.window.showInformationMessage('ProtoCode stopped.');
}

function resizeWindow(): void {
  const width = RENDER_W + 16;
  const height = RENDER_H + 89;

  if (process.platform === 'win32') {
    const ps = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int W, int H, bool repaint);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
$h = [Win32]::GetForegroundWindow()
$r = New-Object Win32+RECT
[Win32]::GetWindowRect($h, [ref]$r) | Out-Null
[Win32]::MoveWindow($h, $r.Left, $r.Top, ${width}, ${height}, $true) | Out-Null
`;
    cp.spawn('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' });
  } else {
    vscode.window.showInformationMessage(`Resize window to ${width}x${height} (not supported on this platform)`);
  }
}

export function deactivate() {
  stopProtoCode();
}
