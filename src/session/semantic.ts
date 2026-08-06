/**
 * Semantic role classification for Document Model items (analyze_page).
 * Heuristics only — no external ML.
 */

import type { Bounds, DocumentItem, DocumentModel } from "./document-model.js";

export const SEMANTIC_ROLES = [
  "Header",
  "Subtitle",
  "Body",
  "Caption",
  "Image",
  "Background",
  "Logo",
  "Decorative",
  "Unknown",
] as const;

export type SemanticRole = (typeof SEMANTIC_ROLES)[number];

export interface RoleAssignment {
  uuid: string;
  role: SemanticRole;
  confidence: number;
  reasons: string[];
}

export interface AnalyzePageResult {
  pageIndex: number;
  pageSize: { width: number; height: number };
  assignments: RoleAssignment[];
  roleCounts: Record<SemanticRole, number>;
  updatedItemCount: number;
}

function area(b: Bounds): number {
  return Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);
}

function isTextFrame(item: DocumentItem): boolean {
  return item.type === "TextFrame" || Boolean(item.textPreview?.trim());
}

function isImageLike(item: DocumentItem): boolean {
  const t = item.type.toLowerCase();
  if (t.includes("image") || t === "eps" || t === "pdf") return true;
  // Placed graphics often live in Rectangle/Oval without text
  if (
    !item.textPreview?.trim() &&
    (item.type === "Rectangle" ||
      item.type === "Oval" ||
      item.type === "Polygon")
  ) {
    return true;
  }
  return false;
}

function styleHints(style: string | null): SemanticRole | null {
  if (!style) return null;
  const s = style.toLowerCase();
  // Bracket defaults from InDesign are weak signals — skip them
  if (s.startsWith("[")) return null;
  if (/header|heading|title|t[ií]tulo|cabe[cç]alho|\bh[1-6]\b/.test(s)) {
    return "Header";
  }
  if (/subtitle|subhead|sub-?t[ií]tulo|deck/.test(s)) return "Subtitle";
  if (/caption|legenda|credit|cr[eé]dito/.test(s)) return "Caption";
  if (/body|corpo|running text|texto corrido/.test(s)) return "Body";
  return null;
}

function classifyItem(
  item: DocumentItem,
  page: { width: number; height: number },
  pageArea: number,
): RoleAssignment {
  const reasons: string[] = [];
  let role: SemanticRole = "Unknown";
  let confidence = 0.35;

  const bounds = item.bounds;
  const fontSize = item.fontSize;
  const text = (item.textPreview ?? "").trim();
  const textLen = text.length;

  const relTop = bounds ? bounds.y1 / Math.max(page.height, 1) : 0.5;
  const relBottom = bounds ? bounds.y2 / Math.max(page.height, 1) : 0.5;
  const itemArea = bounds ? area(bounds) : 0;
  const areaRatio = pageArea > 0 ? itemArea / pageArea : 0;
  const widthRatio = bounds
    ? (bounds.x2 - bounds.x1) / Math.max(page.width, 1)
    : 0;

  const fromStyle = styleHints(item.paragraphStyle);
  if (fromStyle) {
    role = fromStyle;
    confidence = 0.85;
    reasons.push(`paragraphStyle="${item.paragraphStyle}"`);
  }

  if (isTextFrame(item)) {
    if (!fromStyle) {
      if (fontSize !== null && fontSize >= 24 && textLen > 0 && textLen <= 120) {
        role = "Header";
        confidence = 0.75;
        reasons.push(`fontSize=${fontSize}pt, short text`);
      } else if (
        fontSize !== null &&
        fontSize >= 16 &&
        textLen > 0 &&
        textLen <= 160
      ) {
        role = "Subtitle";
        confidence = 0.65;
        reasons.push(`fontSize=${fontSize}pt, medium short text`);
      } else if (fontSize !== null && fontSize <= 10 && textLen > 0 && textLen <= 200) {
        role = "Caption";
        confidence = 0.6;
        reasons.push(`small font ${fontSize}pt`);
      } else if (textLen >= 80 || (fontSize !== null && fontSize <= 14 && textLen >= 40)) {
        role = "Body";
        confidence = 0.7;
        reasons.push(`long/body-sized text (len=${textLen})`);
      } else if (textLen > 0 && textLen <= 80 && relTop < 0.28) {
        role = fontSize !== null && fontSize >= 18 ? "Header" : "Subtitle";
        confidence = 0.55;
        reasons.push(`near top (relTop=${relTop.toFixed(2)})`);
      } else if (textLen > 0 && relBottom > 0.78 && (fontSize ?? 12) <= 12) {
        role = "Caption";
        confidence = 0.55;
        reasons.push("near bottom + smallish type");
      } else if (textLen > 0) {
        role = "Body";
        confidence = 0.45;
        reasons.push("default text → Body");
      }
    }

    // Caption boost when under mid-page and short
    if (
      role !== "Caption" &&
      textLen > 0 &&
      textLen <= 180 &&
      relTop > 0.45 &&
      (fontSize ?? 14) <= 11
    ) {
      role = "Caption";
      confidence = Math.max(confidence, 0.6);
      reasons.push("short text mid/lower page → Caption");
    }
  } else if (isImageLike(item)) {
    if (areaRatio >= 0.55 || (areaRatio >= 0.35 && widthRatio >= 0.85)) {
      role = "Background";
      confidence = 0.8;
      reasons.push(`large non-text areaRatio=${areaRatio.toFixed(2)}`);
    } else if (
      areaRatio <= 0.08 &&
      bounds &&
      (bounds.y1 < page.height * 0.2 || bounds.y2 > page.height * 0.8) &&
      (bounds.x1 < page.width * 0.2 || bounds.x2 > page.width * 0.8)
    ) {
      role = "Logo";
      confidence = 0.7;
      reasons.push("small graphic near corner");
    } else if (areaRatio <= 0.03) {
      role = "Decorative";
      confidence = 0.55;
      reasons.push("tiny non-text");
    } else {
      role = "Image";
      confidence = 0.7;
      reasons.push("image-like page item");
    }
  } else if (item.type === "GraphicLine" || item.type === "Group") {
    role = areaRatio >= 0.4 ? "Background" : "Decorative";
    confidence = 0.5;
    reasons.push(`type=${item.type}`);
  } else if (!text) {
    role = areaRatio >= 0.5 ? "Background" : "Decorative";
    confidence = 0.45;
    reasons.push("non-text fallback");
  }

  if (item.layerName) {
    const layer = item.layerName.toLowerCase();
    if (/background|fundo|bg\b/.test(layer) && role !== "Background") {
      role = "Background";
      confidence = Math.max(confidence, 0.75);
      reasons.push(`layer="${item.layerName}"`);
    }
    if (/logo/.test(layer) && (role === "Image" || role === "Decorative")) {
      role = "Logo";
      confidence = Math.max(confidence, 0.75);
      reasons.push(`layer="${item.layerName}"`);
    }
  }

  if (reasons.length === 0) reasons.push("no strong signals");

  return { uuid: item.uuid, role, confidence, reasons };
}

