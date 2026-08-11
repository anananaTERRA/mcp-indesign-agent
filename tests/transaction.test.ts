/**
 * Every mutating request must arrive at the dispatcher with an ASCII undo label
 * so it can be wrapped in a single UndoModes.ENTIRE_SCRIPT transaction.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, test } from "node:test";
import { executeBatch } from "../src/commands/batch.js";
import { isMutatingOp } from "../src/commands/mutations.js";
import { parseBatchCommands } from "../src/commands/schema.js";
import { planCommands } from "../src/commands/planner.js";
import { toAscii, toAsciiTag } from "../src/lib/ascii.js";
import { checkpointStore } from "../src/session/checkpoints.js";
import { sessionStore } from "../src/session/session-store.js";
import { FakeBridge, makeModel } from "./helpers.js";

const DISPATCHER = fileURLToPath(
  new URL("../extendscript/dispatcher.jsx", import.meta.url),
);

beforeEach(() => {
  checkpointStore.clear();
  sessionStore.set(makeModel());
  delete process.env.INDESIGN_CHECKPOINT_MODE;
});

test("a mutating batch ships a transaction name; a checkpoint-only batch does not", async () => {
  const bridge = new FakeBridge();

  const mutation = await executeBatch(
    bridge,
    [{ op: "setText", target: "a", text: "novo" }],
    { skipCheckpoint: true },
  );
  assert.equal(mutation.transaction?.undoMode, "ENTIRE_SCRIPT");
  assert.equal(bridge.calls[0]?.transactionName, "MCP: setText");

  const cp = await executeBatch(bridge, [{ op: "checkpoint" }]);
  assert.equal(cp.transaction, null);
});

test("a non-ASCII transaction name is folded before it reaches ExtendScript", async () => {
  const bridge = new FakeBridge();

  await executeBatch(
    bridge,
    [{ op: "setText", target: "a", text: "novo" }],
    { skipCheckpoint: true, transactionName: "Renderização do verbete — p.8" },
  );

  const sent = String(bridge.calls[0]?.transactionName);
  assert.equal(sent, "Renderizacao do verbete - p.8");
  // eslint-disable-next-line no-control-regex
  assert.ok(/^[\x20-\x7e]*$/.test(sent), "must be printable ASCII");
});

test("toAscii / toAsciiTag", () => {
  assert.equal(toAscii("ação"), "acao");
  assert.equal(toAscii("plain"), "plain");
  assert.equal(toAscii("verbete nº 8 — p.8"), "verbete no 8 - p.8");
  assert.equal(toAscii("emoji \u{1F600}"), "emoji \\ud83d\\ude00");
  assert.equal(toAsciiTag("Verbete — Nº 8"), "Verbete-No-8");
  assert.equal(toAsciiTag("—"), "batch");
});

test("checkpoint is the only batch op that does not mutate", () => {
  const model = sessionStore.get()!;
  const samples: Array<Record<string, unknown>> = [
    { op: "checkpoint" },
    { op: "move", target: "a", dx: 1 },
    { op: "resize", target: "a", width: 10 },
    { op: "delete", target: "a" },
    { op: "duplicate", target: "a" },
    { op: "createTextFrame", x: 1, y: 1, width: 10, height: 10 },
    { op: "setText", target: "a", text: "x" },
    { op: "replaceText", target: "a", find: "x", replace: "y" },
    { op: "setFont", target: "a", fontSizePt: 10 },
    { op: "setFill", target: "a", fill: { swatch: "Black" } },
    { op: "align", target: "a", align: "left" },
    { op: "distribute", target: ["a", "b"][0]!, axis: "vertical" },
    { op: "center", target: "a" },
    { op: "stack", target: "a" },
    { op: "applyMargins", target: "a" },
    { op: "applyStyle", target: "a", style: "Body" },
    { op: "createStyle", name: "New" },
    { op: "updateStyle", style: "Body" },
    { op: "relinkAsset", name: "img.png", filePath: "/tmp/img.png" },
    { op: "embedAsset", name: "img.png" },
  ];

  for (const sample of samples) {
    const [resolved] = planCommands(parseBatchCommands([sample]), model);
    const mutates = isMutatingOp(resolved!.op);
    assert.equal(
      mutates,
      sample.op !== "checkpoint",
      `${String(sample.op)} → ${resolved!.op} classified wrong`,
    );
  }
});

test("dispatcher wraps mutations in ENTIRE_SCRIPT and keeps checkpoints outside it", () => {
  const src = readFileSync(DISPATCHER, "utf8");
  assert.match(src, /UndoModes\.ENTIRE_SCRIPT/);
  assert.match(src, /function opCheckpoint\(/);
  assert.match(src, /doc\.saveACopy\(out\)/);
  // Inside mcpMain, the checkpoint phase must come before the doScript call.
  const main = src.slice(src.indexOf("function mcpMain("));
  assert.ok(
    main.indexOf('String(commands[c].op) === "checkpoint"') <
      main.indexOf("UndoModes.ENTIRE_SCRIPT"),
    "checkpoints must run before the transaction opens",
  );
  // Mutating-op tables on both sides of the bridge must list the same ops.
  const jsxTable = src.slice(
    src.indexOf("var MCP_MUTATING_OPS = {"),
    src.indexOf("function mcpHasMutation"),
  );
  for (const op of [
    "moveItem",
    "deleteItem",
    "createTextFrame",
    "setText",
    "embedAsset",
  ]) {
    assert.ok(jsxTable.includes(`${op}: 1`), `dispatcher misses ${op}`);
  }
});
