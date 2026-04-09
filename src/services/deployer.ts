import type { OutputChannel } from 'vscode';
import type { ResoniteLinkClient } from './resonitelink-client';
import type { CompileResult } from './compile-service';

interface WireEntry {
  newCompId: string;
  memberName: string;
  oldTargetId: string;
}

interface DeployStats {
  slots: number;
  components: number;
  wires: number;
}

interface SlotPlanEntry {
  newSlotId: string;
  slotObj: any;
}

export interface DeployResult {
  groupId: string;
  slots: number;
  components: number;
  wires: number;
}

export class Deployer {
  private log: OutputChannel;
  onProgress: ((msg: string) => void) | null = null;

  private static SKIP_MEMBERS = new Set(['ID', 'persistant-ID', 'UpdateOrder', 'Enabled']);

  constructor(log: OutputChannel) {
    this.log = log;
  }

  private _log(message: string): void {
    this.log.appendLine(`[Deploy] ${message}`);
    if (this.onProgress) this.onProgress(message);
  }

  async deploy(
    client: ResoniteLinkClient,
    compileResult: CompileResult,
    parentSlotId: string,
    moduleName: string,
  ): Promise<DeployResult | null> {
    if (!compileResult.success) {
      this._log('Cannot deploy: compilation failed');
      return null;
    }

    if (!compileResult.recordJson) {
      this._log('No record data available for deployment');
      return null;
    }

    this._log(`Deploying "${moduleName}" (${compileResult.nodeCount} nodes)...`);

    try {
      const record = compileResult.recordJson;
      const types: string[] = record.Types || [];
      const rootObj = record.Object;

      if (!rootObj) {
        this._log('Record has no Object data');
        return null;
      }

      // Phase 1: Collect old component IDs
      this._log('Phase 1: Collecting component IDs...');
      const oldCompIds = new Set<string>();
      this.collectComponentIds(rootObj, oldCompIds);
      this._log(`Found ${oldCompIds.size} component IDs in record`);

      // Phase 2: Create all slots
      this._log('Phase 2: Creating slot hierarchy...');
      const groupSlot = await client.addSlot(parentSlotId, moduleName);
      const groupId = groupSlot.id;
      this._log(`Group slot created: ${groupId}`);

      const slotPlan: SlotPlanEntry[] = [];
      const stats: DeployStats = { slots: 0, components: 0, wires: 0 };

      await this.createSlots(client, rootObj, groupId, slotPlan, stats);
      this._log(`Created ${stats.slots} slots`);

      // Phase 3: Add components, build ID map
      this._log(`Phase 3: Adding components to ${slotPlan.length} slots...`);
      const idMap = new Map<string, string>();
      const wireQueue: WireEntry[] = [];

      for (const { newSlotId, slotObj } of slotPlan) {
        if (!slotObj.Components?.Data) continue;
        for (const comp of slotObj.Components.Data) {
          const compType = types[comp.Type];
          if (!compType) continue;

          const oldId = comp.Data?.ID;

          try {
            const newComp = await client.addComponent(newSlotId, compType);
            const newId = newComp.id;
            stats.components++;

            if (oldId) idMap.set(oldId, newId);

            this.scanForRefs(comp.Data, newId, oldCompIds, wireQueue);
          } catch (err: any) {
            const shortType = compType.split('.').pop();
            this._log(`  Failed: ${shortType} on slot ${newSlotId}: ${err.message}`);
          }
        }
      }
      this._log(`Added ${stats.components} components`);

      // Phase 4: Wire references
      if (wireQueue.length > 0) {
        this._log(`Phase 4: Wiring ${wireQueue.length} references...`);

        for (const wire of wireQueue) {
          const newTargetId = idMap.get(wire.oldTargetId);
          if (!newTargetId) continue;
          try {
            await client.updateComponent(wire.newCompId, {
              [wire.memberName]: { $type: 'reference', targetId: newTargetId },
            });
            stats.wires++;
          } catch (err: any) {
            this._log(`  Wire failed ${wire.memberName}: ${err.message}`);
          }
        }
        this._log(`Wired ${stats.wires}/${wireQueue.length} references`);
      } else {
        this._log('Phase 4: No references to wire');
      }

      this._log(`Deploy complete: ${stats.slots} slots, ${stats.components} components, ${stats.wires} wires`);
      return { groupId, ...stats };

    } catch (err: any) {
      this._log(`Deployment failed: ${err.message}`);
      return null;
    }
  }

  private collectComponentIds(slotObj: any, ids: Set<string>): void {
    if (slotObj.Components?.Data) {
      for (const comp of slotObj.Components.Data) {
        if (comp.Data?.ID) ids.add(comp.Data.ID);
      }
    }
    if (slotObj.Children) {
      for (const child of slotObj.Children) this.collectComponentIds(child, ids);
    }
  }

  private async createSlots(
    client: ResoniteLinkClient,
    slotObj: any,
    parentId: string,
    slotPlan: SlotPlanEntry[],
    stats: DeployStats,
  ): Promise<void> {
    const name = slotObj.Name?.Data ?? 'Unnamed';
    const isActive = slotObj.Active?.Data ?? true;

    const posArr = slotObj.Position?.Data;
    const position = posArr
      ? { x: posArr[0] || 0, y: posArr[1] || 0, z: posArr[2] || 0 }
      : undefined;

    const slot = await client.addSlot(parentId, name, { position });
    stats.slots++;

    if (!isActive) {
      await client.updateSlot(slot.id, { isActive: false });
    }

    const scaleArr = slotObj.Scale?.Data;
    if (scaleArr && (scaleArr[0] !== 1 || scaleArr[1] !== 1 || scaleArr[2] !== 1)) {
      await client.updateSlot(slot.id, {
        scale: { x: scaleArr[0], y: scaleArr[1], z: scaleArr[2] },
      });
    }

    slotPlan.push({ newSlotId: slot.id, slotObj });

    if (slotObj.Children) {
      for (const child of slotObj.Children) {
        await this.createSlots(client, child, slot.id, slotPlan, stats);
      }
    }
  }

  private scanForRefs(compData: any, newCompId: string, oldCompIds: Set<string>, wireQueue: WireEntry[]): void {
    if (!compData) return;
    for (const [memberName, memberVal] of Object.entries(compData)) {
      if (Deployer.SKIP_MEMBERS.has(memberName)) continue;
      if (memberVal === null || typeof memberVal !== 'object') continue;

      const val = memberVal as any;
      if (typeof val.Data === 'string' && oldCompIds.has(val.Data)) {
        wireQueue.push({ newCompId, memberName, oldTargetId: val.Data });
      }
    }
  }
}
