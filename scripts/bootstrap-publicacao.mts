#!/usr/bin/env node
/**
 * Bootstrap the new Vozes publication .indd (create doc + swatches + styles + masters).
 * Uses the local bridge + dispatcher.jsx directly (does not need Cursor MCP restart).
 */
import { randomUUID } from "node:crypto";
import { createBridge, BridgeError } from "../src/bridge/index.ts";

const INDD =
  "/Users/anaterra/Documents/Mapeamento-Organizacoes-Lemann-Vozes/03_Publicacao/indd/Mapeamento-Organizacoes-Vozes-2026.indd";

const SWATCHES: Array<{ name: string; rgb: [number, number, number] }> = [
  { name: "Vozes/Roxo", rgb: [73, 57, 117] },
  { name: "Vozes/Verde", rgb: [13, 99, 83] },
  { name: "Vozes/Rosa", rgb: [239, 92, 161] },
  { name: "Vozes/Azul", rgb: [17, 87, 243] },
  { name: "Vozes/VerdeVivo", rgb: [1, 198, 137] },
  { name: "Vozes/Lima", rgb: [208, 231, 112] },
  { name: "Vozes/Lilas", rgb: [156, 167, 239] },
  { name: "Vozes/Laranja", rgb: [255, 131, 39] },
  { name: "Vozes/AzulEscuro", rgb: [21, 55, 146] },
  { name: "Vozes/Roxo2", rgb: [129, 70, 203] },
  { name: "Vozes/Marfim", rgb: [243, 238, 230] },
  { name: "Vozes/Preto", rgb: [20, 20, 20] },
];

type StyleDef = {
  name: string;
  styleKind?: "paragraph" | "character" | "object";
  basedOn?: string;
  spec?: {
    fontFamily?: string;
    fontStyle?: string;
    fontSizePt?: number;
    leadingPt?: number;
    spaceBeforePt?: number;
    spaceAfterPt?: number;
  };
};

