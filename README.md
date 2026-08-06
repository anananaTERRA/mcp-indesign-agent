# MCP InDesign Agent

MCP server para editar Adobe InDesign via linguagem natural no Cursor.

```
Cursor Agent → MCP (stdio) → Bridge local → InDesign
```

Arquitetura: **Document Model em cache**, **UUIDs persistentes**, **~15–25 tools semânticas** e **operações em lote** via um único `dispatcher.jsx`. Detalhes em [`PLAN.md`](./PLAN.md).

## Status

**Fase 3 (batch + ops)** — `execute_batch` / `preview_batch`, planner (uuid | role | selection), ops geométricas/texto no dispatcher, `modelPatch` atualiza o cache.

Tools: sessão (Fase 2) + `preview_batch`, `execute_batch`, `execute_operation`, `layout_operation`.

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

Com `.indd` aberto: UUID estável + smoke `moveItem` (+20pt / −20pt).

## Fluxo do agent (recomendado)

```
1. ping_indesign
2. scan_document              → cache + snapshot before
3. preview_batch (opcional)   → dry-run no model
4. execute_batch              → um round-trip; modelPatch no cache
5. summarize_changes
```

Geometria em **points**. Targets: `uuid` | `{ uuid }` | `{ role, pageIndex? }` | `{ selection: true }`.

Ops de batch: `move`, `resize`, `delete`, `duplicate`, `setText`, `replaceText`, `setFont`, `setFill`, `align`, `distribute`, `center`, `stack`, `applyMargins`.

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
