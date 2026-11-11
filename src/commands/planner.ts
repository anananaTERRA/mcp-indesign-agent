import { toAsciiTag } from "../lib/ascii.js";
import type { DocumentItem, DocumentModel } from "../session/document-model.js";
import type { BatchCommand, ResolvedDispatcherCommand, TargetInput } from "./schema.js";

export class PlannerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlannerError";
  }
}

export function resolveTargetUuids(
  target: TargetInput,
  model: DocumentModel,
): string[] {
  if (typeof target === "string") {
    return resolveUuid(target, model);
  }

  if ("uuid" in target) {
    return resolveUuid(target.uuid, model);
  }

  if ("selection" in target) {
    if (!model.selection.length) {
      throw new PlannerError(
        "No selection in Document Model. Call get_selection or select items in InDesign, then refresh.",
      );
    }
    return [...model.selection];
  }

  if ("role" in target) {
    const role = target.role;
    const pageIndex = target.pageIndex;
    const matches = model.items.filter((it) => {
      if ((it.role ?? null) !== role) return false;
      if (pageIndex !== undefined && it.pageIndex !== pageIndex) return false;
      return true;
    });
    if (matches.length === 0) {
      throw new PlannerError(
        `No items with role="${role}"${pageIndex !== undefined ? ` on page ${pageIndex}` : ""}. Run analyze_page first, or target by uuid/selection.`,
      );
    }
    return matches.map((m) => m.uuid);
  }

  throw new PlannerError("Invalid target");
}

function resolveUuid(uuid: string, model: DocumentModel): string[] {
  const found = model.items.find((it) => it.uuid === uuid);
  if (!found) {
    // Allow targeting selection-only uuids not yet in items (edge case)
    if (model.selection.includes(uuid)) return [uuid];
    throw new PlannerError(
      `Unknown uuid "${uuid}". Run scan_document — ids come from the Document Model, not page:index.`,
    );
  }
  return [uuid];
}

export function requireItems(
  uuids: string[],
  model: DocumentModel,
): DocumentItem[] {
  return uuids.map((uuid) => {
    const item = model.items.find((it) => it.uuid === uuid);
    if (!item) {
      throw new PlannerError(`Item ${uuid} not in Document Model cache`);
    }
    return item;
  });
}

function resolveOptionalTarget(
  target: TargetInput | undefined,
  model: DocumentModel,
): string | undefined {
  if (target === undefined) return undefined;
  const uuids = resolveTargetUuids(target, model);
  if (uuids.length !== 1) {
    throw new PlannerError(
      `fromTarget must resolve to exactly one item (got ${uuids.length})`,
    );
  }
  return uuids[0];
}

function requireLinkRef(cmd: {
  linkId?: string | number;
  name?: string;
}): void {
  if (cmd.linkId === undefined && !cmd.name) {
    throw new PlannerError("Asset ops require linkId or name");
  }
}

/**
 * Expand high-level batch commands into dispatcher ops with concrete uuids.
 * Multi-target geometric ops (align/distribute/…) become one dispatcher command.
 * Per-item ops expand to one command per uuid.
 */
