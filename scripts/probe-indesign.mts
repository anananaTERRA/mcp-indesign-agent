#!/usr/bin/env node
/**
 * Probe InDesign via the AppleScript + dispatcher.jsx bridge.
 * Usage: npm run doctor
 */
import {
  createBridge,
  listInstalledIndesignApps,
  resolveIndesignAppName,
  isIndesignRunning,
  BridgeError,
  AppleScriptExtendScriptAdapter,
} from "../src/bridge/index.ts";
import {
  scanResultToModel,
  sessionStore,
  snapshotStore,
  type ScanDocumentResult,
} from "../src/session/index.ts";

function printSection(title: string): void {
  console.log(`\n=== ${title} ===`);
}

async function main(): Promise<void> {
  printSection("Environment");
  console.log(`platform: ${process.platform} ${process.arch}`);
  console.log(`node: ${process.version}`);
  console.log(`INDESIGN_APP_NAME: ${process.env.INDESIGN_APP_NAME ?? "(auto)"}`);
  console.log(`INDESIGN_BRIDGE: ${process.env.INDESIGN_BRIDGE ?? "applescript"}`);
  console.log(
    `INDESIGN_SCRIPT_TIMEOUT_SEC: ${process.env.INDESIGN_SCRIPT_TIMEOUT_SEC ?? "300"}`,
  );

  printSection("Installed InDesign apps");
  const installed = listInstalledIndesignApps();
  if (installed.length === 0) {
    console.log("None found under /Applications");
  } else {
    for (const name of installed) {
      console.log(`- ${name}`);
    }
  }

  const { appName, candidates } = resolveIndesignAppName();
  console.log(`\nUsing: ${appName}`);
  if (candidates.length > 1) {
    console.log(`(candidates: ${candidates.join(", ")})`);
  }

  const running = await isIndesignRunning(appName);
  printSection("Process");
  console.log(running ? `Running: yes (${appName})` : `Running: no (${appName})`);

  if (!running) {
    console.error(
      "\nDoctor failed: open Adobe InDesign (with a document if you want scan), then re-run `npm run doctor`.",
    );
    process.exit(1);
  }

  const bridge = createBridge();
  if (!(bridge instanceof AppleScriptExtendScriptAdapter)) {
    throw new Error("Expected AppleScript bridge for doctor");
  }

  printSection("ping (dispatcher round-trip)");
  const ping = await bridge.ping();
  console.log(`appName: ${ping.appName}`);
  console.log(`version: ${ping.version}`);
  console.log(`locale: ${ping.locale ?? "(unknown)"}`);
  console.log(`bridge: ${ping.bridge}`);
  console.log(`indesignAppName: ${ping.indesignAppName}`);
  if (ping.document) {
    console.log(`document.name: ${ping.document.name}`);
    console.log(`document.path: ${ping.document.path ?? "(unsaved)"}`);
    console.log(`document.pageCount: ${ping.document.pageCount}`);
  } else {
    console.log("document: (none open)");
  }

  printSection("noop");
  const noop = await bridge.run({
    requestId: "doctor-noop",
    commands: [{ op: "noop", echo: "doctor" }],
  });
  console.log(JSON.stringify(noop.results[0], null, 2));

  if (ping.document) {
    printSection("scanDocument (full + UUID labels)");
    const scanRaw = await bridge.run({
      requestId: "doctor-scan",
      commands: [{ op: "scanDocument", depth: "full", writeUuids: true }],
    });
    const body = scanRaw.results[0] as ScanDocumentResult;
    console.log(`meta.name: ${body.meta?.name}`);
    console.log(`meta.pageCount: ${body.meta?.pageCount}`);
    console.log(`meta.generation: ${body.meta?.generation}`);
    console.log(`pages: ${body.pages?.length ?? 0}`);
    console.log(`items: ${body.items?.length ?? 0}`);
    console.log(`layers: ${body.layers?.length ?? 0}`);
    console.log(`styles.paragraph: ${body.styles?.paragraph?.length ?? 0}`);
    console.log(`links: ${body.links?.length ?? 0}`);
    console.log(`selection: ${body.selection?.length ?? 0}`);

    const withUuid = (body.items ?? []).filter((it) => it.uuid);
    console.log(`items with uuid: ${withUuid.length}/${body.items?.length ?? 0}`);
    if (withUuid[0]) {
      console.log(
        `sample item: uuid=${withUuid[0].uuid} type=${withUuid[0].type} page=${withUuid[0].pageIndex}`,
      );
    }

    const model = scanResultToModel(body);
    sessionStore.set(model);
    const before = snapshotStore.capture("before", model);
    console.log(`session cache: ${sessionStore.summary(false).itemCount} items`);
    console.log(`snapshot before: ${before.id}`);

    printSection("scanDocument (2nd call — UUID reuse smoke)");
    const scan2 = await bridge.run({
      requestId: "doctor-scan-2",
      commands: [{ op: "scanDocument", depth: "minimal", writeUuids: true }],
    });
    const body2 = scan2.results[0] as ScanDocumentResult;
    const uuids1 = new Set((body.items ?? []).map((i) => i.uuid));
    const uuids2 = (body2.items ?? []).map((i) => i.uuid);
    const stable = uuids2.filter((u) => uuids1.has(u)).length;
    console.log(`uuid overlap with first scan: ${stable}/${uuids2.length}`);

    printSection("getSelection");
    const sel = await bridge.run({
      requestId: "doctor-selection",
      commands: [{ op: "getSelection", writeUuids: true }],
    });
    console.log(JSON.stringify(sel.results[0], null, 2));
  } else {
    printSection("scanDocument");
    console.log("Skipped (no active document). Open a .indd to exercise scan + UUID.");
  }

  console.log("\nDoctor OK — JSON round-trip via dispatcher succeeded.");
}

main().catch((err: unknown) => {
  if (err instanceof BridgeError) {
    console.error(`\nDoctor failed [${err.code}]: ${err.message}`);
    if (err.details) {
      console.error(err.details);
    }
  } else {
    console.error("\nDoctor failed:", err instanceof Error ? err.message : err);
  }
  process.exit(1);
});
