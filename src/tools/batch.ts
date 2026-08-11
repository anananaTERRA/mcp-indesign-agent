import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  AppleScriptExtendScriptAdapter,
  BridgeError,
  createBridge,
  type BridgeAdapter,
} from "../bridge/index.js";
import {
  CheckpointRequiredError,
  executeBatch,
  PlannerError,
  previewBatch,
} from "../commands/index.js";
import { sessionStore, snapshotStore } from "../session/index.js";
import {
  checkpointRefusalPayload,
  textResult,
  withToolError,
} from "./helpers.js";

function bridgeFromTimeout(timeoutSec?: number): BridgeAdapter {
  if (timeoutSec !== undefined) {
    return new AppleScriptExtendScriptAdapter({ timeoutSec });
  }
  return createBridge();
}

function bridgeErrorPayload(err: BridgeError) {
  return {
    ok: false,
    code: err.code,
    message: err.message,
    details: err.details ?? null,
  };
}

/** Shared command list schema for batch tools (JSON array validated in commands layer). */
const commandsField = z
  .array(z.record(z.unknown()))
  .min(1)
  .max(50)
  .describe(
    "Batch commands (prefer ONE execute_batch over many tools). Ops: checkpoint, move, resize, delete, duplicate, createTextFrame, setText, replaceText, setFont, setFill, align, distribute, center, stack, applyMargins, applyStyle, createStyle, updateStyle, relinkAsset, replaceAsset, embedAsset. checkpoint: {op:'checkpoint', tag?, keep?} saves an .indd copy to _checkpoints/ and runs before the undo transaction. createTextFrame: {op, x,y,width,height,text?} or {op, below:{role|uuid|selection}, gapPt?, text?}. Geometry in points. Requires prior scan_document (and analyze_page for role targets).",
  );

