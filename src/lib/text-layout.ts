/**
 * Text layout heuristics in points (ported from google-slides-agent EMU logic).
 */

import type { DocumentItem } from "../session/document-model.js";
import {
  boundsBottom,
  boundsOverlap,
  estimateTextBoxHeightPt,
  toBox,
  type Box,
  verticalGap,
} from "./geometry.js";

export type TextLayoutItem = {
  uuid: string;
  bounds: Box;
  text: string;
  fontSizePt: number | null;
  isTitleLike: boolean;
  role?: string | null;
};

export function collectTextItems(
  items: DocumentItem[],
  opts: { pageIndex?: number; uuids?: string[] } = {},
): TextLayoutItem[] {
  const allow = opts.uuids?.length ? new Set(opts.uuids) : null;
  const out: TextLayoutItem[] = [];

  for (const it of items) {
    if (opts.pageIndex !== undefined && it.pageIndex !== opts.pageIndex) {
      continue;
    }
    if (allow && !allow.has(it.uuid)) continue;
    if (!it.bounds) continue;
    if (it.type !== "TextFrame" && !(it.textPreview ?? "").trim()) continue;

    const text = (it.textPreview ?? "").trim();
    if (!text && it.type !== "TextFrame") continue;

    const fontSizePt = it.fontSize;
    const role = it.role ?? null;
    const isTitleLike =
      role === "Header" ||
      role === "Subtitle" ||
      (text.length > 0 &&
        text.length <= 120 &&
        (fontSizePt === null || fontSizePt >= 18));

    out.push({
      uuid: it.uuid,
      bounds: toBox(it.bounds),
      text,
      fontSizePt,
      isTitleLike,
      role,
    });
  }

  return out;
}

export type OverlapPair = {
  aId: string;
  bId: string;
  gapPt: number;
  overlapping: boolean;
};

export function findTextOverlaps(
  items: TextLayoutItem[],
  minGapPt: number,
): OverlapPair[] {
  const pairs: OverlapPair[] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]!;
      const b = items[j]!;
      const above = a.bounds.y <= b.bounds.y ? a : b;
      const below = a.bounds.y <= b.bounds.y ? b : a;
      const gap = verticalGap(above.bounds, below.bounds);
      const overlapping =
        boundsOverlap(a.bounds, b.bounds) || gap < minGapPt;
      const horizOverlap =
        a.bounds.x < below.bounds.x + below.bounds.width &&
        a.bounds.x + a.bounds.width > below.bounds.x;
      if (overlapping && horizOverlap) {
        pairs.push({
          aId: above.uuid,
          bId: below.uuid,
          gapPt: gap,
          overlapping: boundsOverlap(a.bounds, b.bounds),
        });
      }
    }
  }
  return pairs;
}

export type StackPlanItem = {
  uuid: string;
  from: Box;
  to: Box;
  expandedHeight: boolean;
};

/**
 * Sort text frames top→bottom and stack with minGap (points).
 * Optionally expand title-like boxes to estimated content height first.
 */
export function planVerticalTextStack(
  items: TextLayoutItem[],
  options: {
    minGapPt: number;
    expandTitles?: boolean;
    pageHeight?: number;
    marginPt?: number;
  },
): StackPlanItem[] {
  const sorted = [...items].sort((a, b) => {
    if (a.bounds.y !== b.bounds.y) return a.bounds.y - b.bounds.y;
    return a.bounds.x - b.bounds.x;
  });

  const plan: StackPlanItem[] = [];
  let cursor = Number.NEGATIVE_INFINITY;
  const margin = options.marginPt ?? 0;
  const pageH = options.pageHeight;

  for (const item of sorted) {
    let height = item.bounds.height;
    let expandedHeight = false;

    if (options.expandTitles && item.isTitleLike) {
      const estimated = estimateTextBoxHeightPt(
        item.fontSizePt,
        item.text,
        item.bounds.width,
      );
      if (estimated > height) {
        height = estimated;
        expandedHeight = true;
      }
    }

    let y = item.bounds.y;
    if (cursor !== Number.NEGATIVE_INFINITY) {
      const minY = cursor + options.minGapPt;
      if (y < minY) y = minY;
    }

    if (pageH !== undefined) {
      const maxBottom = pageH - margin;
      if (y + height > maxBottom) {
        y = Math.max(margin, maxBottom - height);
      }
    }

    const to: Box = {
      x: item.bounds.x,
      y,
      width: item.bounds.width,
      height,
    };

    plan.push({
      uuid: item.uuid,
      from: { ...item.bounds },
      to,
      expandedHeight,
    });

    cursor = boundsBottom(to);
  }

  return plan;
}

export type OutsideSafeIssue = {
  uuid: string;
  type: string;
  role?: string | null;
  issue: "outside_or_too_large_for_margins";
};

export function findOutsideSafeArea(
  items: DocumentItem[],
  page: { width: number; height: number },
  marginPt: number,
  pageIndex?: number,
): OutsideSafeIssue[] {
  const issues: OutsideSafeIssue[] = [];
  for (const it of items) {
    if (pageIndex !== undefined && it.pageIndex !== pageIndex) continue;
    if (!it.bounds) continue;
    const b = toBox(it.bounds);
    const maxW = Math.max(1, page.width - 2 * marginPt);
    const maxH = Math.max(1, page.height - 2 * marginPt);
    const needs =
      b.x < marginPt - 0.5 ||
      b.y < marginPt - 0.5 ||
      b.x + b.width > page.width - marginPt + 0.5 ||
      b.y + b.height > page.height - marginPt + 0.5 ||
      b.width > maxW + 0.5 ||
      b.height > maxH + 0.5;
    if (needs) {
      issues.push({
        uuid: it.uuid,
        type: it.type,
        role: it.role ?? null,
        issue: "outside_or_too_large_for_margins",
      });
    }
  }
  return issues;
}
