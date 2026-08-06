import { randomUUID } from "node:crypto";
import type { BridgeAdapter, ModelPatch } from "../bridge/types.js";
import {
  centerBoxOnPage,
  clampBoxToPage,
  computeAlignedBox,
  fromBox,
  moveBox,
  planDistribute,
  planStack,
  resizeBox,
  toBox,
  type Box,
} from "../lib/geometry.js";
import type { DocumentItem, DocumentModel } from "../session/document-model.js";
import { sessionStore, snapshotStore } from "../session/index.js";
import { planCommands, PlannerError, requireItems } from "./planner.js";
import {
  type BatchCommand,
  type ResolvedDispatcherCommand,
  parseBatchCommands,
} from "./schema.js";

export interface PreviewChange {
  uuid: string;
  op: string;
  fromBounds: DocumentItem["bounds"];
  toBounds: DocumentItem["bounds"] | null;
  note?: string;
}

export interface PreviewBatchResult {
  ok: true;
  resolved: ResolvedDispatcherCommand[];
  changes: PreviewChange[];
  warnings: string[];
}

export interface ExecuteBatchResult {
  ok: true;
  resolved: ResolvedDispatcherCommand[];
  results: unknown[];
  modelPatch: ModelPatch | null;
  summary: ReturnType<typeof sessionStore.summary>;
  snapshotAfter: { id: string; label: string } | null;
}

function pageSize(model: DocumentModel): { width: number; height: number } {
  return {
    width: model.meta.pageSize?.width ?? 612,
    height: model.meta.pageSize?.height ?? 792,
  };
}

function boxOf(item: DocumentItem): Box | null {
  if (!item.bounds) return null;
  return toBox(item.bounds);
}

