import type { ModelPatch } from "../bridge/types.js";
import {
  type DocumentItem,
  type DocumentModel,
  type DocumentModelSummary,
  summarizeModel,
} from "./document-model.js";

export class SessionStore {
  private model: DocumentModel | null = null;

  get(): DocumentModel | null {
    return this.model;
  }

  hasModel(): boolean {
    return this.model !== null;
  }

  set(model: DocumentModel): void {
    this.model = model;
  }

  invalidate(): void {
    this.model = null;
  }

  isFresh(maxAgeMs?: number): boolean {
    if (!this.model) return false;
    if (maxAgeMs === undefined) return true;
    const age = Date.now() - Date.parse(this.model.scannedAt);
    return Number.isFinite(age) && age <= maxAgeMs;
  }

  summary(fromCache = true): DocumentModelSummary {
    return summarizeModel(this.model, fromCache);
  }

  findByUuid(uuid: string): DocumentItem | undefined {
    return this.model?.items.find((it) => it.uuid === uuid);
  }

  updateSelection(uuids: string[]): void {
    if (!this.model) return;
    this.model = {
      ...this.model,
      selection: [...uuids],
      scannedAt: this.model.scannedAt,
    };
  }

  /**
   * Apply a modelPatch from the dispatcher when present.
   * Incomplete patches should invalidate instead of corrupting the cache.
   */
  applyPatch(patch: ModelPatch | null | undefined): void {
    if (!patch || !this.model) return;

    const updated = (patch.updated ?? []) as Array<Partial<DocumentItem> & { uuid: string }>;
    const removed = (patch.removed ?? []) as Array<string | { uuid: string }>;

    if (updated.length === 0 && removed.length === 0) {
      return;
    }

    const removedSet = new Set(
      removed.map((r) => (typeof r === "string" ? r : r.uuid)),
    );

    let items = this.model.items.filter((it) => !removedSet.has(it.uuid));
    const byUuid = new Map(items.map((it) => [it.uuid, it]));

    for (const u of updated) {
      if (!u?.uuid) {
        this.invalidate();
        return;
      }
      const prev = byUuid.get(u.uuid);
      const merged: DocumentItem = {
        uuid: u.uuid,
        pageIndex: u.pageIndex ?? prev?.pageIndex ?? 0,
        itemIndex: u.itemIndex ?? prev?.itemIndex ?? 0,
        type: u.type ?? prev?.type ?? "PageItem",
        bounds: u.bounds !== undefined ? u.bounds : (prev?.bounds ?? null),
        textPreview: u.textPreview ?? prev?.textPreview ?? "",
        parentUuid:
          u.parentUuid !== undefined
            ? u.parentUuid
            : (prev?.parentUuid ?? null),
        layerName:
          u.layerName !== undefined ? u.layerName : (prev?.layerName ?? null),
        paragraphStyle:
          u.paragraphStyle !== undefined
            ? u.paragraphStyle
            : (prev?.paragraphStyle ?? null),
        fontSize:
          u.fontSize !== undefined ? u.fontSize : (prev?.fontSize ?? null),
        role: u.role !== undefined ? u.role : (prev?.role ?? null),
      };
      byUuid.set(u.uuid, merged);
    }

    items = Array.from(byUuid.values());
    this.model = {
      ...this.model,
      items,
      meta: {
        ...this.model.meta,
        pageCount: this.model.pages.length,
      },
    };
  }
}

/** Process-wide session cache (one active document model per MCP process). */
export const sessionStore = new SessionStore();
