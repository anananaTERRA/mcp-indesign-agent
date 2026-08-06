import { randomUUID } from "node:crypto";
import type { DocumentItem, DocumentModel } from "./document-model.js";

export type SnapshotLabel = "before" | "after" | string;

export interface SnapshotMeta {
  id: string;
  label: SnapshotLabel;
  capturedAt: string;
  generation: string;
  itemCount: number;
  documentName: string;
}

export interface Snapshot extends SnapshotMeta {
  model: DocumentModel;
}

export interface ItemDiff {
  uuid: string;
  type: string;
  pageIndex: number;
  changes: string[];
}

export interface SnapshotDiff {
  beforeId: string;
  afterId: string;
  beforeLabel: string;
  afterLabel: string;
  added: Array<{ uuid: string; type: string; pageIndex: number; textPreview: string }>;
  removed: Array<{ uuid: string; type: string; pageIndex: number; textPreview: string }>;
  modified: ItemDiff[];
  selectionChanged: boolean;
  selectionBefore: string[];
  selectionAfter: string[];
  summaryLines: string[];
}

function cloneModel(model: DocumentModel): DocumentModel {
  return structuredClone(model);
}

function boundsKey(b: DocumentItem["bounds"]): string {
  if (!b) return "";
  return `${b.y1},${b.x1},${b.y2},${b.x2}`;
}

function diffItems(before: DocumentItem, after: DocumentItem): string[] {
  const changes: string[] = [];
  if (before.pageIndex !== after.pageIndex) {
    changes.push(`page ${before.pageIndex} → ${after.pageIndex}`);
  }
  if (boundsKey(before.bounds) !== boundsKey(after.bounds)) {
    changes.push("bounds changed");
  }
  if (before.textPreview !== after.textPreview) {
    changes.push(
      `text: "${truncate(before.textPreview)}" → "${truncate(after.textPreview)}"`,
    );
  }
  if (before.type !== after.type) {
    changes.push(`type ${before.type} → ${after.type}`);
  }
  if ((before.paragraphStyle ?? "") !== (after.paragraphStyle ?? "")) {
    changes.push(
      `paragraphStyle: ${before.paragraphStyle ?? "(none)"} → ${after.paragraphStyle ?? "(none)"}`,
    );
  }
  if (before.parentUuid !== after.parentUuid) {
    changes.push("parent/group changed");
  }
  return changes;
}

function truncate(s: string, n = 40): string {
  if (!s) return "";
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export class SnapshotStore {
  private snapshots: Snapshot[] = [];
  private lastBeforeId: string | null = null;
  private lastAfterId: string | null = null;

  capture(label: SnapshotLabel, model: DocumentModel): Snapshot {
    const snap: Snapshot = {
      id: randomUUID(),
      label,
      capturedAt: new Date().toISOString(),
      generation: model.meta.generation,
      itemCount: model.items.length,
      documentName: model.meta.name,
      model: cloneModel(model),
    };
    this.snapshots.push(snap);
    if (label === "before") this.lastBeforeId = snap.id;
    if (label === "after") this.lastAfterId = snap.id;
    return snap;
  }

  list(): SnapshotMeta[] {
    return this.snapshots.map(
      ({ id, label, capturedAt, generation, itemCount, documentName }) => ({
        id,
        label,
        capturedAt,
        generation,
        itemCount,
        documentName,
      }),
    );
  }

  get(id: string): Snapshot | null {
    return this.snapshots.find((s) => s.id === id) ?? null;
  }

  getLastBefore(): Snapshot | null {
    return this.lastBeforeId ? this.get(this.lastBeforeId) : null;
  }

  getLastAfter(): Snapshot | null {
    return this.lastAfterId ? this.get(this.lastAfterId) : null;
  }

  clear(): void {
    this.snapshots = [];
    this.lastBeforeId = null;
    this.lastAfterId = null;
  }

  diff(beforeId: string, afterId: string): SnapshotDiff {
    const before = this.get(beforeId);
    const after = this.get(afterId);
    if (!before || !after) {
      throw new Error(
        `Snapshot not found (before=${beforeId}, after=${afterId}). Use snapshot mode=list.`,
      );
    }

    const beforeMap = new Map(before.model.items.map((i) => [i.uuid, i]));
    const afterMap = new Map(after.model.items.map((i) => [i.uuid, i]));

    const added: SnapshotDiff["added"] = [];
    const removed: SnapshotDiff["removed"] = [];
    const modified: ItemDiff[] = [];

    for (const [uuid, item] of afterMap) {
      const prev = beforeMap.get(uuid);
      if (!prev) {
        added.push({
          uuid,
          type: item.type,
          pageIndex: item.pageIndex,
          textPreview: item.textPreview,
        });
        continue;
      }
      const changes = diffItems(prev, item);
      if (changes.length > 0) {
        modified.push({
          uuid,
          type: item.type,
          pageIndex: item.pageIndex,
          changes,
        });
      }
    }

    for (const [uuid, item] of beforeMap) {
      if (!afterMap.has(uuid)) {
        removed.push({
          uuid,
          type: item.type,
          pageIndex: item.pageIndex,
          textPreview: item.textPreview,
        });
      }
    }

    const selectionBefore = before.model.selection;
    const selectionAfter = after.model.selection;
    const selectionChanged =
      selectionBefore.join(",") !== selectionAfter.join(",");

    const summaryLines: string[] = [];
    summaryLines.push(
      `Document "${before.model.meta.name}" — snapshot "${before.label}" → "${after.label}"`,
    );
    if (added.length) summaryLines.push(`+ ${added.length} item(s) added`);
    if (removed.length) summaryLines.push(`− ${removed.length} item(s) removed`);
    if (modified.length) summaryLines.push(`~ ${modified.length} item(s) modified`);
    if (selectionChanged) {
      summaryLines.push(
        `selection: [${selectionBefore.join(", ")}] → [${selectionAfter.join(", ")}]`,
      );
    }
    if (
      added.length === 0 &&
      removed.length === 0 &&
      modified.length === 0 &&
      !selectionChanged
    ) {
      summaryLines.push("No structural changes detected.");
    }
    for (const m of modified.slice(0, 15)) {
      summaryLines.push(
        `  • ${m.uuid} (p${m.pageIndex} ${m.type}): ${m.changes.join("; ")}`,
      );
    }
    if (modified.length > 15) {
      summaryLines.push(`  … and ${modified.length - 15} more modified items`);
    }

    return {
      beforeId,
      afterId,
      beforeLabel: String(before.label),
      afterLabel: String(after.label),
      added,
      removed,
      modified,
      selectionChanged,
      selectionBefore,
      selectionAfter,
      summaryLines,
    };
  }
}

export const snapshotStore = new SnapshotStore();