const PARA_STYLES: StyleDef[] = [
  {
    name: "00 Base",
    spec: {
      fontFamily: "Mulish",
      fontStyle: "Regular",
      fontSizePt: 10,
      leadingPt: 12,
      spaceAfterPt: 8,
    },
  },
  {
    name: "Corpo",
    basedOn: "00 Base",
    spec: { fontFamily: "Mulish", fontStyle: "Regular", fontSizePt: 10, leadingPt: 12, spaceAfterPt: 8 },
  },
  {
    name: "Corpo/Lead",
    basedOn: "Corpo",
    spec: { fontFamily: "Mulish", fontStyle: "SemiBold", fontSizePt: 11, leadingPt: 14, spaceAfterPt: 10 },
  },
  {
    name: "Capa/Titulo",
    spec: { fontFamily: "Roboto Slab", fontStyle: "Bold", fontSizePt: 36, leadingPt: 42, spaceAfterPt: 12 },
  },
  {
    name: "Capa/Ano",
    spec: { fontFamily: "Mulish", fontStyle: "Medium", fontSizePt: 12, leadingPt: 14, spaceAfterPt: 0 },
  },
  {
    name: "Sumario/Num",
    spec: { fontFamily: "Mulish", fontStyle: "Medium", fontSizePt: 11, leadingPt: 14, spaceAfterPt: 2 },
  },
  {
    name: "Sumario/Item",
    spec: { fontFamily: "Mulish", fontStyle: "Bold", fontSizePt: 14, leadingPt: 18, spaceAfterPt: 4 },
  },
  {
    name: "Sumario/Desc",
    spec: { fontFamily: "Mulish", fontStyle: "Regular", fontSizePt: 9, leadingPt: 12, spaceAfterPt: 14 },
  },
  {
    name: "Capitulo/Titulo",
    spec: { fontFamily: "Roboto Slab", fontStyle: "Bold", fontSizePt: 28, leadingPt: 32, spaceAfterPt: 16 },
  },
  {
    name: "Secao/Titulo",
    spec: { fontFamily: "Roboto Slab", fontStyle: "SemiBold", fontSizePt: 16, leadingPt: 20, spaceBeforePt: 14, spaceAfterPt: 8 },
  },
  {
    name: "Subsecao/Titulo",
    spec: { fontFamily: "Mulish", fontStyle: "Bold", fontSizePt: 12, leadingPt: 15, spaceBeforePt: 10, spaceAfterPt: 6 },
  },
  {
    name: "Lista/Marcador",
    basedOn: "Corpo",
    spec: { fontFamily: "Mulish", fontStyle: "Regular", fontSizePt: 10, leadingPt: 12, spaceAfterPt: 4 },
  },
  {
    name: "Lista/Numero",
    basedOn: "Corpo",
    spec: { fontFamily: "Mulish", fontStyle: "Regular", fontSizePt: 10, leadingPt: 12, spaceAfterPt: 4 },
  },
  {
    name: "Citacao",
    spec: { fontFamily: "Mulish", fontStyle: "Italic", fontSizePt: 11, leadingPt: 15, spaceBeforePt: 10, spaceAfterPt: 10 },
  },
  {
    name: "Callout/Titulo",
    spec: { fontFamily: "Roboto Slab", fontStyle: "Bold", fontSizePt: 14, leadingPt: 18, spaceAfterPt: 6 },
  },
  {
    name: "Callout/Texto",
    spec: { fontFamily: "Mulish", fontStyle: "Regular", fontSizePt: 9.5, leadingPt: 12, spaceAfterPt: 6 },
  },
  {
    name: "Achado/Numero",
    spec: { fontFamily: "Roboto Slab", fontStyle: "Bold", fontSizePt: 22, leadingPt: 26, spaceAfterPt: 4 },
  },
  {
    name: "Achado/Titulo",
    spec: { fontFamily: "Mulish", fontStyle: "Bold", fontSizePt: 12, leadingPt: 15, spaceAfterPt: 6 },
  },
  {
    name: "Perfil/Nome",
    spec: { fontFamily: "Mulish", fontStyle: "Bold", fontSizePt: 12, leadingPt: 14, spaceAfterPt: 2 },
  },
  {
    name: "Perfil/Cargo",
    spec: { fontFamily: "Mulish", fontStyle: "Medium", fontSizePt: 9, leadingPt: 12, spaceAfterPt: 6 },
  },
  {
    name: "Perfil/Bio",
    spec: { fontFamily: "Mulish", fontStyle: "Regular", fontSizePt: 9, leadingPt: 12, spaceAfterPt: 6 },
  },
  {
    name: "Tabela/Cabecalho",
    spec: { fontFamily: "Mulish", fontStyle: "Bold", fontSizePt: 8.5, leadingPt: 11, spaceAfterPt: 2 },
  },
  {
    name: "Tabela/Celula",
    spec: { fontFamily: "Mulish", fontStyle: "Regular", fontSizePt: 8.5, leadingPt: 11, spaceAfterPt: 2 },
  },
  {
    name: "Timeline/Ano",
    spec: { fontFamily: "Mulish", fontStyle: "Bold", fontSizePt: 10, leadingPt: 12, spaceAfterPt: 2 },
  },
  {
    name: "Timeline/Marco",
    spec: { fontFamily: "Mulish", fontStyle: "Regular", fontSizePt: 9, leadingPt: 12, spaceAfterPt: 6 },
  },
  {
    name: "Legenda",
    spec: { fontFamily: "Mulish", fontStyle: "Italic", fontSizePt: 8, leadingPt: 10, spaceBeforePt: 4, spaceAfterPt: 2 },
  },
  {
    name: "Credito",
    spec: { fontFamily: "Mulish", fontStyle: "Regular", fontSizePt: 7.5, leadingPt: 9, spaceAfterPt: 8 },
  },
  {
    name: "Folio",
    spec: { fontFamily: "Mulish", fontStyle: "Medium", fontSizePt: 8, leadingPt: 10, spaceAfterPt: 0 },
  },
  {
    name: "CabecalhoCorrente",
    spec: { fontFamily: "Mulish", fontStyle: "Medium", fontSizePt: 8, leadingPt: 10, spaceAfterPt: 0 },
  },
];

