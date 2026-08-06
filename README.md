# MCP InDesign Agent

MCP server para editar Adobe InDesign via linguagem natural no Cursor.

```
Cursor Agent → MCP (stdio) → Bridge local → InDesign
```

Arquitetura: **Document Model em cache**, **UUIDs persistentes**, **~15–25 tools semânticas** e **operações em lote** via um único `dispatcher.jsx`. Detalhes em [`PLAN.md`](./PLAN.md).

## Status

**Fase 5 (semântica + layout assistant)** — `analyze_page` grava roles no model; `layout_assistant` (diagnose | preview | fix) porta heurísticas de overlap/stack em points.

Tools: sessão + batch/layout/styles/assets + `analyze_page` + `layout_assistant`.

## Prerequisites

- macOS
- Node.js 20+
- Adobe InDesign instalado e **aberto**
- Documento `.indd` aberto para scan / batch

## Install & build

```bash
npm install
npm run build
```

## Doctor (round-trip)

```bash
npm run doctor
INDESIGN_APP_NAME="Adobe InDesign 2026" npm run doctor
```

Com `.indd` aberto: UUID estável + smoke move/styles/assets + `analyze_page` + diagnose.

## Fluxo do agent (recomendado)

```
1. ping_indesign
2. scan_document              → cache + snapshot before
3. analyze_page               → roles (Header, Body, Image…)
4. layout_assistant diagnose  → overlaps / margens (opcional)
5. preview_batch | layout_assistant preview
6. execute_batch | layout_assistant fix
7. summarize_changes
```

Exemplo editorial: “aumenta o espaço entre os títulos”

```
scan_document → analyze_page(pageIndex=0)
→ execute_batch([{ op: "stack", target: { role: "Header", pageIndex: 0 }, gapPt: 24 }])
→ summarize_changes
```

Ou com overlap: `layout_assistant` mode=`preview`/`fix` (minGapPt em points).

Geometria em **points**. Targets: `uuid` | `{ uuid }` | `{ role, pageIndex? }` | `{ selection: true }`.

Ops de batch: `move`, `resize`, `delete`, `duplicate`, `setText`, `replaceText`, `setFont`, `setFill`, `align`, `distribute`, `center`, `stack`, `applyMargins`, `applyStyle`, `createStyle`, `updateStyle`, `relinkAsset`, `replaceAsset`, `embedAsset`.

## Connect to Cursor

```json
{
  "mcpServers": {
    "mcp-indesign-agent": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/mcp-indesign-agent/dist/index.js"],
      "env": {
        "INDESIGN_APP_NAME": "Adobe InDesign 2026",
        "INDESIGN_BRIDGE": "applescript"
      }
    }
  }
}
```

## Env

| Var | Default |
| --- | --- |
| `INDESIGN_APP_NAME` | auto (maior ano em `/Applications`) |
| `INDESIGN_SCRIPT_TIMEOUT_SEC` | `300` |
| `INDESIGN_TEMP_DIR` | `tmpdir/mcp-indesign-agent` |
| `INDESIGN_BRIDGE` | `applescript` |

## License

MIT
