import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  AppleScriptExtendScriptAdapter,
  BridgeError,
  createBridge,
  type BridgeAdapter,
} from "../bridge/index.js";
import { executeBatch, PlannerError, previewBatch } from "../commands/index.js";
import {
  diagnosePageLayout,
  planLayoutFix,
  summarizeStackPlan,
} from "../lib/layout-assistant.js";
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

  server.tool(
    "layout_assistant",
    "Diagnose or fix page layout issues (overlapping/tight text, items outside margins). Modes: diagnose | preview | fix. Prefer analyze_page first when talking about titles/headers by role. Units are points.",
    {
      mode: z
        .enum(["diagnose", "preview", "fix"])
        .describe(
          "diagnose: report issues; preview: dry-run stack/margin plan; fix: execute_batch the plan",
        ),
      pageIndex: z.number().int().min(0).describe("0-based page index"),
      minGapPt: z
        .number()
        .positive()
        .optional()
        .describe("Minimum vertical gap between text frames (diagnose default 12, fix default 18)"),
      marginPt: z
        .number()
        .nonnegative()
        .optional()
        .describe("Safe margin from page edges (default 24pt)"),
      expandTitles: z
        .boolean()
        .optional()
        .describe("Expand title-like frames to estimated text height (default true for preview/fix)"),
      uuids: z
        .array(z.string())
        .optional()
        .describe("Limit text stacking to these uuids"),
      fixMargins: z
        .boolean()
        .optional()
        .describe("Also clamp outside-safe items (default true for preview/fix)"),
      timeoutSec: z.number().int().min(1).max(300).optional(),
    },
    withToolError(async (args) => {
      const model = sessionStore.get();
      if (!model) {
        throw new PlannerError(
          "No Document Model in cache. Call scan_document before layout_assistant.",
        );
      }
      if (args.pageIndex >= model.meta.pageCount) {
        throw new PlannerError(
          `pageIndex ${args.pageIndex} out of range (document has ${model.meta.pageCount} page(s))`,
        );
      }

      if (args.mode === "diagnose") {
        const diagnosis = diagnosePageLayout(model, {
          pageIndex: args.pageIndex,
          minGapPt: args.minGapPt,
          marginPt: args.marginPt,
          uuids: args.uuids,
        });
        return textResult({ ok: true, mode: "diagnose", ...diagnosis });
      }

      const plan = planLayoutFix(model, {
        pageIndex: args.pageIndex,
        minGapPt: args.minGapPt,
        marginPt: args.marginPt,
        expandTitles: args.expandTitles,
        uuids: args.uuids,
        fixMargins: args.fixMargins,
      });

      const payload = {
        ok: true as const,
        mode: args.mode,
        diagnosis: plan.diagnosis,
        changeCount: plan.changeCount,
        stackPlan: summarizeStackPlan(plan.stackPlan),
        commands: plan.commands,
      };

      if (args.mode === "preview") {
        if (plan.commands.length === 0) {
          return textResult({
            ...payload,
            preview: null,
            message: "No geometry changes needed",
          });
        }
        try {
          const preview = previewBatch(plan.commands);
          return textResult({ ...payload, preview });
        } catch (err) {
          if (err instanceof PlannerError || err instanceof z.ZodError) {
            return textResult({
              ...payload,
              ok: false,
              message: err instanceof Error ? err.message : String(err),
            });
          }
          throw err;
        }
      }

      // mode === fix
      if (plan.commands.length === 0) {
        return textResult({
          ...payload,
          execute: null,
          message: "No geometry changes needed",
        });
      }

      try {
        const execute = await executeBatch(
          bridgeFromTimeout(args.timeoutSec),
          plan.commands,
        );
        return textResult({ ...payload, execute });
      } catch (err) {
        if (err instanceof BridgeError) {
          return textResult({
            ok: false,
            code: err.code,
            message: err.message,
            commands: plan.commands,
          });
        }
        if (err instanceof PlannerError || err instanceof z.ZodError) {
          return textResult({
            ok: false,
            message: err instanceof Error ? err.message : String(err),
            commands: plan.commands,
          });
        }
        throw err;
      }
    }),
  );
}
