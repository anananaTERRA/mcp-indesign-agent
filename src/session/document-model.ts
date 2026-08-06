/** Document Model — cached representation of the active InDesign document. */

export type PageItemType =
  | "TextFrame"
  | "Rectangle"
  | "Oval"
  | "GraphicLine"
  | "Polygon"
  | "Group"
  | "PageItem"
  | string;

export interface Bounds {
  y1: number;
  x1: number;
  y2: number;
  x2: number;
}

export interface PageMeta {
  index: number;
  name: string;
}

export interface DocumentItem {
  /** Canonical id (UUID without `mcp:` prefix). */
  uuid: string;
  pageIndex: number;
  /** Index within page.allPageItems at scan time — filter only, never identity. */
  itemIndex: number;
  type: PageItemType;
  bounds: Bounds | null;
  textPreview: string;
  /** Parent group uuid, if nested. */
  parentUuid: string | null;
  layerName: string | null;
  /** Paragraph style name when text frame. */
  paragraphStyle: string | null;
  /** Font size (pt) when available. */
  fontSize: number | null;
  role?: string | null;
}

export interface LayerInfo {
  name: string;
  visible: boolean;
  locked: boolean;
}

export interface StyleInfo {
  name: string;
}

export interface SwatchInfo {
  name: string;
  colorType?: string | null;
}

export interface FontInfo {
  name: string;
  status?: string | null;
}

export interface LinkInfo {
  id: string;
  name: string;
  filePath: string | null;
  status: string;
  pageIndex: number | null;
}

export interface MasterPageInfo {
  name: string;
  index: number;
}

export interface DocumentMeta {
  name: string;
  path: string | null;
  pageCount: number;
  pageSize: { width: number; height: number } | null;
  units: string | null;
  /** Fingerprint for stale detection (path + counts + uuid set). */
  generation: string;
}

export interface DocumentModel {
  meta: DocumentMeta;
  pages: PageMeta[];
  items: DocumentItem[];
  layers: LayerInfo[];
  styles: {
    paragraph: StyleInfo[];
    character: StyleInfo[];
    object: StyleInfo[];
  };
  swatches: SwatchInfo[];
  fonts: FontInfo[];
  links: LinkInfo[];
  masterPages: MasterPageInfo[];
  /** Currently selected item uuids. */
  selection: string[];
  scannedAt: string;
}

export interface DocumentModelSummary {
  fromCache: boolean;
  scannedAt: string | null;
  meta: DocumentMeta | null;
  pageCount: number;
  itemCount: number;
  selectionCount: number;
  layers: number;
  styles: {
    paragraph: number;
    character: number;
    object: number;
  };
  links: number;
  itemsSample: Array<{
    uuid: string;
    type: string;
    pageIndex: number;
    textPreview: string;
    role: string | null;
  }>;
  roleCounts?: Record<string, number>;
}

/** Raw scan payload from the ExtendScript dispatcher. */
export interface ScanDocumentResult {
  op: "scanDocument";
  depth: string;
  meta: {
    name: string;
    path: string | null;
    pageCount: number;
    pageSize: { width: number; height: number } | null;
    units: string | null;
    generation?: string;
  };
  pages: PageMeta[];
  items: Array<{
    uuid: string;
    pageIndex: number;
    itemIndex: number;
    type: string;
    bounds: Bounds | null;
    label?: string;
    textPreview: string;
    parentUuid?: string | null;
    layerName?: string | null;
    paragraphStyle?: string | null;
    fontSize?: number | null;
  }>;
  layers?: LayerInfo[];
  styles?: {
    paragraph?: StyleInfo[];
    character?: StyleInfo[];
    object?: StyleInfo[];
  };
  swatches?: SwatchInfo[];
  fonts?: FontInfo[];
  links?: LinkInfo[];
  masterPages?: MasterPageInfo[];
  selection?: string[];
}

export interface GetSelectionResult {
  op: "getSelection";
  selection: string[];
  items: Array<{
    uuid: string;
    pageIndex: number | null;
    type: string;
    bounds: Bounds | null;
    textPreview: string;
  }>;
}

export function summarizeModel(
  model: DocumentModel | null,
  fromCache: boolean,
): DocumentModelSummary {
  if (!model) {
    return {
      fromCache,
      scannedAt: null,
      meta: null,
      pageCount: 0,
      itemCount: 0,
      selectionCount: 0,
      layers: 0,
      styles: { paragraph: 0, character: 0, object: 0 },
      links: 0,
      itemsSample: [],
    };
  }

  return {
    fromCache,
    scannedAt: model.scannedAt,
    meta: model.meta,
    pageCount: model.pages.length,
    itemCount: model.items.length,
    selectionCount: model.selection.length,
    layers: model.layers.length,
    styles: {
      paragraph: model.styles.paragraph.length,
      character: model.styles.character.length,
      object: model.styles.object.length,
    },
    links: model.links.length,
    itemsSample: model.items.slice(0, 20).map((it) => ({
      uuid: it.uuid,
      type: it.type,
      pageIndex: it.pageIndex,
      textPreview: it.textPreview,
      role: it.role ?? null,
    })),
    roleCounts: countRoles(model.items),
  };
}

function countRoles(
  items: DocumentItem[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const it of items) {
    const role = it.role ?? "Unknown";
    counts[role] = (counts[role] ?? 0) + 1;
  }
  return counts;
}

export function scanResultToModel(scan: ScanDocumentResult): DocumentModel {
  const items: DocumentItem[] = (scan.items ?? []).map((it) => ({
    uuid: it.uuid,
    pageIndex: it.pageIndex,
    itemIndex: it.itemIndex,
    type: it.type,
    bounds: it.bounds,
    textPreview: it.textPreview ?? "",
    parentUuid: it.parentUuid ?? null,
    layerName: it.layerName ?? null,
    paragraphStyle: it.paragraphStyle ?? null,
    fontSize: it.fontSize ?? null,
    role: null,
  }));

  const generation =
    scan.meta.generation ??
    buildGeneration(scan.meta.path, scan.meta.pageCount, items);

  return {
    meta: {
      name: scan.meta.name,
      path: scan.meta.path,
      pageCount: scan.meta.pageCount,
      pageSize: scan.meta.pageSize,
      units: scan.meta.units,
      generation,
    },
    pages: scan.pages ?? [],
    items,
    layers: scan.layers ?? [],
    styles: {
      paragraph: scan.styles?.paragraph ?? [],
      character: scan.styles?.character ?? [],
      object: scan.styles?.object ?? [],
    },
    swatches: scan.swatches ?? [],
    fonts: scan.fonts ?? [],
    links: scan.links ?? [],
    masterPages: scan.masterPages ?? [],
    selection: scan.selection ?? [],
    scannedAt: new Date().toISOString(),
  };
}

export function buildGeneration(
  path: string | null,
  pageCount: number,
  items: Array<{ uuid: string }>,
): string {
  const uuids = items
    .map((i) => i.uuid)
    .slice()
    .sort()
    .join(",");
  return `${path ?? "unsaved"}|p${pageCount}|n${items.length}|${simpleHash(uuids)}`;
}

function simpleHash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}
