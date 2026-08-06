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
import { sessionStore } from "../session/index.js";
import { textResult, withToolError } from "./helpers.js";

function bridgeFromTimeout(timeoutSec?: number): BridgeAdapter {
  if (timeoutSec !== undefined) {
    return new AppleScriptExtendScriptAdapter({ timeoutSec });
  }
  return createBridge();
}

const TargetField = z.union([
  z.string(),
  z.object({ uuid: z.string() }),
  z.object({ role: z.string(), pageIndex: z.number().int().optional() }),
  z.object({ selection: z.literal(true) }),
]);

const StyleKind = z.enum(["paragraph", "character", "object"]);

const StyleSpec = z.object({
  fontFamily: z.string().optional(),
  fontStyle: z.string().optional(),
  fontSizePt: z.number().positive().optional(),
  leadingPt: z.number().positive().optional(),
  spaceBeforePt: z.number().nonnegative().optional(),
  spaceAfterPt: z.number().nonnegative().optional(),
});

export function registerStyleTools(server: McpServer): void {
  server.registerTool(
    "list_styles",
    {
      description:
        "List paragraph / character / object styles from the Document Model cache (or refresh from InDesign). Prefer after scan_document; use apply_style / execute_batch applyStyle to apply.",
      inputSchema: {
      styleKind: StyleKind.optional().describe(
        "If set, return only that kind; otherwise all three",
      ),
      refresh: z
        .boolean()
        .optional()
        .describe("If true, re-read styles from InDesign (default: cache)"),
      timeoutSec: z.number().int().min(1).max(300).optional(),
    
      },
    },
    withToolError(async ({ styleKind, refresh, timeoutSec }) => {
      try {
        if (refresh) {
          const result = await bridgeFromTimeout(timeoutSec).run({
            requestId: randomUUID(),
            commands: [{ op: "listStyles", styleKind }],
          });
          const body = result.results[0] as {
            styles?: {
              paragraph?: Array<{ name: string }>;
              character?: Array<{ name: string }>;
              object?: Array<{ name: string }>;
            };
          };
          if (body?.styles) {
            const model = sessionStore.get();
            if (model) {
              sessionStore.applyPatch({
                styles: {
                  paragraph: body.styles.paragraph ?? model.styles.paragraph,
                  character: body.styles.character ?? model.styles.character,
                  object: body.styles.object ?? model.styles.object,
                },
              });
            }
            return textResult({
              ok: true,
              fromCache: false,
              styles: body.styles,
            });
          }
        }

        const model = sessionStore.get();
        if (!model) {
          return textResult({
            ok: false,
            message:
              "No Document Model in cache. Call scan_document (or list_styles with refresh:true).",
          });
        }

        const styles = styleKind
          ? { [styleKind]: model.styles[styleKind] }
          : model.styles;

        return textResult({ ok: true, fromCache: true, styles });
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
    "apply_style",
    {
      description:
        "Apply a paragraph, character, or object style to target item(s). Prefer execute_batch when combining with other ops.",
      inputSchema: {
      target: TargetField,
      style: z.string().min(1),
      styleKind: StyleKind.optional().describe("Default: paragraph"),
      timeoutSec: z.number().int().min(1).max(300).optional(),
    
      },
    },
    withToolError(async ({ target, style, styleKind, timeoutSec }) => {
      try {
        const result = await executeBatch(bridgeFromTimeout(timeoutSec), [
          { op: "applyStyle", target, style, styleKind },
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
    "create_style",
    {
      description:
        "Create a paragraph/character/object style (from selection item, basedOn, and/or font size spec).",
      inputSchema: {
      name: z.string().min(1),
      styleKind: StyleKind.optional(),
      basedOn: z.string().optional(),
      fromTarget: TargetField.optional().describe(
        "Copy formatting from this item (uuid / selection)",
      ),
      spec: StyleSpec.optional(),
      timeoutSec: z.number().int().min(1).max(300).optional(),
    
      },
    },
    withToolError(
      async ({ name, styleKind, basedOn, fromTarget, spec, timeoutSec }) => {
        try {
          const command: Record<string, unknown> = {
            op: "createStyle",
            name,
          };
          if (styleKind !== undefined) command.styleKind = styleKind;
          if (basedOn !== undefined) command.basedOn = basedOn;
          if (fromTarget !== undefined) command.fromTarget = fromTarget;
          if (spec !== undefined) command.spec = spec;

          const result = await executeBatch(bridgeFromTimeout(timeoutSec), [
            command,
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
      },
    ),
  );

  server.registerTool(
    "update_style",
    {
      description:
        "Update an existing style definition (spec, basedOn, rename, or copy from an item).",
      inputSchema: {
      style: z.string().min(1).describe("Existing style name"),
      styleKind: StyleKind.optional(),
      basedOn: z.string().optional(),
      fromTarget: TargetField.optional(),
      newName: z.string().min(1).optional(),
      spec: StyleSpec.optional(),
      timeoutSec: z.number().int().min(1).max(300).optional(),
    
      },
    },
    withToolError(
      async ({
        style,
        styleKind,
        basedOn,
        fromTarget,
        newName,
        spec,
        timeoutSec,
      }) => {
        try {
          const command: Record<string, unknown> = {
            op: "updateStyle",
            style,
          };
          if (styleKind !== undefined) command.styleKind = styleKind;
          if (basedOn !== undefined) command.basedOn = basedOn;
          if (fromTarget !== undefined) command.fromTarget = fromTarget;
          if (newName !== undefined) command.newName = newName;
          if (spec !== undefined) command.spec = spec;

          const result = await executeBatch(bridgeFromTimeout(timeoutSec), [
            command,
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
      },
    ),
  );
}
