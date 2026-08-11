import { z } from "zod";

/** Target: uuid string, {uuid}, {role, pageIndex?}, or {selection: true}. */
export const TargetSchema = z.union([
  z.string().min(1),
  z.object({ uuid: z.string().min(1) }),
  z.object({
    role: z.string().min(1),
    pageIndex: z.number().int().min(0).optional(),
  }),
  z.object({ selection: z.literal(true) }),
]);

export type TargetInput = z.infer<typeof TargetSchema>;

const AlignModeSchema = z.enum([
  "left",
  "center",
  "right",
  "top",
  "middle",
  "bottom",
]);

const FillSchema = z.union([
  z.object({ swatch: z.string().min(1) }),
  z.object({
    rgb: z.tuple([z.number(), z.number(), z.number()]),
  }),
  z.object({
    cmyk: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  }),
]);

const StyleSpecSchema = z.object({
  fontFamily: z.string().optional(),
  fontStyle: z.string().optional(),
  fontSizePt: z.number().positive().optional(),
  leadingPt: z.number().positive().optional(),
  spaceBeforePt: z.number().nonnegative().optional(),
  spaceAfterPt: z.number().nonnegative().optional(),
});

/** High-level ops accepted by preview/execute_batch (before target resolution). */
export const BatchCommandSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("checkpoint"),
    tag: z
      .string()
      .min(1)
      .max(60)
      .optional()
      .describe("Short reason, becomes part of the filename (ASCII slug)"),
    keep: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Keep only the N newest checkpoints of this document (default 12)"),
  }),
  z.object({
    op: z.literal("move"),
    target: TargetSchema,
    dx: z.number().optional().describe("Delta X in points"),
    dy: z.number().optional().describe("Delta Y in points"),
    x: z.number().optional().describe("Absolute X (left) in points"),
    y: z.number().optional().describe("Absolute Y (top) in points"),
  }),
  z.object({
    op: z.literal("resize"),
    target: TargetSchema,
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
  }),
  z.object({
    op: z.literal("delete"),
    target: TargetSchema,
  }),
  z.object({
    op: z.literal("duplicate"),
    target: TargetSchema,
    dx: z.number().optional(),
    dy: z.number().optional(),
  }),
  z.object({
    op: z.literal("createTextFrame"),
    pageIndex: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("0-based page (default 0; ignored if below resolves a page)"),
    x: z.number().optional().describe("Left in points (required unless below)"),
    y: z.number().optional().describe("Top in points (required unless below)"),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    text: z.string().optional().describe("Initial contents"),
    style: z.string().optional().describe("Paragraph style name"),
    fontSizePt: z.number().positive().optional(),
    fontFamily: z.string().optional(),
    fontStyle: z.string().optional(),
    below: TargetSchema.optional().describe(
      "Place under this item; inherits x/width when omitted",
    ),
    gapPt: z
      .number()
      .optional()
      .describe("Vertical gap below anchor when using below (default 12)"),
  }),
  z.object({
    op: z.literal("setText"),
    target: TargetSchema,
    text: z.string(),
  }),
  z.object({
    op: z.literal("replaceText"),
    target: TargetSchema,
    find: z.string().min(1),
    replace: z.string(),
    matchCase: z.boolean().optional(),
  }),
  z.object({
    op: z.literal("setFont"),
    target: TargetSchema,
    fontFamily: z.string().optional(),
    fontStyle: z.string().optional(),
    fontSizePt: z.number().positive().optional(),
  }),
  z.object({
    op: z.literal("setFill"),
    target: TargetSchema,
    fill: FillSchema,
  }),
  z.object({
    op: z.literal("align"),
    target: TargetSchema,
    align: AlignModeSchema,
  }),
  z.object({
    op: z.literal("distribute"),
    target: TargetSchema,
    axis: z.enum(["horizontal", "vertical"]),
  }),
  z.object({
    op: z.literal("center"),
    target: TargetSchema,
  }),
  z.object({
    op: z.literal("stack"),
    target: TargetSchema,
    axis: z.enum(["horizontal", "vertical"]).optional(),
    gapPt: z.number().optional(),
    startPt: z.number().optional(),
  }),
  z.object({
    op: z.literal("applyMargins"),
    target: TargetSchema,
    marginPt: z.number().nonnegative().optional(),
  }),
  z.object({
    op: z.literal("applyStyle"),
    target: TargetSchema,
    style: z.string().min(1),
    styleKind: z.enum(["paragraph", "character", "object"]).optional(),
  }),
  z.object({
    op: z.literal("createStyle"),
    name: z.string().min(1),
    styleKind: z.enum(["paragraph", "character", "object"]).optional(),
    basedOn: z.string().optional(),
    fromTarget: TargetSchema.optional(),
    spec: StyleSpecSchema.optional(),
  }),
  z.object({
    op: z.literal("updateStyle"),
    style: z.string().min(1),
    styleKind: z.enum(["paragraph", "character", "object"]).optional(),
    basedOn: z.string().optional(),
    fromTarget: TargetSchema.optional(),
    newName: z.string().min(1).optional(),
    spec: StyleSpecSchema.optional(),
  }),
  z.object({
    op: z.literal("relinkAsset"),
    linkId: z.union([z.string(), z.number()]).optional(),
    name: z.string().optional(),
    filePath: z.string().min(1),
  }),
  z.object({
    op: z.literal("replaceAsset"),
    linkId: z.union([z.string(), z.number()]).optional(),
    name: z.string().optional(),
    filePath: z.string().min(1),
  }),
  z.object({
    op: z.literal("embedAsset"),
    linkId: z.union([z.string(), z.number()]).optional(),
    name: z.string().optional(),
  }),
]);

