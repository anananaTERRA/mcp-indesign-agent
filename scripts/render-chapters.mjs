#!/usr/bin/env node
/**
 * Place country chapters + divider into the active publication .indd
 * via the compiled bridge (Unicode-safe JSON requests).
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createBridge, BridgeError } from "../dist/bridge/index.js";

const ROOT =
  "/Users/anaterra/Documents/Mapeamento-Organizacoes-Lemann-Vozes/03_Publicacao";
const inventory = JSON.parse(
  readFileSync(`${ROOT}/content/inventory.json`, "utf8"),
);

const PW = 595.276;
const PH = 841.89;
const M = { left: 48, right: 48, top: 56, bottom: 56 };
const CW = PW - M.left - M.right;
const CH = PH - M.top - M.bottom;

const PROFILE_MAP = {
  "Anna Ritzema": `${ROOT}/links/perfis/perfil-anna-ritzema-duotone-circle.png`,
  "Michael Cohen": `${ROOT}/links/perfis/perfil-michael-cohen-duotone-circle.png`,
  "Victoria Pendry": `${ROOT}/links/perfis/perfil-victoria-pendry-duotone-circle.png`,
  "Grace Healy": `${ROOT}/links/perfis/perfil-grace-healy-duotone-circle.png`,
  "Aisha Isa": `${ROOT}/links/perfis/perfil-aisha-isa-duotone-circle.png`,
  "Alfredo Grez Kaulen": `${ROOT}/links/perfis/perfil-alfredo-grez-kaulen-duotone-circle.png`,
};

const COUNTRY_ACCENT = {
  australia: "Vozes/VerdeVivo",
  eua: "Vozes/Azul",
  inglaterra: "Vozes/Roxo2",
  nigeria: "Vozes/Laranja",
  chile: "Vozes/Verde",
};

const bridge = createBridge();

async function run(commands, label) {
  if (!commands.length) return null;
  // batch max 50
  const chunks = [];
  for (let i = 0; i < commands.length; i += 40) {
    chunks.push(commands.slice(i, i + 40));
  }
  let last = null;
  for (let i = 0; i < chunks.length; i++) {
    const part = chunks[i];
    console.log(`  → ${label} [${i + 1}/${chunks.length}] (${part.length})`);
    last = await bridge.run({
      requestId: randomUUID(),
      commands: part,
      transactionName: `${label}-${i}`.replace(/[^\x20-\x7E]/g, "?").slice(0, 100),
    });
    if (!last.ok) {
      console.error(JSON.stringify(last.error || last, null, 2));
      throw new Error(label);
    }
  }
  return last;
}

function sectionBlocks(id) {
  const secs = inventory.sections;
  const idx = secs.findIndex((s) => s.id === id);
  if (idx < 0) return [];
  const start = secs[idx].start;
  const end = idx + 1 < secs.length ? secs[idx + 1].start : inventory.blocks.length;
  return inventory.blocks.filter((b) => b.i >= start && b.i < end);
}

function styleFor(block) {
  const t = block.text || "";
  if (/^\d+\.\d+/.test(t) || /^\d+\.\s/.test(t) && t.length < 80) {
    if (/^\d+\.\d+/.test(t)) return "Subsecao/Titulo";
    return "Secao/Titulo";
  }
  if (t === t.toUpperCase() && t.length < 60 && t.length > 2) return "Secao/Titulo";
  return "Corpo";
}

function chunkText(text, maxChars) {
  if (text.length <= maxChars) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf("\r", maxChars);
    if (cut < maxChars * 0.4) cut = rest.lastIndexOf(" ", maxChars);
    if (cut < maxChars * 0.4) cut = maxChars;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

async function paintWhiteTextOnPage(pageIndex) {
  const scan = await bridge.run({
    requestId: randomUUID(),
    commands: [{ op: "scanDocument", depth: "minimal", writeUuids: true }],
  });
  const items = (scan.results[0].items || []).filter(
    (it) => it.pageIndex === pageIndex && it.type === "TextFrame",
  );
  if (!items.length) return;
  await run(
    items.map((it) => ({
      op: "setTextColor",
      target: it.uuid,
      fill: { rgb: [255, 255, 255] },
    })),
    `white-text-p${pageIndex}`,
  );
}

async function placeCountry({ id, title, startPage, pageBudget: initialBudget }) {
  let pageBudget = initialBudget;
  const accent = COUNTRY_ACCENT[id] || "Vozes/Roxo";
  const blocks = sectionBlocks(id);
  console.log(`\n=== ${title} (${blocks.length} blocks) pages ${startPage}..${startPage + pageBudget - 1}`);

  // Opening page
  await run(
    [
      {
        op: "assignMaster",
        masterName: "B-Abertura",
        pageIndex: startPage,
      },
      {
        op: "createRectangle",
        pageIndex: startPage,
        x: 0,
        y: 0,
        width: PW,
        height: PH,
        fill: { swatch: accent },
      },
      {
        op: "createTextFrame",
        pageIndex: startPage,
        x: M.left,
        y: PH * 0.38,
        width: CW,
        height: 80,
        text: title,
        style: "Capitulo/Titulo",
      },
    ],
    `${id}-open`,
  );
  await paintWhiteTextOnPage(startPage);

  // Stream content across following pages
  let page = startPage + 1;
  let y = M.top;
  const cmds = [];
  const flush = async () => {
    if (!cmds.length) return;
    const batch = cmds.splice(0, cmds.length);
    await run(batch, `${id}-body-p${page}`);
  };

  const ensurePageSpace = async (needed) => {
    if (y + needed > PH - M.bottom) {
      await flush();
      page += 1;
      y = M.top;
      if (page >= startPage + pageBudget) {
        // extend document instead of failing
        await run([{ op: "addPages", count: 4 }], `${id}-add-pages`);
        pageBudget += 4;
      }
    }
  };

  for (const b of blocks) {
    if (page >= startPage + pageBudget) break;
    const t = (b.text || "").trim();
    if (t === title.toUpperCase() + "." || t === title.toUpperCase()) continue;

    // Profile photo
    if (b.images?.length && Object.keys(PROFILE_MAP).some((n) => t.startsWith(n))) {
      const name = Object.keys(PROFILE_MAP).find((n) => t.startsWith(n));
      const path = PROFILE_MAP[name];
      await ensurePageSpace(220);
      cmds.push({
        op: "placeAsset",
        filePath: path,
        pageIndex: page,
        x: M.left,
        y,
        width: 120,
        height: 120,
      });
      const bio = t;
      cmds.push({
        op: "createTextFrame",
        pageIndex: page,
        x: M.left + 136,
        y,
        width: CW - 136,
        height: 120,
        text: bio,
        style: "Perfil/Bio",
      });
      y += 140;
      continue;
    }

    // Regular figures from docx
    if (b.images?.length) {
      const img = b.images[0];
      const disk = img.disk || `${ROOT}/links/docx-media/${img.file}`;
      await ensurePageSpace(260);
      cmds.push({
        op: "placeAsset",
        filePath: disk,
        pageIndex: page,
        x: M.left,
        y,
        width: CW,
        height: 200,
      });
      y += 208;
      if (b.credit) {
        cmds.push({
          op: "createTextFrame",
          pageIndex: page,
          x: M.left,
          y,
          width: CW,
          height: 20,
          text: b.credit,
          style: "Credito",
        });
        y += 28;
      }
      continue;
    }

    if (!t) continue;

    const style = styleFor(b);
    const isHead = style !== "Corpo";
    const maxChars = isHead ? 240 : 1600;
    const pieces = chunkText(t, maxChars);
    for (const piece of pieces) {
      const h = isHead
        ? 32
        : Math.min(280, 24 + Math.ceil(piece.length / 85) * 11);
      await ensurePageSpace(h + 6);
      cmds.push({
        op: "createTextFrame",
        pageIndex: page,
        x: M.left,
        y,
        width: CW,
        height: h,
        text: piece,
        style,
      });
      y += h + (isHead ? 4 : 6);
      if (cmds.length >= 35) await flush();
    }
  }
  await flush();
  return page;
}

async function main() {
  try {
    const onlyChapters = process.argv.includes("--chapters-only");
    if (!onlyChapters) {
      for (const p of [1, 3, 4]) await paintWhiteTextOnPage(p);
      const scan = await bridge.run({
        requestId: randomUUID(),
        commands: [{ op: "scanDocument", depth: "minimal", writeUuids: true }],
      });
      const p2 = (scan.results[0].items || []).filter(
        (it) =>
          it.pageIndex === 2 &&
          it.type === "TextFrame" &&
          it.bounds &&
          it.bounds.x1 > 350,
      );
      if (p2.length) {
        await run(
          p2.map((it) => ({
            op: "setTextColor",
            target: it.uuid,
            fill: { rgb: [255, 255, 255] },
          })),
          "apresentacao-callout-white",
        );
      }

      await run(
        [
          {
            op: "createRectangle",
            pageIndex: 5,
            x: 0,
            y: 0,
            width: PW,
            height: PH,
            fill: { swatch: "Vozes/Roxo" },
          },
          {
            op: "createTextFrame",
            pageIndex: 5,
            x: M.left,
            y: PH * 0.4,
            width: CW,
            height: 60,
            text: "Organizações",
            style: "Capitulo/Titulo",
          },
        ],
        "divider-orgs",
      );
      await paintWhiteTextOnPage(5);
    }

    let cursor = 6;
    const plan = [
      { id: "australia", title: "Austrália", pageBudget: 12 },
      { id: "eua", title: "Estados Unidos", pageBudget: 12 },
      { id: "inglaterra", title: "Inglaterra", pageBudget: 14 },
      { id: "nigeria", title: "Nigéria", pageBudget: 10 },
      { id: "chile", title: "Chile", pageBudget: 12 },
    ];

    for (const c of plan) {
      const lastPage = await placeCountry({ ...c, startPage: cursor });
      cursor = Math.max(cursor + c.pageBudget, lastPage + 1);
      await run([{ op: "checkpoint", tag: `after-${c.id}` }], `checkpoint-${c.id}`);
    }

    console.log("\nChapters placed.");
  } catch (err) {
    if (err instanceof BridgeError) {
      console.error("BridgeError", err.message);
      console.error(JSON.stringify(err.details, null, 2));
    } else {
      console.error(err);
    }
    process.exit(1);
  }
}

main();
