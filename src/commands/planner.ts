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
        `No items with role="${role}"${pageIndex !== undefined ? ` on page ${pageIndex}` : ""}. Run analyze_page (phase 5) or target by uuid/selection.`,
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
    const uuids = resolveTargetUuids(cmd.target, model);

    switch (cmd.op) {
      case "move":
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
      case "resize":
        for (const target of uuids) {
          out.push({
            op: "resizeItem",
            target,
            width: cmd.width,
            height: cmd.height,
          });
        }
        break;
      case "delete":
        for (const target of uuids) {
          out.push({ op: "deleteItem", target });
        }
        break;
      case "duplicate":
        for (const target of uuids) {
          out.push({
            op: "duplicateItem",
            target,
            dx: cmd.dx,
            dy: cmd.dy,
          });
        }
        break;
      case "setText":
        for (const target of uuids) {
          out.push({ op: "setText", target, text: cmd.text });
        }
        break;
      case "replaceText":
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
      case "setFont":
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
      case "setFill":
        for (const target of uuids) {
          out.push({ op: "setFill", target, fill: cmd.fill });
        }
        break;
      case "align":
        out.push({ op: "alignItems", targets: uuids, align: cmd.align });
        break;
      case "distribute":
        out.push({
          op: "distributeItems",
          targets: uuids,
          axis: cmd.axis,
        });
        break;
      case "center":
        out.push({ op: "centerItems", targets: uuids });
        break;
      case "stack":
        out.push({
          op: "stackItems",
          targets: uuids,
          axis: cmd.axis,
          gapPt: cmd.gapPt,
          startPt: cmd.startPt,
        });
        break;
      case "applyMargins":
        out.push({
          op: "applyMargins",
          targets: uuids,
          marginPt: cmd.marginPt,
        });
        break;
      default: {
        const _exhaustive: never = cmd;
        throw new PlannerError(`Unsupported op: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  return out;
}
