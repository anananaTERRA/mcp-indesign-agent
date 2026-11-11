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
    op: z.literal("setTextColor"),
    target: TargetSchema,
    fill: FillSchema,
  }),
  z.object({
    op: z.literal("setStroke"),
    target: TargetSchema,
    weightPt: z.number().nonnegative().optional().describe("Stroke weight in points"),
    stroke: FillSchema.optional().describe("Stroke color (swatch|rgb|cmyk)"),
    strokeNone: z.boolean().optional().describe("Clear stroke (weight 0)"),
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
  z.object({
    op: z.literal("createDocument"),
    filePath: z.string().min(1).describe("Absolute path for the new .indd"),
    widthPt: z.number().positive().optional().describe("Page width in points (default A4 595.276)"),
    heightPt: z.number().positive().optional().describe("Page height in points (default A4 841.89)"),
    pageCount: z.number().int().min(1).max(500).optional(),
    facingPages: z.boolean().optional(),
    bleedPt: z.number().nonnegative().optional(),
  }),
  z.object({
    op: z.literal("addPages"),
    count: z.number().int().min(1).max(200).optional().describe("Pages to add (default 1)"),
    afterPageIndex: z
      .number()
      .int()
      .min(-1)
      .optional()
      .describe("0-based page to insert after; -1 = beginning; omit = end"),
  }),
  z.object({
    op: z.literal("ensureSwatch"),
    name: z.string().min(1),
    rgb: z.tuple([z.number(), z.number(), z.number()]).optional(),
    cmyk: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  }),
  z.object({
    op: z.literal("createRectangle"),
    pageIndex: z.number().int().min(0).optional(),
    masterName: z.string().min(1).optional(),
    pageSide: z.enum(["left", "right"]).optional(),
    x: z.number(),
    y: z.number(),
    width: z.number().positive(),
    height: z.number().positive(),
    fill: FillSchema.optional(),
    weightPt: z.number().nonnegative().optional(),
    stroke: FillSchema.optional(),
    strokeNone: z.boolean().optional(),
    sendToBack: z.boolean().optional(),
  }),
  z.object({
    op: z.literal("createOval"),
    pageIndex: z.number().int().min(0).optional(),
    masterName: z.string().min(1).optional(),
    pageSide: z.enum(["left", "right"]).optional(),
    x: z.number(),
    y: z.number(),
    width: z.number().positive(),
    height: z.number().positive(),
    fill: FillSchema.optional(),
    weightPt: z.number().nonnegative().optional(),
    stroke: FillSchema.optional(),
    strokeNone: z.boolean().optional(),
    sendToBack: z.boolean().optional(),
  }),
  z.object({
    op: z.literal("createGraphicLine"),
    pageIndex: z.number().int().min(0).optional(),
    masterName: z.string().min(1).optional(),
    pageSide: z.enum(["left", "right"]).optional(),
    x1: z.number(),
    y1: z.number(),
    x2: z.number(),
    y2: z.number(),
    weightPt: z.number().nonnegative().optional().describe("Default 0.5pt"),
    stroke: FillSchema.optional(),
    sendToBack: z.boolean().optional(),
  }),
  z.object({
    op: z.literal("createBand"),
    pageIndex: z.number().int().min(0).optional(),
    masterName: z.string().min(1).optional(),
    pageSide: z.enum(["left", "right"]).optional(),
    y: z.number().describe("Top of band in points"),
    height: z.number().positive(),
    x: z.number().optional().describe("Default 0 (full-bleed left)"),
    width: z
      .number()
      .positive()
      .optional()
      .describe("Default page width (full-bleed)"),
    fill: FillSchema.optional().describe("Default Marfim rgb[243,238,230]"),
    sendToBack: z
      .boolean()
      .optional()
      .describe("Default true — band behind content"),
  }),
  z.object({
    op: z.literal("placeAsset"),
    filePath: z.string().min(1),
    pageIndex: z.number().int().min(0).optional(),
    masterName: z.string().min(1).optional(),
    pageSide: z.enum(["left", "right"]).optional(),
    x: z.number(),
    y: z.number(),
    width: z.number().positive(),
    height: z.number().positive(),
    shape: z
      .enum(["rectangle", "oval", "ellipse", "circle"])
      .optional()
      .describe("Frame shape; oval/circle for ProfileCard photos"),
    fit: z
      .enum(["proportionally", "fill", "frameToContent", "contentToFrame"])
      .optional()
      .describe("Default fill for oval, proportionally for rectangle"),
  }),
  z.object({
    op: z.literal("convertShape"),
    target: TargetSchema,
    shape: z
      .enum(["oval", "ellipse", "circle", "rectangle", "triangle", "polygon", "line"])
      .optional()
      .describe("Default oval — circular crop for ProfileCard"),
    fit: z
      .enum(["proportionally", "fill", "frameToContent", "contentToFrame"])
      .optional(),
    refit: z.boolean().optional().describe("Re-fit content after convert"),
  }),
  z.object({
    op: z.literal("placeFolio"),
    masterName: z.string().min(1).describe('e.g. "A-Corpo"'),
    pageSide: z
      .enum(["left", "right", "both"])
      .optional()
      .describe("Default both (facing master)"),
    x: z.number().optional(),
    y: z.number().optional().describe("Default pageH-40"),
    width: z.number().positive().optional().describe("Default 48"),
    height: z.number().positive().optional().describe("Default 14"),
    fontFamily: z.string().optional().describe("Default Mulish"),
    fontStyle: z.string().optional().describe("Default Regular"),
    fontSizePt: z.number().positive().optional().describe("Default 8"),
    fill: FillSchema.optional().describe("Default #4a4a4a"),
    align: z.enum(["left", "center", "right"]).optional(),
  }),
  z.object({
    op: z.literal("sendToBack"),
    target: TargetSchema,
  }),
  z.object({
    op: z.literal("bringToFront"),
    target: TargetSchema,
  }),
  z.object({
    op: z.literal("setTextInsets"),
    target: TargetSchema,
    insetPt: z.number().nonnegative().optional().describe("Uniform inset"),
    topPt: z.number().nonnegative().optional(),
    leftPt: z.number().nonnegative().optional(),
    bottomPt: z.number().nonnegative().optional(),
    rightPt: z.number().nonnegative().optional(),
  }),
  z.object({
    op: z.literal("setTextColumns"),
    target: TargetSchema,
    count: z.number().int().min(1).max(40).optional(),
    gutterPt: z.number().nonnegative().optional(),
    ruleWeightPt: z.number().nonnegative().optional(),
    ruleStroke: FillSchema.optional(),
    rule: z.boolean().optional().describe("false clears column rules"),
  }),
  z.object({
    op: z.literal("ensureMaster"),
    name: z.string().min(1),
    basedOn: z.string().optional(),
  }),
  z.object({
    op: z.literal("assignMaster"),
    masterName: z.string().min(1),
    pageIndex: z.number().int().min(0).optional(),
    pageIndexes: z.array(z.number().int().min(0)).optional(),
  }),
  z.object({
    op: z.literal("exportPdf"),
    filePath: z.string().min(1),
    preset: z.string().optional(),
  }),
  z.object({
    op: z.literal("packageDocument"),
    folderPath: z.string().min(1),
    copyFonts: z.boolean().optional(),
    copyLinkedGraphics: z.boolean().optional(),
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
      op: "setTextColor";
      target: string;
      fill: z.infer<typeof FillSchema>;
    }
  | {
      op: "setStroke";
      target: string;
      weightPt?: number;
      stroke?: z.infer<typeof FillSchema>;
      strokeNone?: boolean;
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
    }
  | {
      op: "createDocument";
      filePath: string;
      widthPt?: number;
      heightPt?: number;
      pageCount?: number;
      facingPages?: boolean;
      bleedPt?: number;
    }
  | {
      op: "addPages";
      count?: number;
      afterPageIndex?: number;
    }
  | {
      op: "ensureSwatch";
      name: string;
      rgb?: [number, number, number];
      cmyk?: [number, number, number, number];
    }
  | {
      op: "createRectangle";
      pageIndex?: number;
      masterName?: string;
      pageSide?: "left" | "right";
      x: number;
      y: number;
      width: number;
      height: number;
      fill?: z.infer<typeof FillSchema>;
      weightPt?: number;
      stroke?: z.infer<typeof FillSchema>;
      strokeNone?: boolean;
      sendToBack?: boolean;
    }
  | {
      op: "createOval";
      pageIndex?: number;
      masterName?: string;
      pageSide?: "left" | "right";
      x: number;
      y: number;
      width: number;
      height: number;
      fill?: z.infer<typeof FillSchema>;
      weightPt?: number;
      stroke?: z.infer<typeof FillSchema>;
      strokeNone?: boolean;
      sendToBack?: boolean;
    }
  | {
      op: "createGraphicLine";
      pageIndex?: number;
      masterName?: string;
      pageSide?: "left" | "right";
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      weightPt?: number;
      stroke?: z.infer<typeof FillSchema>;
      sendToBack?: boolean;
    }
  | {
      op: "createBand";
      pageIndex?: number;
      masterName?: string;
      pageSide?: "left" | "right";
      y: number;
      height: number;
      x?: number;
      width?: number;
      fill?: z.infer<typeof FillSchema>;
      sendToBack?: boolean;
    }
  | {
      op: "placeAsset";
      filePath: string;
      pageIndex?: number;
      masterName?: string;
      pageSide?: "left" | "right";
      x: number;
      y: number;
      width: number;
      height: number;
      shape?: "rectangle" | "oval" | "ellipse" | "circle";
      fit?: "proportionally" | "fill" | "frameToContent" | "contentToFrame";
    }
  | {
      op: "convertShape";
      target: string;
      shape?:
        | "oval"
        | "ellipse"
        | "circle"
        | "rectangle"
        | "triangle"
        | "polygon"
        | "line";
      fit?: "proportionally" | "fill" | "frameToContent" | "contentToFrame";
      refit?: boolean;
    }
  | {
      op: "placeFolio";
      masterName: string;
      pageSide?: "left" | "right" | "both";
      x?: number;
      y?: number;
      width?: number;
      height?: number;
      fontFamily?: string;
      fontStyle?: string;
      fontSizePt?: number;
      fill?: z.infer<typeof FillSchema>;
      align?: "left" | "center" | "right";
    }
  | { op: "sendToBack"; target: string }
  | { op: "bringToFront"; target: string }
  | {
      op: "setTextInsets";
      target: string;
      insetPt?: number;
      topPt?: number;
      leftPt?: number;
      bottomPt?: number;
      rightPt?: number;
    }
  | {
      op: "setTextColumns";
      target: string;
      count?: number;
      gutterPt?: number;
      ruleWeightPt?: number;
      ruleStroke?: z.infer<typeof FillSchema>;
      rule?: boolean;
    }
  | {
      op: "ensureMaster";
      name: string;
      basedOn?: string;
    }
  | {
      op: "assignMaster";
      masterName: string;
      pageIndex?: number;
      pageIndexes?: number[];
    }
  | {
      op: "exportPdf";
      filePath: string;
      preset?: string;
    }
  | {
      op: "packageDocument";
      folderPath: string;
      copyFonts?: boolean;
      copyLinkedGraphics?: boolean;
    };

export function parseBatchCommands(input: unknown): BatchCommand[] {
  return BatchCommandsSchema.parse(input);
}
