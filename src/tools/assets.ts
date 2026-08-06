import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  AppleScriptExtendScriptAdapter,
  BridgeError,
  createBridge,
  type BridgeAdapter,
} from "../bridge/index.js";
import { executeBatch, PlannerError } from "../commands/index.js";
import { sessionStore, type LinkInfo } from "../session/index.js";
import { textResult, withToolError } from "./helpers.js";

function bridgeFromTimeout(timeoutSec?: number): BridgeAdapter {
  if (timeoutSec !== undefined) {
    return new AppleScriptExtendScriptAdapter({ timeoutSec });
  }
  return createBridge();
}

const LinkRef = {
  linkId: z
    .union([z.string(), z.number()])
    .optional()
    .describe("Link id from list_assets / Document Model"),
  name: z.string().optional().describe("Link file name as shown in Links panel"),
};

function syncLinksFromResult(links: LinkInfo[] | undefined): void {
  if (!links) return;
  const model = sessionStore.get();
  if (!model) return;
  sessionStore.applyPatch({ links });
}

export function registerAssetTools(server: McpServer): void {
  server.registerTool(
    "list_assets",
    {
      description:
        "List placed links/assets (path, status, page) from cache or refresh from InDesign.",
      inputSchema: {
      status: z
        .string()
        .optional()
        .describe(
          "Optional filter: NORMAL | LINK_MISSING | LINK_OUT_OF_DATE | LINK_EMBEDDED | …",
        ),
      refresh: z
        .boolean()
        .optional()
        .describe("If true, re-read links from InDesign (default: cache)"),
      timeoutSec: z.number().int().min(1).max(300).optional(),
    
      },
    },
    withToolError(async ({ status, refresh, timeoutSec }) => {
      try {
        if (refresh) {
          const result = await bridgeFromTimeout(timeoutSec).run({
            requestId: randomUUID(),
            commands: [{ op: "listAssets", status }],
          });
          const body = result.results[0] as {
            links?: LinkInfo[];
            count?: number;
          };
          syncLinksFromResult(body?.links);
          return textResult({
            ok: true,
            fromCache: false,
            links: body?.links ?? [],
            count: body?.count ?? body?.links?.length ?? 0,
          });
        }

        const model = sessionStore.get();
        if (!model) {
          return textResult({
            ok: false,
            message:
              "No Document Model in cache. Call scan_document (or list_assets with refresh:true).",
          });
        }

        let links = model.links;
        if (status) {
          links = links.filter((l) => l.status === status);
        }
        return textResult({
          ok: true,
          fromCache: true,
          links,
          count: links.length,
        });
      } catch (err) {
        if (err instanceof BridgeError) {
          return textResult({
            ok: false,
            code: err.code,
            message: err.message,
          });
        }
        throw err;
      }
    }),
  );

  server.registerTool(
    "check_missing_links",
    {
      description:
        "Report missing / inaccessible / out-of-date links in the active document.",
      inputSchema: {
      timeoutSec: z.number().int().min(1).max(300).optional(),
    
      },
    },
    withToolError(async ({ timeoutSec }) => {
      try {
        const result = await bridgeFromTimeout(timeoutSec).run({
          requestId: randomUUID(),
          commands: [{ op: "checkMissingLinks" }],
        });
        const body = result.results[0] as {
          missing?: LinkInfo[];
          outOfDate?: LinkInfo[];
          ok?: boolean;
          links?: LinkInfo[];
        };
        syncLinksFromResult(body?.links);
        return textResult({
          ok: true,
          missing: body?.missing ?? [],
          outOfDate: body?.outOfDate ?? [],
          allOk: body?.ok ?? false,
          totalLinks: body?.links?.length ?? 0,
        });
      } catch (err) {
        if (err instanceof BridgeError) {
          return textResult({
            ok: false,
            code: err.code,
            message: err.message,
          });
        }
        throw err;
      }
    }),
  );

  server.registerTool(
    "relink_asset",
    {
      description:
        "Relink a placed asset to a new file path on disk.",
      inputSchema: {
      ...LinkRef,
      filePath: z.string().min(1).describe("Absolute path to the replacement file"),
      timeoutSec: z.number().int().min(1).max(300).optional(),
    
      },
    },
    withToolError(async ({ linkId, name, filePath, timeoutSec }) => {
      try {
        const result = await executeBatch(bridgeFromTimeout(timeoutSec), [
          { op: "relinkAsset", linkId, name, filePath },
        ]);
        return textResult(result);
      } catch (err) {
        if (err instanceof BridgeError) {
          return textResult({
            ok: false,
            code: err.code,
            message: err.message,
          });
        }
        if (err instanceof PlannerError || err instanceof z.ZodError) {
          return textResult({
            ok: false,
            message: err instanceof Error ? err.message : String(err),
          });
        }
        throw err;
      }
    }),
  );

  server.registerTool(
    "replace_asset",
    {
      description:
        "Replace a placed asset with another file (same as relink_asset).",
      inputSchema: {
      ...LinkRef,
      filePath: z.string().min(1),
      timeoutSec: z.number().int().min(1).max(300).optional(),
    
      },
    },
    withToolError(async ({ linkId, name, filePath, timeoutSec }) => {
      try {
        const result = await executeBatch(bridgeFromTimeout(timeoutSec), [
          { op: "replaceAsset", linkId, name, filePath },
        ]);
        return textResult(result);
      } catch (err) {
        if (err instanceof BridgeError) {
          return textResult({
            ok: false,
            code: err.code,
            message: err.message,
          });
        }
        if (err instanceof PlannerError || err instanceof z.ZodError) {
          return textResult({
            ok: false,
            message: err instanceof Error ? err.message : String(err),
          });
        }
        throw err;
      }
    }),
  );

  server.registerTool(
    "embed_asset",
    {
      description:
        "Embed a linked asset into the document (unlink from disk).",
      inputSchema: {
      ...LinkRef,
      timeoutSec: z.number().int().min(1).max(300).optional(),
    
      },
    },
    withToolError(async ({ linkId, name, timeoutSec }) => {
      try {
        const result = await executeBatch(bridgeFromTimeout(timeoutSec), [
          { op: "embedAsset", linkId, name },
        ]);
        return textResult(result);
      } catch (err) {
        if (err instanceof BridgeError) {
          return textResult({
            ok: false,
            code: err.code,
            message: err.message,
          });
        }
        if (err instanceof PlannerError || err instanceof z.ZodError) {
          return textResult({
            ok: false,
            message: err instanceof Error ? err.message : String(err),
          });
        }
        throw err;
      }
    }),
  );
}
