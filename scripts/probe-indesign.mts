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
    printSection("scanDocument (minimal)");
    const scan = await bridge.run({
      requestId: "doctor-scan",
      commands: [{ op: "scanDocument", depth: "minimal" }],
    });
    const body = scan.results[0] as {
      meta?: { name?: string; pageCount?: number };
      pages?: unknown[];
      items?: unknown[];
    };
    console.log(`meta.name: ${body.meta?.name}`);
    console.log(`meta.pageCount: ${body.meta?.pageCount}`);
    console.log(`pages: ${body.pages?.length ?? 0}`);
    console.log(`items: ${body.items?.length ?? 0}`);
  } else {
    printSection("scanDocument");
    console.log("Skipped (no active document). Open a .indd to exercise scan.");
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
