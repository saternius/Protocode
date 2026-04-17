import WebSocket from 'ws';
import { randomUUID } from 'crypto';

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason: Error) => void;
}

export class ResoniteLinkClient {
  private ws: WebSocket | null = null;
  private _pending = new Map<string, PendingRequest>();
  private _connected = false;

  get connected(): boolean { return this._connected; }

  connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws) this.disconnect();

      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        this._connected = true;
        resolve();
      });

      this.ws.on('message', (data) => {
        let msg: any;
        try { msg = JSON.parse(data.toString()); } catch { return; }

        if (msg.sourceMessageId && this._pending.has(msg.sourceMessageId)) {
          const { resolve: res } = this._pending.get(msg.sourceMessageId)!;
          this._pending.delete(msg.sourceMessageId);
          res(msg);
        }
      });

      this.ws.on('close', () => {
        this._connected = false;
        for (const [, { reject: rej }] of this._pending) {
          rej(new Error('Connection closed'));
        }
        this._pending.clear();
      });

      this.ws.on('error', (err) => {
        this._connected = false;
        reject(new Error(`WebSocket error: ${err.message}`));
      });
    });
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this._connected = false;
  }

  private _send(msg: Record<string, any>): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this._connected || !this.ws) {
        reject(new Error('Not connected'));
        return;
      }
      const messageId = randomUUID();
      msg.messageId = messageId;
      this._pending.set(messageId, { resolve, reject });
      this.ws.send(JSON.stringify(msg));

      setTimeout(() => {
        if (this._pending.has(messageId)) {
          this._pending.delete(messageId);
          reject(new Error(`Request timed out: ${msg.$type}`));
        }
      }, 10000);
    });
  }

  async getSlot(slotId: string, opts: { depth?: number; includeComponentData?: boolean } = {}): Promise<any> {
    const res = await this._send({
      $type: 'getSlot', slotId,
      depth: opts.depth ?? 0,
      includeComponentData: opts.includeComponentData ?? false,
    });
    if (!res.success) throw new Error(res.error || 'getSlot failed');
    return res.data;
  }

  async addSlot(parentId: string, name: string, opts: { position?: { x: number; y: number; z: number } } = {}): Promise<any> {
    const data: any = {
      parent: { targetId: parentId },
      name: { value: name },
    };
    if (opts.position) data.position = { value: opts.position };
    const res = await this._send({ $type: 'addSlot', data });
    if (!res.success) throw new Error(res.errorInfo || res.error || 'addSlot failed');
    return res.data || { id: res.entityId };
  }

  async addComponent(slotId: string, componentType: string): Promise<any> {
    const res = await this._send({
      $type: 'addComponent',
      containerSlotId: slotId,
      data: { componentType },
    });
    if (!res.success) throw new Error(res.errorInfo || res.error || 'addComponent failed');
    return res.data || { id: res.entityId };
  }

  async getComponent(componentId: string): Promise<any> {
    const res = await this._send({ $type: 'getComponent', componentId });
    if (!res.success) throw new Error(res.error || 'getComponent failed');
    return res.data;
  }

  async updateComponent(componentId: string, members: Record<string, any>): Promise<any> {
    const res = await this._send({
      $type: 'updateComponent',
      data: { id: componentId, members },
    });
    if (!res.success) throw new Error(res.errorInfo || res.error || 'updateComponent failed');
    return res.data;
  }

  // ResoniteLink does not expose Resonite's clientside RefIDs, so the deployer
  // must resolve a dropped slot reference (which arrives as "<name> (<refID>)")
  // by crawling the hierarchy and matching on name. Returns every match so the
  // caller can detect ambiguity.
  async findSlotsByName(name: string, startSlotId = 'Root'): Promise<any[]> {
    const root = await this.getSlot(startSlotId, { depth: -1, includeComponentData: false });
    const matches: any[] = [];
    const walk = (slot: any) => {
      if (slot?.name?.value === name) matches.push(slot);
      if (Array.isArray(slot?.children)) for (const c of slot.children) walk(c);
    };
    walk(root);
    return matches;
  }

  async updateSlot(slotId: string, props: {
    name?: string;
    position?: { x: number; y: number; z: number };
    rotation?: { x: number; y: number; z: number; w: number };
    scale?: { x: number; y: number; z: number };
    isActive?: boolean;
  }): Promise<any> {
    const data: any = { id: slotId };
    if (props.name !== undefined) data.name = { value: props.name };
    if (props.position) data.position = { value: props.position };
    if (props.rotation) data.rotation = { value: props.rotation };
    if (props.scale) data.scale = { value: props.scale };
    if (props.isActive !== undefined) data.isActive = { value: props.isActive };
    const res = await this._send({ $type: 'updateSlot', data });
    if (!res.success) throw new Error(res.errorInfo || res.error || 'updateSlot failed');
    return res.data;
  }
}
