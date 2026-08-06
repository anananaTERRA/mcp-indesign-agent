/**
 * Layout assistant: diagnose / preview / fix overlapping text & margin issues.
 * Runs against the Document Model (points); fix applies via execute_batch.
 */

import type { BatchCommand } from "../commands/schema.js";
import type { DocumentModel } from "../session/document-model.js";
import { clampBoxToPage, fromBox } from "./geometry.js";
import {
  collectTextItems,
  findOutsideSafeArea,
  findTextOverlaps,
  planVerticalTextStack,
  type OutsideSafeIssue,
  type OverlapPair,
  type StackPlanItem,
} from "./text-layout.js";

export interface LayoutDiagnosis {
  pageIndex: number;
  textBoxCount: number;
  overlappingOrTightPairs: OverlapPair[];
  outsideSafeArea: OutsideSafeIssue[];
  needsFix: boolean;
  hint: string;
}

export interface LayoutFixPlan {
  diagnosis: LayoutDiagnosis;
  stackPlan: StackPlanItem[];
  commands: BatchCommand[];
  changeCount: number;
}

function pageSizeOf(model: DocumentModel): { width: number; height: number } {
  return {
    width: model.meta.pageSize?.width ?? 612,
    height: model.meta.pageSize?.height ?? 792,
  };
}

export function diagnosePageLayout(
  model: DocumentModel,
  opts: {
    pageIndex: number;
    minGapPt?: number;
    marginPt?: number;
    uuids?: string[];
  },
): LayoutDiagnosis {
  const pageIndex = opts.pageIndex;
  const minGapPt = opts.minGapPt ?? 12;
  const marginPt = opts.marginPt ?? 24;
  const page = pageSizeOf(model);

  const textItems = collectTextItems(model.items, {
    pageIndex,
    uuids: opts.uuids,
  });
  const overlaps = findTextOverlaps(textItems, minGapPt);
  const outsideSafe = findOutsideSafeArea(
    model.items,
    page,
    marginPt,
    pageIndex,
  );

  const needsFix = overlaps.length > 0 || outsideSafe.length > 0;
  let hint = "Layout looks fine";
  if (overlaps.length > 0) {
    hint =
      "Call layout_assistant mode=fix (or preview) to unstack overlapping/tight text";
  } else if (outsideSafe.length > 0) {
    hint =
      "Call layout_assistant mode=fix to clamp items into page margins, or layout_operation applyMargins";
  }

  return {
    pageIndex,
    textBoxCount: textItems.length,
    overlappingOrTightPairs: overlaps,
    outsideSafeArea: outsideSafe,
    needsFix,
    hint,
  };
}

/**
 * Build batch commands that fix overlaps (vertical stack) and optionally margins.
 */
export function planLayoutFix(
  model: DocumentModel,
  opts: {
    pageIndex: number;
    minGapPt?: number;
    marginPt?: number;
    expandTitles?: boolean;
    uuids?: string[];
    fixMargins?: boolean;
  },
): LayoutFixPlan {
  const pageIndex = opts.pageIndex;
  const minGapPt = opts.minGapPt ?? 18;
  const marginPt = opts.marginPt ?? 24;
  const expandTitles = opts.expandTitles !== false;
  const fixMargins = opts.fixMargins !== false;
  const page = pageSizeOf(model);

  const diagnosis = diagnosePageLayout(model, {
    pageIndex,
    minGapPt,
    marginPt,
    uuids: opts.uuids,
  });

  const textItems = collectTextItems(model.items, {
    pageIndex,
    uuids: opts.uuids,
  });

  const stackPlan =
    textItems.length > 0
      ? planVerticalTextStack(textItems, {
          minGapPt,
          expandTitles,
          pageHeight: page.height,
          marginPt,
        })
      : [];

  const commands: BatchCommand[] = [];

  for (const step of stackPlan) {
    const same =
      Math.abs(step.to.y - step.from.y) < 0.5 &&
      Math.abs(step.to.height - step.from.height) < 0.5 &&
      Math.abs(step.to.x - step.from.x) < 0.5 &&
      Math.abs(step.to.width - step.from.width) < 0.5;
    if (same) continue;

    if (Math.abs(step.to.height - step.from.height) >= 0.5) {
      commands.push({
        op: "resize",
        target: { uuid: step.uuid },
        height: step.to.height,
        width: step.to.width,
      });
    }
    if (
      Math.abs(step.to.x - step.from.x) >= 0.5 ||
      Math.abs(step.to.y - step.from.y) >= 0.5
    ) {
      commands.push({
        op: "move",
        target: { uuid: step.uuid },
        x: step.to.x,
        y: step.to.y,
      });
    }
  }

  if (fixMargins && diagnosis.outsideSafeArea.length > 0) {
    for (const issue of diagnosis.outsideSafeArea) {
      const item = model.items.find((i) => i.uuid === issue.uuid);
      if (!item?.bounds) continue;

      const planned = stackPlan.find((s) => s.uuid === issue.uuid);
      const box = planned?.to ?? {
        x: item.bounds.x1,
        y: item.bounds.y1,
        width: item.bounds.x2 - item.bounds.x1,
        height: item.bounds.y2 - item.bounds.y1,
      };
      const clamped = clampBoxToPage(box, page, marginPt);
      const same =
        Math.abs(clamped.x - box.x) < 0.5 &&
        Math.abs(clamped.y - box.y) < 0.5 &&
        Math.abs(clamped.width - box.width) < 0.5 &&
        Math.abs(clamped.height - box.height) < 0.5;
      if (same) continue;

      if (
        Math.abs(clamped.width - box.width) >= 0.5 ||
        Math.abs(clamped.height - box.height) >= 0.5
      ) {
        commands.push({
          op: "resize",
          target: { uuid: issue.uuid },
          width: clamped.width,
          height: clamped.height,
        });
      }
      if (
        Math.abs(clamped.x - box.x) >= 0.5 ||
        Math.abs(clamped.y - box.y) >= 0.5
      ) {
        // Absolute move after stack — last wins in sequential apply.
        commands.push({
          op: "move",
          target: { uuid: issue.uuid },
          x: clamped.x,
          y: clamped.y,
        });
      }

      if (planned) {
        planned.to = clamped;
      } else {
        stackPlan.push({
          uuid: issue.uuid,
          from: {
            x: item.bounds.x1,
            y: item.bounds.y1,
            width: item.bounds.x2 - item.bounds.x1,
            height: item.bounds.y2 - item.bounds.y1,
          },
          to: clamped,
          expandedHeight: false,
        });
      }
    }
  }

  return {
    diagnosis,
    stackPlan,
    commands,
    changeCount: commands.length,
  };
}

export function summarizeStackPlan(plan: StackPlanItem[]) {
  return plan.map((s) => ({
    uuid: s.uuid,
    from: fromBox(s.from),
    to: fromBox(s.to),
    expandedHeight: s.expandedHeight,
    dy: s.to.y - s.from.y,
    dHeight: s.to.height - s.from.height,
  }));
}
