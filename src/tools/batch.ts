import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sessionStore, snapshotStore } from "../session/index.js";
import { textResult, withToolError } from "./helpers.js";

export function registerBatchTools(server: McpServer): void {
  server.tool(
    "snapshot",
    "Capture or inspect Document Model snapshots. Modes: before | after | list | diff. Capture uses the current session cache (run scan_document first).",
    {
      mode: z
        .enum(["before", "after", "list", "diff"])
        .describe("before/after capture; list metas; diff two snapshots"),
      beforeId: z
        .string()
        .uuid()
        .optional()
        .describe("For mode=diff; defaults to last before snapshot"),
      afterId: z
        .string()
        .uuid()
        .optional()
        .describe("For mode=diff; defaults to last after snapshot"),
      label: z
        .string()
        .optional()
        .describe("Optional custom label when capturing (overrides mode label)"),
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

  server.tool(
    "summarize_changes",
    "Diff snapshot before vs after into agent-readable summary lines. Defaults to the last before/after pair.",
    {
      beforeId: z.string().uuid().optional(),
      afterId: z.string().uuid().optional(),
    },
    withToolError(async ({ beforeId, afterId }) => {
      const before = beforeId ?? snapshotStore.getLastBefore()?.id;
      const after = afterId ?? snapshotStore.getLastAfter()?.id;

      if (!before || !after) {
        return textResult({
          ok: false,
          message:
            "Missing before/after snapshots. Typical flow: scan_document (captures before) → edits → refresh_document → snapshot mode=after → summarize_changes.",
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
}
