/**
 * Registry of on-disk .indd checkpoints taken during this session.
 *
 * A snapshot (snapshots.ts) is NOT a backup: it holds bounds, paragraph style
 * and a truncated text preview, and there is no restore operation. When a chain
 * of edits corrupts a page the only way back is a copy of the file, so
 * execute_batch refuses to mutate unless a checkpoint exists for the document
 * generation it is about to change.
 */

export interface CheckpointRecord {
  /** Absolute path of the .indd copy written by the dispatcher. */
  path: string;
  tag: string;
  /** model.meta.generation at the moment the copy was taken. */
  generation: string;
  documentPath: string | null;
  documentName: string | null;
  capturedAt: string;
  /** true when the server took it on its own instead of the caller asking. */
  auto: boolean;
}

export type CheckpointLookup =
  | { status: "valid"; record: CheckpointRecord; ageMs: number }
  | { status: "stale"; record: CheckpointRecord; ageMs: number }
  | { status: "missing"; record: null; ageMs: null };

const MAX_RECORDS = 40;

export class CheckpointStore {
  private records: CheckpointRecord[] = [];

  record(input: Omit<CheckpointRecord, "capturedAt"> & { capturedAt?: string }): CheckpointRecord {
    const rec: CheckpointRecord = {
      ...input,
      capturedAt: input.capturedAt ?? new Date().toISOString(),
    };
    this.records.push(rec);
    if (this.records.length > MAX_RECORDS) {
      this.records = this.records.slice(-MAX_RECORDS);
    }
    return rec;
  }

  /** Most recent checkpoint captured while the document was at `generation`. */
  latestFor(generation: string): CheckpointRecord | null {
    for (let i = this.records.length - 1; i >= 0; i--) {
      const rec = this.records[i]!;
      if (rec.generation === generation) return rec;
    }
    return null;
  }

  /**
   * A checkpoint counts only if it was taken at the current generation (so no
   * structural change slipped in since) and is not older than maxAgeMs.
   */
  lookup(generation: string, maxAgeMs?: number): CheckpointLookup {
    const record = this.latestFor(generation);
    if (!record) return { status: "missing", record: null, ageMs: null };

    const ageMs = Date.now() - Date.parse(record.capturedAt);
    const age = Number.isFinite(ageMs) ? ageMs : 0;
    if (maxAgeMs !== undefined && maxAgeMs > 0 && age > maxAgeMs) {
      return { status: "stale", record, ageMs: age };
    }
    return { status: "valid", record, ageMs: age };
  }

  list(limit = 10): CheckpointRecord[] {
    return this.records.slice(-limit).reverse();
  }

  get size(): number {
    return this.records.length;
  }

  clear(): void {
    this.records = [];
  }
}

/** Process-wide registry (one MCP process serves one InDesign session). */
export const checkpointStore = new CheckpointStore();