export function registerBatchTools(server: McpServer): void {
  server.registerTool(
    "snapshot",
    {
      description:
        "Capture or inspect Document Model snapshots. Modes: before | after | list | diff. Capture uses the current session cache (run scan_document first).",
      inputSchema: {
      mode: z
        .enum(["before", "after", "list", "diff"])
        .describe("before/after capture; list metas; diff two snapshots"),
      beforeId: z.string().uuid().optional(),
      afterId: z.string().uuid().optional(),
      label: z.string().optional(),
    
      },
    },
    withToolError(async ({ mode, beforeId, afterId, label }) => {
      if (mode === "list") {
        return textResult({
          ok: true,
          snapshots: snapshotStore.list(),
          lastBeforeId: snapshotStore.getLastBefore()?.id ?? null,
          lastAfterId: snapshotStore.getLastAfter()?.id ?? null,
        });
      }

      if (mode === "diff") {
        const before = beforeId ?? snapshotStore.getLastBefore()?.id;
        const after = afterId ?? snapshotStore.getLastAfter()?.id;
        if (!before || !after) {
          return textResult({
            ok: false,
            message:
              "Need two snapshots to diff. Capture mode=before and mode=after (or pass beforeId/afterId). Use mode=list.",
            snapshots: snapshotStore.list(),
          });
        }
        const diff = snapshotStore.diff(before, after);
        return textResult({ ok: true, diff });
      }

      const model = sessionStore.get();
      if (!model) {
        return textResult({
          ok: false,
          message:
            "No Document Model in cache. Call scan_document first, then snapshot.",
        });
      }

      const snapLabel = label ?? mode;
      const snap = snapshotStore.capture(snapLabel, model);
      return textResult({
        ok: true,
        snapshot: {
          id: snap.id,
          label: snap.label,
          capturedAt: snap.capturedAt,
          generation: snap.generation,
          itemCount: snap.itemCount,
          documentName: snap.documentName,
        },
      });
    }),
  );

  server.registerTool(
    "summarize_changes",
    {
      description:
        "Diff snapshot before vs after into agent-readable summary. Call after execute_batch (or layout_assistant fix). Defaults to the last before/after pair from scan_document + batch.",
      inputSchema: {
      beforeId: z.string().uuid().optional(),
      afterId: z.string().uuid().optional(),
    
      },
    },
    withToolError(async ({ beforeId, afterId }) => {
      const before = beforeId ?? snapshotStore.getLastBefore()?.id;
      const after = afterId ?? snapshotStore.getLastAfter()?.id;

      if (!before || !after) {
        return textResult({
          ok: false,
          message:
            "Missing before/after snapshots. Typical flow: scan_document → execute_batch → summarize_changes.",
          snapshots: snapshotStore.list(),
        });
      }

      const diff = snapshotStore.diff(before, after);
      return textResult({
        ok: true,
        summary: diff.summaryLines.join("\n"),
        counts: {
          added: diff.added.length,
          removed: diff.removed.length,
          modified: diff.modified.length,
          selectionChanged: diff.selectionChanged,
        },
        diff,
      });
    }),
  );

  server.registerTool(
    "preview_batch",
    {
      description:
        "Dry-run a batch against the cached Document Model (no InDesign writes). Call after scan_document. Prefer preview_batch before a large execute_batch.",
      inputSchema: {
      commands: commandsField,
    
      },
    },
    withToolError(async ({ commands }) => {
      try {
        const preview = previewBatch(commands);
        return textResult(preview);
      } catch (err) {
        if (err instanceof PlannerError || err instanceof z.ZodError) {
          return textResult({
            ok: false,
            message: err instanceof Error ? err.message : String(err),
            issues: err instanceof z.ZodError ? err.issues : undefined,
          });
        }
        throw err;
      }
    }),
  );

  server.registerTool(
    "execute_batch",
    {
      description:
        "Preferred mutation path: resolve targets → checkpoint gate → one dispatcher round-trip inside a single ENTIRE_SCRIPT undo transaction → modelPatch on cache. ALWAYS prefer this over execute_operation / layout_operation when combining ops. Mutating batches need an on-disk checkpoint for the current generation; the server takes one automatically and refuses the batch if saving it fails. Typical flow: scan_document → (analyze_page) → execute_batch → summarize_changes.",
      inputSchema: {
      commands: commandsField,
      captureAfterSnapshot: z
        .boolean()
        .optional()
        .describe("Capture snapshot after (default true)"),
      skipCheckpoint: z
        .boolean()
        .optional()
        .describe(
          "Mutate with no way back. Only when you deliberately accept that a bad edit cannot be rolled back (default false).",
        ),
      checkpointTag: z
        .string()
        .max(60)
        .optional()
        .describe("Short reason for the automatic checkpoint filename"),
      transactionName: z
        .string()
        .max(100)
        .optional()
        .describe("Label for the single undo step in InDesign (forced to ASCII)"),
      timeoutSec: z.number().int().min(1).max(300).optional(),
    
      },
    },
    withToolError(async ({
      commands,
      captureAfterSnapshot,
      skipCheckpoint,
      checkpointTag,
      transactionName,
      timeoutSec,
    }) => {
      try {
        const result = await executeBatch(bridgeFromTimeout(timeoutSec), commands, {
          captureAfterSnapshot: captureAfterSnapshot !== false,
          skipCheckpoint,
          checkpointTag,
          transactionName,
        });
        return textResult(result);
      } catch (err) {
        if (err instanceof CheckpointRequiredError) {
          return textResult(checkpointRefusalPayload(err));
        }
        if (err instanceof BridgeError) {
          return textResult(bridgeErrorPayload(err));
        }
        if (err instanceof PlannerError || err instanceof z.ZodError) {
          return textResult({
            ok: false,
            message: err instanceof Error ? err.message : String(err),
            issues: err instanceof z.ZodError ? err.issues : undefined,
          });
        }
        throw err;
      }
    }),
  );
}
