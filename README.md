# MCP InDesign Agent

MCP server para editar Adobe InDesign via linguagem natural no Cursor.

```
Cursor Agent → MCP (stdio) → Bridge local → InDesign
```

Arquitetura: **Document Model em cache**, **UUIDs persistentes**, **~15–25 tools semânticas** e **operações em lote** via um único `dispatcher.jsx`. Detalhes em [`PLAN.md`](./PLAN.md).

## Status

**Fase 4 (styles + assets)** — paragraph/character/object styles + links (list/relink/embed/check missing), com `modelPatch` no cache.

Tools: sessão + batch/layout (Fases 2–3) + `list_styles`, `apply_style`, `create_style`, `update_style`, `list_assets`, `check_missing_links`, `relink_asset`, `replace_asset`, `embed_asset`.

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

Com `.indd` aberto: UUID estável + smoke `moveItem` + `applyStyle` + links.

## Fluxo do agent (recomendado)

```
1. ping_indesign
2. scan_document              → cache + snapshot before
3. list_styles / list_assets  → do cache (refresh se precisar)
4. preview_batch (opcional)   → dry-run no model
5. execute_batch              → um round-trip; modelPatch no cache
6. summarize_changes
```

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