export function previewBatch(commandsInput: unknown): PreviewBatchResult {
  const model = sessionStore.get();
  if (!model) {
    throw new PlannerError(
      "No Document Model in cache. Call scan_document before preview_batch.",
    );
  }

  const commands = parseBatchCommands(commandsInput);
  const resolved = planCommands(commands, model);
  const changes: PreviewChange[] = [];
  const warnings: string[] = [];

  // Working copy of bounds for sequential preview
  const boundsMap = new Map<string, Box | null>();
  for (const it of model.items) {
    boundsMap.set(it.uuid, boxOf(it));
  }

  for (const cmd of resolved) {
    switch (cmd.op) {
      case "moveItem": {
        const box = boundsMap.get(cmd.target);
        if (!box) {
          warnings.push(`move ${cmd.target}: no bounds in cache`);
          break;
        }
        const next = moveBox(box, cmd);
        changes.push({
          uuid: cmd.target,
          op: "move",
          fromBounds: fromBox(box),
          toBounds: fromBox(next),
        });
        boundsMap.set(cmd.target, next);
        break;
      }
      case "resizeItem": {
        const box = boundsMap.get(cmd.target);
        if (!box) {
          warnings.push(`resize ${cmd.target}: no bounds in cache`);
          break;
        }
        const next = resizeBox(box, cmd);
        changes.push({
          uuid: cmd.target,
          op: "resize",
          fromBounds: fromBox(box),
          toBounds: fromBox(next),
        });
        boundsMap.set(cmd.target, next);
        break;
      }
      case "deleteItem": {
        const box = boundsMap.get(cmd.target);
        changes.push({
          uuid: cmd.target,
          op: "delete",
          fromBounds: box ? fromBox(box) : null,
          toBounds: null,
          note: "will remove item",
        });
        boundsMap.delete(cmd.target);
        break;
      }
      case "duplicateItem": {
        const box = boundsMap.get(cmd.target);
        changes.push({
          uuid: cmd.target,
          op: "duplicate",
          fromBounds: box ? fromBox(box) : null,
          toBounds: box
            ? fromBox(
                moveBox(box, { dx: cmd.dx ?? 12, dy: cmd.dy ?? 12 }),
              )
            : null,
          note: "creates new item with new uuid",
        });
        break;
      }
      case "setText":
      case "replaceText":
      case "setFont":
      case "setFill":
      case "applyStyle": {
        const box = boundsMap.get(cmd.target);
        changes.push({
          uuid: cmd.target,
          op: cmd.op,
          fromBounds: box ? fromBox(box) : null,
          toBounds: box ? fromBox(box) : null,
          note: "text/style change (bounds unchanged in preview)",
        });
        break;
      }
      case "createStyle":
      case "updateStyle": {
        changes.push({
          uuid: "",
          op: cmd.op,
          fromBounds: null,
          toBounds: null,
          note:
            cmd.op === "createStyle"
              ? `create ${cmd.styleKind ?? "paragraph"} style "${cmd.name}"`
              : `update ${cmd.styleKind ?? "paragraph"} style "${cmd.style}"`,
        });
        break;
      }
      case "relinkAsset":
      case "replaceAsset": {
        changes.push({
          uuid: "",
          op: cmd.op,
          fromBounds: null,
          toBounds: null,
          note: `relink ${cmd.linkId ?? cmd.name} → ${cmd.filePath}`,
        });
        break;
      }
      case "embedAsset": {
        changes.push({
          uuid: "",
          op: cmd.op,
          fromBounds: null,
          toBounds: null,
          note: `embed ${cmd.linkId ?? cmd.name}`,
        });
        break;
      }
      case "alignItems": {
        const page = pageSize(model);
        for (const uuid of cmd.targets) {
          const box = boundsMap.get(uuid);
          if (!box) continue;
          const next = computeAlignedBox(box, page, cmd.align);
          changes.push({
            uuid,
            op: `align:${cmd.align}`,
            fromBounds: fromBox(box),
            toBounds: fromBox(next),
          });
          boundsMap.set(uuid, next);
        }
        break;
      }
      case "distributeItems": {
        const items = cmd.targets
          .map((uuid) => ({ uuid, box: boundsMap.get(uuid) }))
          .filter((x): x is { uuid: string; box: Box } => !!x.box);
        const nextBoxes = planDistribute(
          items.map((i) => i.box),
          cmd.axis,
        );
        items.forEach((item, i) => {
          const next = nextBoxes[i]!;
          changes.push({
            uuid: item.uuid,
            op: `distribute:${cmd.axis}`,
            fromBounds: fromBox(item.box),
            toBounds: fromBox(next),
          });
          boundsMap.set(item.uuid, next);
        });
        break;
      }
      case "centerItems": {
        const page = pageSize(model);
        for (const uuid of cmd.targets) {
          const box = boundsMap.get(uuid);
          if (!box) continue;
          const next = centerBoxOnPage(box, page);
          changes.push({
            uuid,
            op: "center",
            fromBounds: fromBox(box),
            toBounds: fromBox(next),
          });
          boundsMap.set(uuid, next);
        }
        break;
      }
      case "stackItems": {
        const items = cmd.targets
          .map((uuid) => ({ uuid, box: boundsMap.get(uuid) }))
          .filter((x): x is { uuid: string; box: Box } => !!x.box);
        const nextBoxes = planStack(
          items.map((i) => i.box),
          cmd,
        );
        items.forEach((item, i) => {
          const next = nextBoxes[i]!;
          changes.push({
            uuid: item.uuid,
            op: "stack",
            fromBounds: fromBox(item.box),
            toBounds: fromBox(next),
          });
          boundsMap.set(item.uuid, next);
        });
        break;
      }
      case "applyMargins": {
        const page = pageSize(model);
        const margin = cmd.marginPt ?? 24;
        for (const uuid of cmd.targets) {
          const box = boundsMap.get(uuid);
          if (!box) continue;
          const next = clampBoxToPage(box, page, margin);
          changes.push({
            uuid,
            op: "applyMargins",
            fromBounds: fromBox(box),
            toBounds: fromBox(next),
          });
          boundsMap.set(uuid, next);
        }
        break;
      }
      default: {
        const _e: never = cmd;
        warnings.push(`Unknown resolved op: ${JSON.stringify(_e)}`);
      }
    }
  }

  // Touch requireItems for multi-target validation early
  for (const cmd of commands) {
    if (
      cmd.op === "align" ||
      cmd.op === "distribute" ||
      cmd.op === "stack" ||
      cmd.op === "center" ||
      cmd.op === "applyMargins"
    ) {
      const planned = resolved.find(
        (r) =>
          (r.op === "alignItems" ||
            r.op === "distributeItems" ||
            r.op === "stackItems" ||
            r.op === "centerItems" ||
            r.op === "applyMargins") &&
          "targets" in r,
      );
      if (planned && "targets" in planned) {
        requireItems(planned.targets, model);
      }
    }
  }

  return { ok: true, resolved, changes, warnings };
}