export type BatchCommand = z.infer<typeof BatchCommandSchema>;

export const BatchCommandsSchema = z.array(BatchCommandSchema).min(1).max(50);

/** Dispatcher wire format after planner resolves targets to uuid(s). */
export type ResolvedDispatcherCommand =
  | { op: "checkpoint"; tag?: string; keep?: number }
  | {
      op: "moveItem";
      target: string;
      dx?: number;
      dy?: number;
      x?: number;
      y?: number;
    }
  | {
      op: "resizeItem";
      target: string;
      width?: number;
      height?: number;
    }
  | { op: "deleteItem"; target: string }
  | {
      op: "duplicateItem";
      target: string;
      dx?: number;
      dy?: number;
    }
  | {
      op: "createTextFrame";
      pageIndex?: number;
      x?: number;
      y?: number;
      width?: number;
      height?: number;
      text?: string;
      style?: string;
      fontSizePt?: number;
      fontFamily?: string;
      fontStyle?: string;
      belowTarget?: string;
      gapPt?: number;
    }
  | { op: "setText"; target: string; text: string }
  | {
      op: "replaceText";
      target: string;
      find: string;
      replace: string;
      matchCase?: boolean;
    }
  | {
      op: "setFont";
      target: string;
      fontFamily?: string;
      fontStyle?: string;
      fontSizePt?: number;
    }
  | {
      op: "setFill";
      target: string;
      fill: z.infer<typeof FillSchema>;
    }
  | {
      op: "alignItems";
      targets: string[];
      align: z.infer<typeof AlignModeSchema>;
    }
  | {
      op: "distributeItems";
      targets: string[];
      axis: "horizontal" | "vertical";
    }
  | { op: "centerItems"; targets: string[] }
  | {
      op: "stackItems";
      targets: string[];
      axis?: "horizontal" | "vertical";
      gapPt?: number;
      startPt?: number;
    }
  | {
      op: "applyMargins";
      targets: string[];
      marginPt?: number;
    }
  | {
      op: "applyStyle";
      target: string;
      style: string;
      styleKind?: "paragraph" | "character" | "object";
    }
  | {
      op: "createStyle";
      name: string;
      styleKind?: "paragraph" | "character" | "object";
      basedOn?: string;
      fromTarget?: string;
      spec?: z.infer<typeof StyleSpecSchema>;
    }
  | {
      op: "updateStyle";
      style: string;
      styleKind?: "paragraph" | "character" | "object";
      basedOn?: string;
      fromTarget?: string;
      newName?: string;
      spec?: z.infer<typeof StyleSpecSchema>;
    }
  | {
      op: "relinkAsset" | "replaceAsset";
      linkId?: string | number;
      name?: string;
      filePath: string;
    }
  | {
      op: "embedAsset";
      linkId?: string | number;
      name?: string;
    };

export function parseBatchCommands(input: unknown): BatchCommand[] {
  return BatchCommandsSchema.parse(input);
}
