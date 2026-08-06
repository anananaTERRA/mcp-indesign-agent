export type BridgeKind = "applescript";

export type DispatcherOp =
  | "ping"
  | "noop"
  | "scanDocument"
  | "getSelection"
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
  | string;

export interface DispatcherCommand {
  op: DispatcherOp;
  [key: string]: unknown;
}

export interface DispatcherPayload {
  requestId: string;
  commands: DispatcherCommand[];
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

export interface ModelPatch {
  updated?: ModelPatchItem[];
  removed?: Array<string | { uuid: string }>;
}

export interface DispatcherErrorBody {
  message: string;
  name?: string;
}

export interface DispatcherResult {
  ok: boolean;
  requestId?: string | null;
  results: unknown[];
  modelPatch?: ModelPatch | null;
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
