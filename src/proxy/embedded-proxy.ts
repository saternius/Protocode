import { WebSocketServer, WebSocket } from 'ws';
import { EventEmitter } from 'events';
import type { OutputChannel } from 'vscode';

const PILCROW = '\u00B6';

export interface ProxyEvents {
  message: (raw: string) => void;
  clientConnected: (count: number) => void;
  clientDisconnected: (count: number) => void;
}

export class EmbeddedProxy extends EventEmitter {
  private wss: WebSocketServer | null = null;
  private clients: Set<WebSocket> = new Set();
  private _port: number;
  private log: OutputChannel;

  constructor(port: number, log: OutputChannel) {
    super();
    this._port = port;
    this.log = log;
  }

  get port(): number {
    return this._port;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({ port: this._port });

      this.wss.on('listening', () => {
        this.log.appendLine(`[Proxy] Server listening on port ${this._port}`);
        resolve();
      });
      this.wss.on('error', (err) => {
        this.log.appendLine(`[Proxy] Server error: ${err.message}`);
        reject(err);
      });

      this.wss.on('connection', (ws) => {
        this.clients.add(ws);
        this.log.appendLine(`[Proxy] Client connected (${this.clients.size} total)`);
        this.emit('clientConnected', this.clients.size);

        ws.on('message', (data) => {
          const raw = data.toString();
          const preview = raw.length > 200 ? raw.slice(0, 200) + '...' : raw;
          this.log.appendLine(`[Proxy] ← ${preview}`);
          this.emit('message', raw);
        });

        ws.on('close', () => {
          this.clients.delete(ws);
          this.log.appendLine(`[Proxy] Client disconnected (${this.clients.size} total)`);
          this.emit('clientDisconnected', this.clients.size);
        });

        ws.on('error', (err) => {
          this.log.appendLine(`[Proxy] Client error: ${err.message}`);
          this.clients.delete(ws);
        });
      });
    });
  }

  stop(): void {
    this.log.appendLine(`[Proxy] Stopping server (${this.clients.size} clients)`);
    for (const ws of this.clients) {
      ws.close();
    }
    this.clients.clear();
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
  }

  /** Send tag¶value to all connected Resonite clients */
  send(tag: string, value: string): void {
    const msg = tag + PILCROW + value;
    this.broadcast(msg);
  }

  /** Send float3 as [x; y; z] */
  sendF3(tag: string, x: number, y: number, z: number): void {
    this.send(tag, `[${x}; ${y}; ${z}]`);
  }

  /** Send float2 as [x; y] */
  sendF2(tag: string, x: number, y: number): void {
    this.send(tag, `[${x}; ${y}]`);
  }

  /** Send bool as True/False */
  sendBool(tag: string, val: boolean): void {
    this.send(tag, val ? 'True' : 'False');
  }

  private broadcast(msg: string): void {
    for (const ws of this.clients) {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(msg);
        }
      } catch {
        this.clients.delete(ws);
      }
    }
  }
}