export function planCommands(
  commands: BatchCommand[],
  model: DocumentModel,
): ResolvedDispatcherCommand[] {
  const out: ResolvedDispatcherCommand[] = [];

  for (const cmd of commands) {
    switch (cmd.op) {
      case "checkpoint": {
        out.push({
          op: "checkpoint",
          tag: toAsciiTag(cmd.tag ?? "batch"),
          keep: cmd.keep,
        });
        break;
      }
      case "move": {
        const uuids = resolveTargetUuids(cmd.target, model);
        for (const target of uuids) {
          out.push({
            op: "moveItem",
            target,
            dx: cmd.dx,
            dy: cmd.dy,
            x: cmd.x,
            y: cmd.y,
          });
        }
        break;
      }
      case "resize": {
        const uuids = resolveTargetUuids(cmd.target, model);
        for (const target of uuids) {
          out.push({
            op: "resizeItem",
            target,
            width: cmd.width,
            height: cmd.height,
          });
        }
        break;
      }
      case "delete": {
        const uuids = resolveTargetUuids(cmd.target, model);
        for (const target of uuids) {
          out.push({ op: "deleteItem", target });
        }
        break;
      }
      case "duplicate": {
        const uuids = resolveTargetUuids(cmd.target, model);
        for (const target of uuids) {
          out.push({
            op: "duplicateItem",
            target,
            dx: cmd.dx,
            dy: cmd.dy,
          });
        }
        break;
      }
      case "createTextFrame": {
        let belowTarget: string | undefined;
        if (cmd.below !== undefined) {
          const uuids = resolveTargetUuids(cmd.below, model);
          if (uuids.length !== 1) {
            throw new PlannerError(
              `createTextFrame.below must resolve to exactly one item (got ${uuids.length})`,
            );
          }
          belowTarget = uuids[0];
        } else if (
          cmd.x === undefined ||
          cmd.y === undefined ||
          cmd.width === undefined ||
          cmd.height === undefined
        ) {
          throw new PlannerError(
            "createTextFrame requires x,y,width,height or below (anchor target)",
          );
        }
        out.push({
          op: "createTextFrame",
          pageIndex: cmd.pageIndex,
          x: cmd.x,
          y: cmd.y,
          width: cmd.width,
          height: cmd.height,
          text: cmd.text,
          style: cmd.style,
          fontSizePt: cmd.fontSizePt,
          fontFamily: cmd.fontFamily,
          fontStyle: cmd.fontStyle,
          belowTarget,
          gapPt: cmd.gapPt,
        });
        break;
      }
      case "setText": {
        const uuids = resolveTargetUuids(cmd.target, model);
        for (const target of uuids) {
          out.push({ op: "setText", target, text: cmd.text });
        }
        break;
      }
      case "replaceText": {
        const uuids = resolveTargetUuids(cmd.target, model);
        for (const target of uuids) {
          out.push({
            op: "replaceText",
            target,
            find: cmd.find,
            replace: cmd.replace,
            matchCase: cmd.matchCase,
          });
        }
        break;
      }
      case "setFont": {
        const uuids = resolveTargetUuids(cmd.target, model);
        for (const target of uuids) {
          out.push({
            op: "setFont",
            target,
            fontFamily: cmd.fontFamily,
            fontStyle: cmd.fontStyle,
            fontSizePt: cmd.fontSizePt,
          });
        }
        break;
      }
      case "setFill": {
        const uuids = resolveTargetUuids(cmd.target, model);
        for (const target of uuids) {
          out.push({ op: "setFill", target, fill: cmd.fill });
        }
        break;
      }
      case "setTextColor": {
        const uuids = resolveTargetUuids(cmd.target, model);
        for (const target of uuids) {
          out.push({ op: "setTextColor", target, fill: cmd.fill });
        }
        break;
      }
      case "setStroke": {
        const uuids = resolveTargetUuids(cmd.target, model);
        for (const target of uuids) {
          out.push({
            op: "setStroke",
            target,
            weightPt: cmd.weightPt,
            stroke: cmd.stroke,
            strokeNone: cmd.strokeNone,
          });
        }
        break;
      }
      case "align": {
        const uuids = resolveTargetUuids(cmd.target, model);
        out.push({ op: "alignItems", targets: uuids, align: cmd.align });
        break;
      }
      case "distribute": {
        const uuids = resolveTargetUuids(cmd.target, model);
        out.push({
          op: "distributeItems",
          targets: uuids,
          axis: cmd.axis,
        });
        break;
      }
      case "center": {
        const uuids = resolveTargetUuids(cmd.target, model);
        out.push({ op: "centerItems", targets: uuids });
        break;
      }
      case "stack": {
        const uuids = resolveTargetUuids(cmd.target, model);
        out.push({
          op: "stackItems",
          targets: uuids,
          axis: cmd.axis,
          gapPt: cmd.gapPt,
          startPt: cmd.startPt,
        });
        break;
      }
      case "applyMargins": {
        const uuids = resolveTargetUuids(cmd.target, model);
        out.push({
          op: "applyMargins",
          targets: uuids,
          marginPt: cmd.marginPt,
        });
        break;
      }
      case "applyStyle": {
        const uuids = resolveTargetUuids(cmd.target, model);
        for (const target of uuids) {
          out.push({
            op: "applyStyle",
            target,
            style: cmd.style,
            styleKind: cmd.styleKind,
          });
        }
        break;
      }
      case "createStyle": {
        out.push({
          op: "createStyle",
          name: cmd.name,
          styleKind: cmd.styleKind,
          basedOn: cmd.basedOn,
          fromTarget: resolveOptionalTarget(cmd.fromTarget, model),
          spec: cmd.spec,
        });
        break;
      }
      case "updateStyle": {
        out.push({
          op: "updateStyle",
          style: cmd.style,
          styleKind: cmd.styleKind,
          basedOn: cmd.basedOn,
          fromTarget: resolveOptionalTarget(cmd.fromTarget, model),
          newName: cmd.newName,
          spec: cmd.spec,
        });
        break;
      }
      case "relinkAsset":
      case "replaceAsset": {
        requireLinkRef(cmd);
        out.push({
          op: cmd.op,
          linkId: cmd.linkId,
          name: cmd.name,
          filePath: cmd.filePath,
        });
        break;
      }
      case "embedAsset": {
        requireLinkRef(cmd);
        out.push({
          op: "embedAsset",
          linkId: cmd.linkId,
          name: cmd.name,
        });
        break;
      }
      case "createDocument": {
        out.push({
          op: "createDocument",
          filePath: cmd.filePath,
          widthPt: cmd.widthPt,
          heightPt: cmd.heightPt,
          pageCount: cmd.pageCount,
          facingPages: cmd.facingPages,
          bleedPt: cmd.bleedPt,
        });
        break;
      }
      case "addPages": {
        out.push({
          op: "addPages",
          count: cmd.count,
          afterPageIndex: cmd.afterPageIndex,
        });
        break;
      }
      case "ensureSwatch": {
        if (!cmd.rgb && !cmd.cmyk) {
          throw new PlannerError("ensureSwatch requires rgb or cmyk");
        }
        out.push({
          op: "ensureSwatch",
          name: cmd.name,
          rgb: cmd.rgb,
          cmyk: cmd.cmyk,
        });
        break;
      }
      case "createRectangle": {
        out.push({
          op: "createRectangle",
          pageIndex: cmd.pageIndex,
          masterName: cmd.masterName,
          pageSide: cmd.pageSide,
          x: cmd.x,
          y: cmd.y,
          width: cmd.width,
          height: cmd.height,
          fill: cmd.fill,
          weightPt: cmd.weightPt,
          stroke: cmd.stroke,
          strokeNone: cmd.strokeNone,
          sendToBack: cmd.sendToBack,
        });
        break;
      }
      case "createOval": {
        out.push({
          op: "createOval",
          pageIndex: cmd.pageIndex,
          masterName: cmd.masterName,
          pageSide: cmd.pageSide,
          x: cmd.x,
          y: cmd.y,
          width: cmd.width,
          height: cmd.height,
          fill: cmd.fill,
          weightPt: cmd.weightPt,
          stroke: cmd.stroke,
          strokeNone: cmd.strokeNone,
          sendToBack: cmd.sendToBack,
        });
        break;
      }
      case "createGraphicLine": {
        out.push({
          op: "createGraphicLine",
          pageIndex: cmd.pageIndex,
          masterName: cmd.masterName,
          pageSide: cmd.pageSide,
          x1: cmd.x1,
          y1: cmd.y1,
          x2: cmd.x2,
          y2: cmd.y2,
          weightPt: cmd.weightPt,
          stroke: cmd.stroke,
          sendToBack: cmd.sendToBack,
        });
        break;
      }
      case "createBand": {
        out.push({
          op: "createBand",
          pageIndex: cmd.pageIndex,
          masterName: cmd.masterName,
          pageSide: cmd.pageSide,
          y: cmd.y,
          height: cmd.height,
          x: cmd.x,
          width: cmd.width,
          fill: cmd.fill,
          sendToBack: cmd.sendToBack,
        });
        break;
      }
      case "placeAsset": {
        out.push({
          op: "placeAsset",
          filePath: cmd.filePath,
          pageIndex: cmd.pageIndex,
          masterName: cmd.masterName,
          pageSide: cmd.pageSide,
          x: cmd.x,
          y: cmd.y,
          width: cmd.width,
          height: cmd.height,
          shape: cmd.shape,
          fit: cmd.fit,
        });
        break;
      }
      case "convertShape": {
        const uuids = resolveTargetUuids(cmd.target, model);
        for (const target of uuids) {
          out.push({
            op: "convertShape",
            target,
            shape: cmd.shape,
            fit: cmd.fit,
            refit: cmd.refit,
          });
        }
        break;
      }
      case "placeFolio": {
        out.push({
          op: "placeFolio",
          masterName: cmd.masterName,
          pageSide: cmd.pageSide,
          x: cmd.x,
          y: cmd.y,
          width: cmd.width,
          height: cmd.height,
          fontFamily: cmd.fontFamily,
          fontStyle: cmd.fontStyle,
          fontSizePt: cmd.fontSizePt,
          fill: cmd.fill,
          align: cmd.align,
        });
        break;
      }
      case "sendToBack": {
        const uuids = resolveTargetUuids(cmd.target, model);
        for (const target of uuids) {
          out.push({ op: "sendToBack", target });
        }
        break;
      }
      case "bringToFront": {
        const uuids = resolveTargetUuids(cmd.target, model);
        for (const target of uuids) {
          out.push({ op: "bringToFront", target });
        }
        break;
      }
      case "setTextInsets": {
        const uuids = resolveTargetUuids(cmd.target, model);
        for (const target of uuids) {
          out.push({
            op: "setTextInsets",
            target,
            insetPt: cmd.insetPt,
            topPt: cmd.topPt,
            leftPt: cmd.leftPt,
            bottomPt: cmd.bottomPt,
            rightPt: cmd.rightPt,
          });
        }
        break;
      }
      case "setTextColumns": {
        const uuids = resolveTargetUuids(cmd.target, model);
        for (const target of uuids) {
          out.push({
            op: "setTextColumns",
            target,
            count: cmd.count,
            gutterPt: cmd.gutterPt,
            ruleWeightPt: cmd.ruleWeightPt,
            ruleStroke: cmd.ruleStroke,
            rule: cmd.rule,
          });
        }
        break;
      }
      case "ensureMaster": {
        out.push({
          op: "ensureMaster",
          name: cmd.name,
          basedOn: cmd.basedOn,
        });
        break;
      }
      case "assignMaster": {
        if (cmd.pageIndex === undefined && !cmd.pageIndexes?.length) {
          throw new PlannerError("assignMaster requires pageIndex or pageIndexes");
        }
        out.push({
          op: "assignMaster",
          masterName: cmd.masterName,
          pageIndex: cmd.pageIndex,
          pageIndexes: cmd.pageIndexes,
        });
        break;
      }
      case "exportPdf": {
        out.push({
          op: "exportPdf",
          filePath: cmd.filePath,
          preset: cmd.preset,
        });
        break;
      }
      case "packageDocument": {
        out.push({
          op: "packageDocument",
          folderPath: cmd.folderPath,
          copyFonts: cmd.copyFonts,
          copyLinkedGraphics: cmd.copyLinkedGraphics,
        });
        break;
      }
      default: {
        const _exhaustive: never = cmd;
        throw new PlannerError(`Unsupported op: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  return out;
}
