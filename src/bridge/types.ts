export type BridgeKind = "applescript";

export type DispatcherOp =
  | "ping"
  | "noop"
  | "scanDocument"
  | "getSelection"
  | "checkpoint"
  | "moveItem"
  | "resizeItem"
  | "deleteItem"
  | "duplicateItem"
  | "setText"
  | "replaceText"
  | "setFont"
  | "setFill"
  | "alignItems"
  | "distributeItems"
  | "centerItems"
  | "stackItems"
  | "applyMargins"
  | "listStyles"
  | "applyStyle"
  | "createStyle"
  | "updateStyle"
  | "listAssets"
  | "checkMissingLinks"
  | "relinkAsset"
  | "replaceAsset"
  | "embedAsset"
  | string;

export interface DispatcherCommand {
  op: DispatcherOp;
  [key: string]: unknown;
}

export interface DispatcherPayload {
  requestId: string;
  commands: DispatcherCommand[];
  /**
   * Undo-menu label for the ENTIRE_SCRIPT transaction wrapping the mutating
   * commands. Must be ASCII — see lib/ascii.ts.
   */
  transactionName?: string;
}

export interface ModelPatchItem {
  uuid: string;
  pageIndex?: number | null;
  itemIndex?: number;
  type?: string;
  bounds?: {
    y1: number;
    x1: number;
    y2: number;
    x2: number;
  } | null;
  textPreview?: string;
  parentUuid?: string | null;
  layerName?: string | null;
  paragraphStyle?: string | null;
  fontSize?: number | null;
  role?: string | null;
}

export interface ModelPatchStyles {
  paragraph?: Array<{ name: string }>;
  character?: Array<{ name: string }>;
  object?: Array<{ name: string }>;
}

export interface ModelPatchLink {
  id: string;
  name: string;
  filePath: string | null;
  status: string;
  pageIndex: number | null;
}

export interface ModelPatch {
  updated?: ModelPatchItem[];
  removed?: Array<string | { uuid: string }>;
  styles?: ModelPatchStyles | null;
  links?: ModelPatchLink[] | null;
}

export interface DispatcherErrorBody {
  message: string;
  name?: string;
  /** Index in the commands array that threw, when the failure was inside an op. */
  failedIndex?: number;
  failedOp?: string;
  /** True when the ENTIRE_SCRIPT transaction reverted the whole request. */
  rolledBack?: boolean;
}

export interface DispatcherResult {
  ok: boolean;
  requestId?: string | null;
  results: unknown[];
  modelPatch?: ModelPatch | null;
  transaction?: { name: string; undoMode: string } | null;
  error?: DispatcherErrorBody;
}

export interface PingDocumentInfo {
  name: string;
  path: string | null;
  pageCount: number;
}

export interface PingInfo {
  appName: string;
  version: string;
  locale?: string;
  document: PingDocumentInfo | null;
  bridge: BridgeKind;
  indesignAppName: string;
}

export type BridgeErrorCode =
  | "APP_CLOSED"
  | "APP_NOT_FOUND"
  | "NO_DOCUMENT"
  | "TIMEOUT"
  | "JSX_EXCEPTION"
  | "BRIDGE"
  | "CONFIG";

export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  readonly details?: unknown;

  constructor(code: BridgeErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.details = details;
  }
}

export interface BridgeAdapter {
  readonly kind: BridgeKind;
  ping(): Promise<PingInfo>;
  run(payload: DispatcherPayload): Promise<DispatcherResult>;
}
