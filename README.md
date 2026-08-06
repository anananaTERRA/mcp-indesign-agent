# MCP InDesign Agent

MCP server para editar Adobe InDesign via linguagem natural no Cursor.

```
Cursor Agent → MCP (stdio) → Bridge local → InDesign
```

Arquitetura: **Document Model em cache**, **UUIDs persistentes**, **~15–25 tools semânticas** e **operações em lote** via um único `dispatcher.jsx`. Detalhes em [`PLAN.md`](./PLAN.md).

## Status

**Fase 0 (bootstrap)** — entry MCP + `ping_indesign` stub. Bridge real na Fase 1.

## Prerequisites

- macOS
- Node.js 20+
- Adobe InDesign instalado (necessário a partir da Fase 1)

## Install & build

```bash
npm install
npm run build
```

Scripts:

| Script | Função |
| --- | --- |
| `npm run build` | Compila TypeScript → `dist/` |
| `npm start` | Sobe o MCP (`node dist/index.js`) |
| `npm run dev` | MCP via `tsx` (sem build) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run doctor` | Probe InDesign (Fase 1) |

## Connect to Cursor

Após o build, adicione ao MCP config (`~/.cursor/mcp.json` ou `.cursor/mcp.json` do projeto):

```json
{
  "mcpServers": {
    "mcp-indesign-agent": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/mcp-indesign-agent/dist/index.js"],
      "env": {
        "INDESIGN_APP_NAME": "Adobe InDesign 2025",
        "INDESIGN_BRIDGE": "applescript"
      }
    }
  }
}
```

Reinicie o Cursor (ou recarregue os MCP servers) e chame `ping_indesign`.

## Env

| Var | Default |
| --- | --- |
| `INDESIGN_APP_NAME` | detectar via `doctor` (Fase 1) |
| `INDESIGN_SCRIPT_TIMEOUT_SEC` | `300` |
| `INDESIGN_TEMP_DIR` | `tmpdir/mcp-indesign-agent` |
| `INDESIGN_BRIDGE` | `applescript` |

## License

MIT