const CHAR_STYLES: StyleDef[] = [
  { name: "Negrito", styleKind: "character", spec: { fontFamily: "Mulish", fontStyle: "Bold" } },
  { name: "Italico", styleKind: "character", spec: { fontFamily: "Mulish", fontStyle: "Italic" } },
  { name: "Sigla", styleKind: "character", spec: { fontFamily: "Mulish", fontStyle: "SemiBold" } },
];

async function run(bridge: ReturnType<typeof createBridge>, commands: Array<Record<string, unknown>>, label: string) {
  console.log(`\n→ ${label} (${commands.length} ops)`);
  const result = await bridge.run({
    requestId: randomUUID(),
    commands,
    transactionName: label.slice(0, 100),
  });
  if (!result.ok) {
    console.error(JSON.stringify(result, null, 2));
    throw new Error(`Batch failed: ${label}`);
  }
  console.log(JSON.stringify(result.results?.slice?.(0, 3) ?? result.results, null, 2));
  return result;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  const bridge = createBridge();

  await run(
    bridge,
    [
      {
        op: "createDocument",
        filePath: INDD,
        widthPt: 595.276,
        heightPt: 841.89,
        pageCount: 52,
        facingPages: false,
        bleedPt: 0,
      },
    ],
    "createDocument",
  );

  // Checkpoint path exists after save — subsequent mutations need scan via session
  // but bridge.run bypasses session; dispatcher still needs active doc (just created).

  for (const group of chunk(SWATCHES, 20)) {
    await run(
      bridge,
      group.map((s) => ({ op: "ensureSwatch", name: s.name, rgb: s.rgb })),
      "ensureSwatch",
    );
  }

  for (const group of chunk(PARA_STYLES, 20)) {
    await run(
      bridge,
      group.map((s) => ({
        op: "createStyle",
        name: s.name,
        styleKind: "paragraph",
        basedOn: s.basedOn,
        spec: s.spec,
      })),
      "createStyle paragraph",
    );
  }

  await run(
    bridge,
    CHAR_STYLES.map((s) => ({
      op: "createStyle",
      name: s.name,
      styleKind: "character",
      spec: s.spec,
    })),
    "createStyle character",
  );

  await run(
    bridge,
    [
      { op: "createStyle", name: "Box/Callout", styleKind: "object" },
      { op: "createStyle", name: "Box/Pais", styleKind: "object" },
      { op: "createStyle", name: "Card/Perfil", styleKind: "object" },
      { op: "createStyle", name: "Figura", styleKind: "object" },
    ],
    "createStyle object",
  );

  await run(
    bridge,
    [
      { op: "ensureMaster", name: "A-Corpo" },
      { op: "ensureMaster", name: "B-Abertura" },
      { op: "ensureMaster", name: "C-Capa" },
      { op: "assignMaster", masterName: "C-Capa", pageIndex: 0 },
      { op: "assignMaster", masterName: "A-Corpo", pageIndexes: Array.from({ length: 51 }, (_, i) => i + 1) },
    ],
    "masters",
  );

  // Soft background on capa via rectangle
  await run(
    bridge,
    [
      {
        op: "createRectangle",
        pageIndex: 0,
        x: 0,
        y: 0,
        width: 595.276,
        height: 841.89,
        fill: { swatch: "Vozes/Marfim" },
      },
    ],
    "capa background",
  );

  console.log("\nBootstrap OK:", INDD);
}

main().catch((err) => {
  if (err instanceof BridgeError) {
    console.error("BridgeError", err.code, err.message, err.details);
  } else {
    console.error(err);
  }
  process.exit(1);
});
