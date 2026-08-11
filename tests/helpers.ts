import { BridgeError } from "../src/bridge/types.js";
import type {
  BridgeAdapter,
  DispatcherPayload,
  DispatcherResult,
  ModelPatch,
  PingInfo,
} from "../src/bridge/types.js";
import {
  scanResultToModel,
  type DocumentModel,
} from "../src/session/document-model.js";

export const DOC_PATH = "/tmp/mcp-indesign-tests/ProjetoFinalGlossarioIET.indd";

export function makeModel(uuids: string[] = ["a", "b"]): DocumentModel {
  return scanResultToModel({
    op: "scanDocument",
    depth: "full",
    meta: {
      name: "ProjetoFinalGlossarioIET.indd",
      path: DOC_PATH,
      pageCount: 8,
      pageSize: { width: 595, height: 842 },
      units: "Points",
    },
    pages: uuids.map((_, i) => ({ index: i, name: String(i + 1) })) as never,
    items: uuids.map((uuid, i) => ({
      uuid,
      pageIndex: 0,
      itemIndex: i,
      type: "TextFrame",
      bounds: { y1: 0, x1: 0, y2: 100, x2: 200 },
      textPreview: `item ${uuid}`,
    })),
    selection: [],
  });
}

export interface FakeBridgeOptions {
  /** Make op=checkpoint blow up the way a failed saveACopy would. */
  failCheckpoint?: boolean;
  /** Extra modelPatch merged into the response of the mutating round-trip. */
  patch?: ModelPatch;
}

export class FakeBridge implements BridgeAdapter {
  readonly kind = "applescript" as const;
  readonly calls: DispatcherPayload[] = [];

  constructor(private readonly opts: FakeBridgeOptions = {}) {}

  get ops(): string[][] {
    return this.calls.map((c) => c.commands.map((cmd) => String(cmd.op)));
  }

  get checkpointCallCount(): number {
    return this.calls.filter((c) =>
      c.commands.some((cmd) => cmd.op === "checkpoint"),
    ).length;
  }

  async ping(): Promise<PingInfo> {
    throw new Error("ping is not used in these tests");
  }

  async run(payload: DispatcherPayload): Promise<DispatcherResult> {
    this.calls.push(payload);

    const results: unknown[] = [];
    for (const cmd of payload.commands) {
      if (cmd.op === "checkpoint") {
        if (this.opts.failCheckpoint) {
          throw new BridgeError(
            "JSX_EXCEPTION",
            "CHECKPOINT_FAILED: saveACopy to /tmp/... failed (disk full)",
          );
        }
        results.push({
          op: "checkpoint",
          path: `/tmp/mcp-indesign-tests/_checkpoints/doc-${String(cmd.tag)}-20260811-140000.indd`,
          tag: cmd.tag,
          documentName: "ProjetoFinalGlossarioIET.indd",
          documentPath: DOC_PATH,
          pruned: [],
        });
        continue;
      }
      results.push({ op: cmd.op });
    }

    return {
      ok: true,
      results,
      modelPatch: this.opts.patch ?? null,
      transaction: payload.transactionName
        ? { name: payload.transactionName, undoMode: "ENTIRE_SCRIPT" }
        : null,
    };
  }
}
