import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  AppleScriptExtendScriptAdapter,
  BridgeError,
  createBridge,
  type BridgeAdapter,
} from "../bridge/index.js";
import {
  scanResultToModel,
  sessionStore,
  snapshotStore,
  type GetSelectionResult,
  type ScanDocumentResult,
} from "../session/index.js";
import { textResult, withToolError } from "./helpers.js";

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
    env: {
      INDESIGN_APP_NAME: process.env.INDESIGN_APP_NAME ?? null,
      INDESIGN_BRIDGE: process.env.INDESIGN_BRIDGE ?? "applescript",
    },
  };
}

async function runScan(
  bridge: BridgeAdapter,
  opts: { depth: string; writeUuids: boolean },
): Promise<ScanDocumentResult> {
  const result = await bridge.run({
    requestId: randomUUID(),
    commands: [
      {
        op: "scanDocument",
        depth: opts.depth,
        writeUuids: opts.writeUuids,
      },
    ],
  });
  const first = result.results[0] as ScanDocumentResult | undefined;
  if (!first || first.op !== "scanDocument") {
    throw new BridgeError(
      "JSX_EXCEPTION",
      "scanDocument returned an unexpected payload",
      result,
    );
  }
  return first;
}

export function registerSessionTools(server: McpServer): void {
  server.registerTool(
    "ping_indesign",
    {
      description:
        "Check if Adobe InDesign is reachable (app open, version, active document). Call first in a session before scan_document.",
      inputSchema: {
        timeoutSec: z
          .number()
          .int()
          .min(1)
          .max(300)
          .optional()
          .describe(
            "Optional override; prefer INDESIGN_SCRIPT_TIMEOUT_SEC for the adapter",
          ),
      },
    },
    withToolError(async ({ timeoutSec }) => {
      try {
        const info = await bridgeFromTimeout(timeoutSec).ping();
        return textResult({ ok: true, ...info });
      } catch (err) {
        if (err instanceof BridgeError) {
          return textResult(bridgeErrorPayload(err));
        }
        throw err;
      }
    }),
  );

  server.registerTool(
    "scan_document",
    {
      description:
        "Scan the active InDesign document into the session Document Model cache and write stable mcp:<uuid> labels. Call ONCE per session before planning edits; then use execute_batch (not repeated scans).",
      inputSchema: {
        depth: z
          .enum(["minimal", "full"])
          .optional()
          .describe(
            "full (default) includes styles, layers, links, selection; minimal is pages+items only",
          ),
        writeUuids: z
          .boolean()
          .optional()
          .describe("Write mcp:<uuid> script labels (default true)"),
        captureSnapshot: z
          .enum(["before", "after", "none"])
          .optional()
          .describe("Optionally capture a snapshot after scan (default: before)"),
        timeoutSec: z.number().int().min(1).max(300).optional(),
      },
    },
    withToolError(async ({ depth, writeUuids, captureSnapshot, timeoutSec }) => {
      try {
        const bridge = bridgeFromTimeout(timeoutSec);
        const scan = await runScan(bridge, {
          depth: depth ?? "full",
          writeUuids: writeUuids !== false,
        });
        const model = scanResultToModel(scan);
        sessionStore.set(model);

        const snapMode = captureSnapshot ?? "before";
        let snapshot = null;
        if (snapMode !== "none") {
          snapshot = snapshotStore.capture(snapMode, model);
        }

        return textResult({
          ok: true,
          fromCache: false,
          summary: sessionStore.summary(false),
          snapshot: snapshot
            ? {
                id: snapshot.id,
                label: snapshot.label,
                capturedAt: snapshot.capturedAt,
              }
            : null,
        });
      } catch (err) {
        if (err instanceof BridgeError) {
          return textResult(bridgeErrorPayload(err));
        }
        throw err;
      }
    }),
  );

  server.registerTool(
    "refresh_document",
    {
      description:
        "Invalidate and reload the Document Model from InDesign. Use only after manual edits in InDesign or when the cache may be stale — not before every mutation.",
      inputSchema: {
        depth: z.enum(["minimal", "full"]).optional(),
        pages: z
          .array(z.number().int().min(0))
          .optional()
          .describe(
            "Reserved for page-scoped refresh (currently always full document)",
          ),
        writeUuids: z.boolean().optional(),
        timeoutSec: z.number().int().min(1).max(300).optional(),
      },
    },
    withToolError(async ({ depth, writeUuids, timeoutSec }) => {
      try {
        sessionStore.invalidate();
        const bridge = bridgeFromTimeout(timeoutSec);
        const scan = await runScan(bridge, {
          depth: depth ?? "full",
          writeUuids: writeUuids !== false,
        });
        const model = scanResultToModel(scan);
        sessionStore.set(model);
        return textResult({
          ok: true,
          fromCache: false,
          summary: sessionStore.summary(false),
        });
      } catch (err) {
        if (err instanceof BridgeError) {
          return textResult(bridgeErrorPayload(err));
        }
        throw err;
      }
    }),
  );

  server.registerTool(
    "get_document_model",
    {
      description:
        "Return a summary of the cached Document Model without rescanning InDesign (unless forceRefresh or cache empty).",
      inputSchema: {
        forceRefresh: z
          .boolean()
          .optional()
          .describe("If true, rescan before returning"),
        maxAgeMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("If cache older than this, rescan"),
        includeItems: z
          .boolean()
          .optional()
          .describe("Include full items array (can be large)"),
        timeoutSec: z.number().int().min(1).max(300).optional(),
      },
    },
    withToolError(
      async ({ forceRefresh, maxAgeMs, includeItems, timeoutSec }) => {
        try {
          const needsScan =
            forceRefresh === true ||
            !sessionStore.hasModel() ||
            (maxAgeMs !== undefined && !sessionStore.isFresh(maxAgeMs));

          if (needsScan) {
            const bridge = bridgeFromTimeout(timeoutSec);
            const scan = await runScan(bridge, {
              depth: "full",
              writeUuids: true,
            });
            sessionStore.set(scanResultToModel(scan));
          }

          const model = sessionStore.get();
          const fromCache = !needsScan;
          const payload: Record<string, unknown> = {
            ok: true,
            fromCache,
            summary: sessionStore.summary(fromCache),
          };
          if (includeItems && model) {
            payload.items = model.items;
            payload.selection = model.selection;
            payload.styles = model.styles;
            payload.links = model.links;
            payload.layers = model.layers;
          }
          return textResult(payload);
        } catch (err) {
          if (err instanceof BridgeError) {
            return textResult(bridgeErrorPayload(err));
          }
          throw err;
        }
      },
    ),
  );

  server.registerTool(
    "get_selection",
    {
      description:
        "Read the current InDesign selection as stable UUIDs and sync them into the session cache.",
      inputSchema: {
        writeUuids: z.boolean().optional(),
        timeoutSec: z.number().int().min(1).max(300).optional(),
      },
    },
    withToolError(async ({ writeUuids, timeoutSec }) => {
      try {
        const bridge = bridgeFromTimeout(timeoutSec);
        const result = await bridge.run({
          requestId: randomUUID(),
          commands: [
            {
              op: "getSelection",
              writeUuids: writeUuids !== false,
            },
          ],
        });
        const first = result.results[0] as GetSelectionResult | undefined;
        if (!first || first.op !== "getSelection") {
          throw new BridgeError(
            "JSX_EXCEPTION",
            "getSelection returned an unexpected payload",
            result,
          );
        }

        sessionStore.updateSelection(first.selection);

        return textResult({
          ok: true,
          selection: first.selection,
          items: first.items,
          cacheHasModel: sessionStore.hasModel(),
        });
      } catch (err) {
        if (err instanceof BridgeError) {
          return textResult(bridgeErrorPayload(err));
        }
        throw err;
      }
    }),
  );
}
