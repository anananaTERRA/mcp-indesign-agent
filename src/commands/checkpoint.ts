/**
 * The safety gate that stands in front of every mutation.
 *
 * Background: a run of ad-hoc patch scripts destroyed page 8 of a production
 * book because nothing on the way in required a way back. `snapshot` looked
 * like a net but stores metadata only, and no script asked for an .indd copy.
 * This module makes the copy a precondition of mutating, not a good intention.
 */

import { randomUUID } from "node:crypto";
import type { BridgeAdapter } from "../bridge/types.js";
import { toAsciiTag } from "../lib/ascii.js";
import {
  checkpointStore,
  type CheckpointLookup,
  type CheckpointRecord,
} from "../session/checkpoints.js";
import type { DocumentModel } from "../session/document-model.js";

export type CheckpointMode = "auto" | "require" | "off";

export const DEFAULT_CHECKPOINT_KEEP = 12;
const DEFAULT_MAX_AGE_MIN = 120;

/**
 * auto    (default) take the copy on the caller's behalf, refuse if that fails
 * require never write on our own; refuse until the caller runs op=checkpoint
 * off     escape hatch for environments where saveACopy is not possible
 */
export function getCheckpointMode(): CheckpointMode {
  const raw = (process.env.INDESIGN_CHECKPOINT_MODE ?? "auto").trim().toLowerCase();
  if (raw === "require" || raw === "off") return raw;
  return "auto";
}

export function getCheckpointMaxAgeMs(): number {
  const raw = process.env.INDESIGN_CHECKPOINT_MAX_AGE_MIN;
  const minutes = raw === undefined ? DEFAULT_MAX_AGE_MIN : Number(raw);
  if (!Number.isFinite(minutes) || minutes < 0) return DEFAULT_MAX_AGE_MIN * 60_000;
  return minutes * 60_000;
}

export function getCheckpointKeep(): number {
  const raw = Number(process.env.INDESIGN_CHECKPOINT_KEEP);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_CHECKPOINT_KEEP;
  return Math.floor(raw);
}

export type CheckpointGateStatus =
  | "created"
  | "reused"
  | "in-batch"
  | "skipped"
  | "disabled"
  | "not-needed";

export interface CheckpointGateResult {
  status: CheckpointGateStatus;
  path: string | null;
  generation: string;
  tag?: string;
  capturedAt?: string;
  reason?: string;
}

export class CheckpointRequiredError extends Error {
  readonly code = "CHECKPOINT_REQUIRED";
  readonly generation: string;
  readonly remedy: string[];
  readonly failureCause?: unknown;