export async function executeBatch(
  bridge: BridgeAdapter,
  commandsInput: unknown,
  opts: { captureAfterSnapshot?: boolean } = {},
): Promise<ExecuteBatchResult> {
  const model = sessionStore.get();
  if (!model) {
    throw new PlannerError(
      "No Document Model in cache. Call scan_document before execute_batch.",
    );
  }

  const commands = parseBatchCommands(commandsInput);
  const resolved = planCommands(commands, model);

  const result = await bridge.run({
    requestId: randomUUID(),
    commands: resolved as unknown as Array<{ op: string; [k: string]: unknown }>,
  });

  const patch = result.modelPatch ?? null;
  if (patch) {
    sessionStore.applyPatch(normalizePatch(patch));
  } else {
    // Mutations without patch — invalidate so next get forces refresh
    const mutating = resolved.some((c) =>
      [
        "moveItem",
        "resizeItem",
        "deleteItem",
        "duplicateItem",
        "setText",
        "replaceText",
        "setFont",
        "setFill",
        "alignItems",
        "distributeItems",
        "centerItems",
        "stackItems",
        "applyMargins",
        "applyStyle",
        "createStyle",
        "updateStyle",
        "relinkAsset",
        "replaceAsset",
        "embedAsset",
      ].includes(c.op),
    );
    if (mutating) {
      // Soft-invalidate: keep model but mark generation dirty by clearing scanned? 
      // Prefer keeping cache if we can merge from results
      applyResultsFallback(resolved, result.results);
    }
  }

  let snapshotAfter: { id: string; label: string } | null = null;
  if (opts.captureAfterSnapshot !== false) {
    const current = sessionStore.get();
    if (current) {
      const snap = snapshotStore.capture("after", current);
      snapshotAfter = { id: snap.id, label: String(snap.label) };
    }
  }

  return {
    ok: true,
    resolved,
    results: result.results,
    modelPatch: patch,
    summary: sessionStore.summary(true),
    snapshotAfter,
  };
}

function normalizePatch(patch: ModelPatch): ModelPatch {
  return {
    updated: patch.updated,
    removed: (patch.removed ?? []).map((r) =>
      typeof r === "string" ? r : (r as { uuid: string }).uuid,
    ),
    styles: patch.styles ?? undefined,
    links: patch.links ?? undefined,
  };
}

/** When dispatcher returns per-op item snapshots without aggregated modelPatch. */
function applyResultsFallback(
  resolved: ResolvedDispatcherCommand[],
  results: unknown[],
): void {
  const updated: DocumentItem[] = [];
  const removed: string[] = [];

  for (let i = 0; i < results.length; i++) {
    const r = results[i] as {
      item?: Partial<DocumentItem> & { uuid?: string };
      items?: Array<Partial<DocumentItem> & { uuid?: string }>;
      removed?: string;
      created?: Partial<DocumentItem> & { uuid?: string };
    };
    if (!r) continue;

    if (r.removed) removed.push(r.removed);
    if (r.item?.uuid) {
      const existing = sessionStore.findByUuid(r.item.uuid);
      updated.push({ ...(existing ?? emptyItem(r.item.uuid)), ...r.item } as DocumentItem);
    }
    if (r.created?.uuid) {
      updated.push({ ...emptyItem(r.created.uuid), ...r.created } as DocumentItem);
    }
    if (r.items) {
      for (const it of r.items) {
        if (!it.uuid) continue;
        const existing = sessionStore.findByUuid(it.uuid);
        updated.push({ ...(existing ?? emptyItem(it.uuid)), ...it } as DocumentItem);
      }
    }

    // delete without explicit removed field
    if (resolved[i]?.op === "deleteItem" && "target" in resolved[i]!) {
      const t = (resolved[i] as { target: string }).target;
      if (!removed.includes(t)) removed.push(t);
    }
  }

  if (updated.length || removed.length) {
    sessionStore.applyPatch({ updated, removed });
  }
}

function emptyItem(uuid: string): DocumentItem {
  return {
    uuid,
    pageIndex: 0,
    itemIndex: 0,
    type: "PageItem",
    bounds: null,
    textPreview: "",
    parentUuid: null,
    layerName: null,
    paragraphStyle: null,
    fontSize: null,
    role: null,
  };
}

export { parseBatchCommands, type BatchCommand };
