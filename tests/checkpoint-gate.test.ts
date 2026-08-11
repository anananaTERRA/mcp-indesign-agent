/**
 * The gate that would have stopped the cascade: no .indd copy on disk, no
 * mutation. See src/commands/checkpoint.ts.
 */
import assert from "node:assert/strict";
import { beforeEach, afterEach, test } from "node:test";
import { executeBatch } from "../src/commands/batch.js";
import { CheckpointRequiredError } from "../src/commands/checkpoint.js";
import { checkpointStore } from "../src/session/checkpoints.js";
import { sessionStore } from "../src/session/session-store.js";
import { FakeBridge, makeModel } from "./helpers.js";

beforeEach(() => {
  checkpointStore.clear();
  sessionStore.set(makeModel());
  delete process.env.INDESIGN_CHECKPOINT_MODE;
});

afterEach(() => {
  delete process.env.INDESIGN_CHECKPOINT_MODE;
});

test("mode=require: a mutating batch with no checkpoint is refused and never reaches InDesign", async () => {
  process.env.INDESIGN_CHECKPOINT_MODE = "require";
  const bridge = new FakeBridge();

  const err = await executeBatch(bridge, [
    { op: "setText", target: "a", text: "novo" },
  ]).then(
    () => null,
    (e: unknown) => e,
  );

  assert.ok(err instanceof CheckpointRequiredError, "expected a refusal");
  assert.equal(err.code, "CHECKPOINT_REQUIRED");
  assert.match(err.message, /snapshot is NOT a backup/);
  assert.match(err.message, /skipCheckpoint/);
  assert.equal(bridge.calls.length, 0, "nothing may be sent to InDesign");
});

test("mode=require: a checkpoint-only batch is not blocked and unlocks the next mutation", async () => {
  process.env.INDESIGN_CHECKPOINT_MODE = "require";
  const bridge = new FakeBridge();

  const cp = await executeBatch(bridge, [{ op: "checkpoint", tag: "pre-edit" }]);
  assert.equal(cp.checkpoint.status, "in-batch");
  assert.equal(cp.transaction, null, "a checkpoint alone needs no undo step");
  assert.equal(checkpointStore.size, 1);
  assert.match(String(cp.checkpoint.path), /_checkpoints\/.*pre-edit/);

  // Same generation, so the copy still describes the state we are about to change.
  const edit = await executeBatch(bridge, [
    { op: "setText", target: "a", text: "novo" },
  ]);
  assert.equal(edit.checkpoint.status, "reused");
  assert.equal(bridge.checkpointCallCount, 1, "no second copy needed");
});

test("mode=auto: the copy is written in its own round-trip before the mutation", async () => {
  const bridge = new FakeBridge();

  const result = await executeBatch(bridge, [
    { op: "setText", target: "a", text: "novo" },
  ]);

  assert.equal(result.checkpoint.status, "created");
  assert.deepEqual(bridge.ops, [["checkpoint"], ["setText"]]);
  assert.equal(checkpointStore.size, 1);
});

test("mode=auto: a failed saveACopy still refuses the mutation", async () => {
  const bridge = new FakeBridge({ failCheckpoint: true });

  const err = await executeBatch(bridge, [
    { op: "delete", target: "a" },
  ]).then(
    () => null,
    (e: unknown) => e,
  );

  assert.ok(err instanceof CheckpointRequiredError);
  assert.match(err.message, /saveACopy/);
  assert.deepEqual(bridge.ops, [["checkpoint"]], "the delete must not run");
});

test("skipCheckpoint:true is an explicit way out", async () => {
  const bridge = new FakeBridge();

  const result = await executeBatch(
    bridge,
    [{ op: "setText", target: "a", text: "novo" }],
    { skipCheckpoint: true },
  );

  assert.equal(result.checkpoint.status, "skipped");
  assert.match(String(result.checkpoint.reason), /no way back/);
  assert.deepEqual(bridge.ops, [["setText"]]);
});

test("a batch carrying its own checkpoint is not checkpointed twice", async () => {
  const bridge = new FakeBridge();

  const result = await executeBatch(bridge, [
    { op: "checkpoint", tag: "verbete-8" },
    { op: "setText", target: "a", text: "novo" },
  ]);

  assert.equal(result.checkpoint.status, "in-batch");
  assert.deepEqual(bridge.ops, [["checkpoint", "setText"]]);
  assert.equal(checkpointStore.size, 1);
  assert.match(String(result.checkpoint.path), /verbete-8/);
});

test("INDESIGN_CHECKPOINT_MODE=off disables the gate entirely", async () => {
  process.env.INDESIGN_CHECKPOINT_MODE = "off";
  const bridge = new FakeBridge();

  const result = await executeBatch(bridge, [
    { op: "setText", target: "a", text: "novo" },
  ]);

  assert.equal(result.checkpoint.status, "disabled");
  assert.deepEqual(bridge.ops, [["setText"]]);
});

test("adding a frame changes the generation, so the old checkpoint stops counting", async () => {
  const bridge = new FakeBridge({
    patch: {
      updated: [
        {
          uuid: "c",
          pageIndex: 0,
          type: "TextFrame",
          bounds: { y1: 0, x1: 0, y2: 20, x2: 100 },
        },
      ],
      removed: [],
    },
  });

  const before = sessionStore.get()!.meta.generation;
  const first = await executeBatch(bridge, [
    { op: "createTextFrame", x: 10, y: 10, width: 100, height: 20, text: "oi" },
  ]);
  assert.equal(first.checkpoint.status, "created");

  const after = sessionStore.get()!.meta.generation;
  assert.notEqual(after, before, "a new frame must move the generation");

  const second = await executeBatch(bridge, [
    { op: "setText", target: "a", text: "novo" },
  ]);
  assert.equal(
    second.checkpoint.status,
    "created",
    "the pre-createTextFrame copy no longer describes the document",
  );
  assert.equal(checkpointStore.size, 2);
});

test("a text edit keeps the generation, so one checkpoint covers a run of them", async () => {
  const bridge = new FakeBridge();

  await executeBatch(bridge, [{ op: "setText", target: "a", text: "1" }]);
  const second = await executeBatch(bridge, [
    { op: "setText", target: "b", text: "2" },
  ]);

  assert.equal(second.checkpoint.status, "reused");
  assert.equal(bridge.checkpointCallCount, 1);
});

test("a checkpoint older than the max age is not trusted", async () => {
  process.env.INDESIGN_CHECKPOINT_MODE = "require";
  const model = sessionStore.get()!;
  checkpointStore.record({
    path: "/tmp/old.indd",
    tag: "old",
    generation: model.meta.generation,
    documentPath: model.meta.path,
    documentName: model.meta.name,
    auto: false,
    capturedAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
  });

  const err = await executeBatch(new FakeBridge(), [
    { op: "setText", target: "a", text: "novo" },
  ]).then(
    () => null,
    (e: unknown) => e,
  );

  assert.ok(err instanceof CheckpointRequiredError);
  assert.match(err.message, /min old/);
});
