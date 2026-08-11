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
} from "../commands/index.js";
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

const TargetField = z.union([
  z.string(),
  z.object({ uuid: z.string() }),
  z.object({ role: z.string(), pageIndex: z.number().int().optional() }),
  z.object({ selection: z.literal(true) }),
]);

/**
 * Thin convenience wrapper around execute_batch for a single geometric/text op.
 * Prefer execute_batch when issuing multiple ops.
 */
export function registerOperationTools(server: McpServer): void {
  server.registerTool(
    "execute_operation",
    {
      description:
        "Thin single-op wrapper around execute_batch (checkpoint/move/resize/delete/duplicate/setText/replaceText/setFont/setFill/applyStyle). op=checkpoint saves an .indd copy to _checkpoints/ next to the document and needs no target — run it before a risky sequence of edits. Prefer execute_batch when issuing two or more ops.",
      inputSchema: {
      op: z.enum([
        "checkpoint",
        "move",
        "resize",
        "delete",
        "duplicate",
        "setText",
        "replaceText",
        "setFont",
        "setFill",
        "applyStyle",
      ]),
      target: TargetField.optional().describe(
        "Required for every op except checkpoint",
      ),
      tag: z
        .string()
        .max(60)
        .optional()
        .describe("checkpoint only: short reason, becomes part of the filename"),
      keep: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("checkpoint only: keep the N newest copies (default 12)"),
      skipCheckpoint: z
        .boolean()
        .optional()
        .describe("Mutate with no way back (default false)"),
      dx: z.number().optional(),
      dy: z.number().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.number().positive().optional(),
      height: z.number().positive().optional(),
      text: z.string().optional(),
      find: z.string().optional(),
      replace: z.string().optional(),
      matchCase: z.boolean().optional(),
      fontFamily: z.string().optional(),
      fontStyle: z.string().optional(),
      fontSizePt: z.number().positive().optional(),
      fill: z
        .union([
          z.object({ swatch: z.string() }),
          z.object({ rgb: z.tuple([z.number(), z.number(), z.number()]) }),
          z.object({
            cmyk: z.tuple([z.number(), z.number(), z.number(), z.number()]),
          }),
        ])
        .optional(),
      style: z.string().optional(),
      styleKind: z.enum(["paragraph", "character", "object"]).optional(),
      timeoutSec: z.number().int().min(1).max(300).optional(),
    
      },
    },
    withToolError(async (args) => {
      const { op, target, timeoutSec, skipCheckpoint, ...rest } = args;
      const command: Record<string, unknown> = { op };
      if (target !== undefined) command.target = target;
      for (const [k, v] of Object.entries(rest)) {
        if (v !== undefined) command[k] = v;
      }
      try {
        const result = await executeBatch(
          bridgeFromTimeout(timeoutSec),
          [command],
          { skipCheckpoint },
        );
        return textResult(result);
      } catch (err) {
        if (err instanceof CheckpointRequiredError) {
          return textResult(checkpointRefusalPayload(err));
        }
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
