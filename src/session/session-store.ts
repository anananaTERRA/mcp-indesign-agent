import type { ModelPatch } from "../bridge/types.js";
import {
  buildGeneration,
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
    const hasItemChanges = updated.length > 0 || removed.length > 0;
    const hasMetaChanges = Boolean(patch.styles || patch.links);

    if (!hasItemChanges && !hasMetaChanges) {
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

    const styles = patch.styles
      ? {
          paragraph: patch.styles.paragraph ?? this.model.styles.paragraph,
          character: patch.styles.character ?? this.model.styles.character,
          object: patch.styles.object ?? this.model.styles.object,
        }
      : this.model.styles;

    const links = patch.links
      ? patch.links.map((l) => ({
          id: String(l.id),
          name: l.name,
          filePath: l.filePath,
          status: l.status,
          pageIndex: l.pageIndex,
        }))
      : this.model.links;

    this.model = {
      ...this.model,
      items,
      styles,
      links,
      meta: {
        ...this.model.meta,
        pageCount: this.model.pages.length,
        // Recompute so that adding or deleting frames invalidates the
        // checkpoint taken before them. Pure text/style edits keep the same
        // uuid set and therefore the same generation.
        generation: buildGeneration(
          this.model.meta.path,
          this.model.pages.length,
          items,
        ),
      },
    };
  }
}

/** Process-wide session cache (one active document model per MCP process). */
export const sessionStore = new SessionStore();