  constructor(opts: {
    generation: string;
    documentName: string | null;
    lookup: CheckpointLookup;
    mutatingOps: string[];
    cause?: unknown;
  }) {
    const doc = opts.documentName ?? "the active document";
    const why =
      opts.cause !== undefined
        ? `the automatic checkpoint failed (${errText(opts.cause)})`
        : opts.lookup.status === "stale"
          ? `the newest checkpoint for this generation is ${Math.round(
              (opts.lookup.ageMs ?? 0) / 60_000,
            )} min old`
          : "no checkpoint has been taken for the current document generation";

    super(
      `CHECKPOINT_REQUIRED: refusing to run ${opts.mutatingOps.join(", ") || "a mutation"} on ${doc} because ${why}. ` +
        `snapshot is NOT a backup — it stores bounds/style/text previews and has no restore, so an .indd copy on disk is the only way back from a bad edit. ` +
        `Fix it by: (1) execute_operation {op:"checkpoint", tag:"<short-reason>"}, or (2) putting {"op":"checkpoint"} first in this batch, or (3) passing skipCheckpoint:true to accept losing the rollback.`,
    );
    this.name = "CheckpointRequiredError";
    this.generation = opts.generation;
    this.failureCause = opts.cause;
    this.remedy = [
      'execute_operation {op:"checkpoint", tag:"<short-reason>"} then retry',
      'add {"op":"checkpoint"} as the first command of this batch',
      "pass skipCheckpoint:true to mutate without a way back (deliberate)",
    ];
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface DispatcherCheckpointResult {
  op: "checkpoint";
  path: string;
  folder?: string;
  tag?: string;
  keep?: number;
  pruned?: string[];
  documentName?: string;
  documentPath?: string | null;
}

/** One dispatcher round-trip that does nothing but write the .indd copy. */
export async function createCheckpoint(
  bridge: BridgeAdapter,
  opts: { tag: string; keep?: number; generation: string; auto: boolean },
): Promise<CheckpointRecord> {
  const tag = toAsciiTag(opts.tag);
  const result = await bridge.run({
    requestId: randomUUID(),
    commands: [{ op: "checkpoint", tag, keep: opts.keep ?? getCheckpointKeep() }],
  });

  const first = result.results?.[0] as DispatcherCheckpointResult | undefined;
  if (!first?.path) {
    throw new Error(
      "dispatcher ran op=checkpoint but returned no file path; treat the document as unprotected",
    );
  }

  return checkpointStore.record({
    path: first.path,
    tag: first.tag ?? tag,
    generation: opts.generation,
    documentPath: first.documentPath ?? null,
    documentName: first.documentName ?? null,
    auto: opts.auto,
  });
}

/** Register a checkpoint the caller asked for inside their own batch. */
export function recordInBatchCheckpoint(
  results: unknown[],
  generation: string,
): CheckpointRecord | null {
  let last: CheckpointRecord | null = null;
  for (const raw of results) {
    const res = raw as DispatcherCheckpointResult | null;
    if (!res || res.op !== "checkpoint" || !res.path) continue;
    last = checkpointStore.record({
      path: res.path,
      tag: res.tag ?? "batch",
      generation,
      documentPath: res.documentPath ?? null,
      documentName: res.documentName ?? null,
      auto: false,
    });
  }
  return last;
}

export interface EnsureCheckpointOptions {
  mutatingOps: string[];
  /** The batch already carries its own op=checkpoint (dispatcher runs it first). */
  carriesCheckpoint: boolean;
  skip: boolean;
  tag?: string;
}

/**
 * Decides whether the batch about to run is allowed to touch the document.
 *
 * Default is auto rather than a plain refusal: a hard "no" that an agent can
 * clear by re-sending with skipCheckpoint:true is a gate in name only, whereas
 * a gate that costs one saveACopy and no extra turn is the one that survives
 * contact with a hurried caller. Refusal stays as the fallback when the copy
 * cannot be written, which is the case where mutating really is unsafe.
 */
export async function ensureCheckpoint(
  bridge: BridgeAdapter,
  model: DocumentModel,
  opts: EnsureCheckpointOptions,
): Promise<CheckpointGateResult> {
  const generation = model.meta.generation;

  if (opts.carriesCheckpoint) {
    return {
      status: "in-batch",
      path: null,
      generation,
      reason: "batch carries its own op=checkpoint, run before the transaction",
    };
  }
  if (opts.mutatingOps.length === 0) {
    return { status: "not-needed", path: null, generation };
  }
  if (opts.skip) {
    return {
      status: "skipped",
      path: null,
      generation,
      reason: "caller passed skipCheckpoint — this mutation has no way back",
    };
  }

  const mode = getCheckpointMode();
  if (mode === "off") {
    return {
      status: "disabled",
      path: null,
      generation,
      reason: "INDESIGN_CHECKPOINT_MODE=off",
    };
  }

  const lookup = checkpointStore.lookup(generation, getCheckpointMaxAgeMs());
  if (lookup.status === "valid") {
    return {
      status: "reused",
      path: lookup.record.path,
      generation,
      tag: lookup.record.tag,
      capturedAt: lookup.record.capturedAt,
    };
  }

  if (mode === "require") {
    throw new CheckpointRequiredError({
      generation,
      documentName: model.meta.name,
      lookup,
      mutatingOps: opts.mutatingOps,
    });
  }

  try {
    const rec = await createCheckpoint(bridge, {
      tag: opts.tag ?? opts.mutatingOps[0] ?? "batch",
      generation,
      auto: true,
    });
    return {
      status: "created",
      path: rec.path,
      generation,
      tag: rec.tag,
      capturedAt: rec.capturedAt,
    };
  } catch (err) {
    throw new CheckpointRequiredError({
      generation,
      documentName: model.meta.name,
      lookup,
      mutatingOps: opts.mutatingOps,
      cause: err,
    });
  }
}
