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
  diagnosePageLayout,
  planLayoutFix,
} from "../src/lib/layout-assistant.ts";
import {
  scanResultToModel,
  sessionStore,
  snapshotStore,
  analyzePage,
  applyRolesToModel,
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

    if (withUuid[0]) {
      printSection("moveItem (+20pt Y) then restore (phase 3 smoke)");
      const uuid = withUuid[0].uuid;
      const move = await bridge.run({
        requestId: "doctor-move",
        commands: [{ op: "moveItem", target: uuid, dy: 20 }],
      });
      console.log(`move ok: ${Boolean(move.ok)} patch.updated=${move.modelPatch?.updated?.length ?? 0}`);
      const restore = await bridge.run({
        requestId: "doctor-move-back",
        commands: [{ op: "moveItem", target: uuid, dy: -20 }],
      });
      console.log(
        `restore ok: ${Boolean(restore.ok)} patch.updated=${restore.modelPatch?.updated?.length ?? 0}`,
      );

      printSection("listStyles + applyStyle (phase 4 smoke)");
      const stylesRes = await bridge.run({
        requestId: "doctor-list-styles",
        commands: [{ op: "listStyles" }],
      });
      const stylesBody = stylesRes.results[0] as {
        styles?: { paragraph?: Array<{ name: string }> };
      };
      const para = stylesBody.styles?.paragraph ?? [];
      console.log(`paragraph styles: ${para.length}`);
      const applyTarget =
        para.find(
          (s) =>
            s.name &&
            s.name !== "[No Paragraph Style]" &&
            !s.name.startsWith("["),
        ) ?? para.find((s) => s.name === "[Basic Paragraph]") ?? para[0];
      if (applyTarget && withUuid[0].type === "TextFrame") {
        const apply = await bridge.run({
          requestId: "doctor-apply-style",
          commands: [
            {
              op: "applyStyle",
              target: uuid,
              style: applyTarget.name,
              styleKind: "paragraph",
            },
          ],
        });
        console.log(
          `applyStyle "${applyTarget.name}" ok: ${Boolean(apply.ok)} patch.updated=${apply.modelPatch?.updated?.length ?? 0}`,
        );
      } else {
        console.log("applyStyle skipped (no paragraph style or sample is not TextFrame)");
      }

      printSection("listAssets + checkMissingLinks (phase 4 smoke)");
      const assetsRes = await bridge.run({
        requestId: "doctor-list-assets",
        commands: [{ op: "listAssets" }],
      });
      const assetsBody = assetsRes.results[0] as { count?: number; links?: unknown[] };
      console.log(`assets/links: ${assetsBody.count ?? assetsBody.links?.length ?? 0}`);
      const missingRes = await bridge.run({
        requestId: "doctor-missing-links",
        commands: [{ op: "checkMissingLinks" }],
      });
      const missingBody = missingRes.results[0] as {
        missing?: unknown[];
        outOfDate?: unknown[];
        ok?: boolean;
      };
      console.log(
        `missing=${missingBody.missing?.length ?? 0} outOfDate=${missingBody.outOfDate?.length ?? 0} allOk=${Boolean(missingBody.ok)}`,
      );
    }

    printSection("analyze_page + layout_assistant diagnose (phase 5 smoke)");
    {
      const current = sessionStore.get();
      if (current) {
        const analysis = analyzePage(current, 0);
        sessionStore.set(applyRolesToModel(current, analysis.assignments));
        console.log(`roles page 0: ${JSON.stringify(analysis.roleCounts)}`);
        const sampleRole = analysis.assignments[0];
        if (sampleRole) {
          console.log(
            `sample: uuid=${sampleRole.uuid} role=${sampleRole.role} conf=${sampleRole.confidence}`,
          );
        }
        const diagnosis = diagnosePageLayout(sessionStore.get()!, {
          pageIndex: 0,
          minGapPt: 12,
          marginPt: 24,
        });
        console.log(
          `diagnose: textBoxes=${diagnosis.textBoxCount} overlaps=${diagnosis.overlappingOrTightPairs.length} outside=${diagnosis.outsideSafeArea.length} needsFix=${diagnosis.needsFix}`,
        );
        const previewPlan = planLayoutFix(sessionStore.get()!, {
          pageIndex: 0,
          minGapPt: 18,
          marginPt: 24,
        });
        console.log(
          `layout preview plan: commands=${previewPlan.changeCount} (dry-run only)`,
        );
      }
    }
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