function emptyCounts(): Record<SemanticRole, number> {
  return {
    Header: 0,
    Subtitle: 0,
    Body: 0,
    Caption: 0,
    Image: 0,
    Background: 0,
    Logo: 0,
    Decorative: 0,
    Unknown: 0,
  };
}

/**
 * Classify items on a page and return assignments (does not mutate the model).
 */
export function analyzePage(
  model: DocumentModel,
  pageIndex: number,
): AnalyzePageResult {
  const page = {
    width: model.meta.pageSize?.width ?? 612,
    height: model.meta.pageSize?.height ?? 792,
  };
  const pageArea = page.width * page.height;
  const items = model.items.filter((it) => it.pageIndex === pageIndex);

  const assignments = items.map((it) => classifyItem(it, page, pageArea));

  // Disambiguate: at most one Header if multiple high-confidence title-likes —
  // keep the topmost largest as Header, demote others to Subtitle.
  const headers = assignments
    .filter((a) => a.role === "Header")
    .map((a) => {
      const item = items.find((i) => i.uuid === a.uuid)!;
      return { a, item };
    })
    .sort((x, y) => {
      const by = (x.item.bounds?.y1 ?? 0) - (y.item.bounds?.y1 ?? 0);
      if (by !== 0) return by;
      return (
        (y.item.fontSize ?? 0) - (x.item.fontSize ?? 0) ||
        (y.item.bounds ? area(y.item.bounds) : 0) -
          (x.item.bounds ? area(x.item.bounds) : 0)
      );
    });

  if (headers.length > 1) {
    for (let i = 1; i < headers.length; i++) {
      const h = headers[i]!;
      h.a.role = "Subtitle";
      h.a.confidence = Math.min(h.a.confidence, 0.6);
      h.a.reasons.push("demoted: second+ Header → Subtitle");
    }
  }

  const roleCounts = emptyCounts();
  for (const a of assignments) {
    roleCounts[a.role] += 1;
  }

  return {
    pageIndex,
    pageSize: page,
    assignments,
    roleCounts,
    updatedItemCount: assignments.length,
  };
}

/**
 * Apply role assignments onto a Document Model (immutable update).
 */
export function applyRolesToModel(
  model: DocumentModel,
  assignments: RoleAssignment[],
): DocumentModel {
  const byUuid = new Map(assignments.map((a) => [a.uuid, a.role]));
  return {
    ...model,
    items: model.items.map((it) => {
      const role = byUuid.get(it.uuid);
      if (role === undefined) return it;
      return { ...it, role };
    }),
  };
}
