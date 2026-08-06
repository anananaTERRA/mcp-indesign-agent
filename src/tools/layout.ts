import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  AppleScriptExtendScriptAdapter,
  BridgeError,
  createBridge,
  type BridgeAdapter,
} from "../bridge/index.js";
import { executeBatch, PlannerError } from "../commands/index.js";
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

export function registerLayoutTools(server: McpServer): void {
  server.tool(
    "layout_operation",
    "Layout helpers: align | distribute | center | stack | applyMargins. Prefer execute_batch when combining with other ops.",
    {
      op: z.enum(["align", "distribute", "center", "stack", "applyMargins"]),
      target: TargetField.describe(
        "Usually {selection:true} or multiple items via role; uuid for a single item",
      ),
      align: z
        .enum(["left", "center", "right", "top", "middle", "bottom"])
        .optional(),
      axis: z.enum(["horizontal", "vertical"]).optional(),
      gapPt: z.number().optional(),
      startPt: z.number().optional(),
      marginPt: z.number().nonnegative().optional(),
      timeoutSec: z.number().int().min(1).max(300).optional(),
    },
    withToolError(async (args) => {
      const { op, target, timeoutSec, align, axis, gapPt, startPt, marginPt } =
        args;
      const command: Record<string, unknown> = { op, target };
      if (align !== undefined) command.align = align;
      if (axis !== undefined) command.axis = axis;
      if (gapPt !== undefined) command.gapPt = gapPt;
      if (startPt !== undefined) command.startPt = startPt;
      if (marginPt !== undefined) command.marginPt = marginPt;

      try {
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
    }),
  );
}
