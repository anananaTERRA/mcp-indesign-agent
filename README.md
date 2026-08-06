# MCP InDesign Agent

MCP server para editar Adobe InDesign via linguagem natural no Cursor.

```
Cursor Agent → MCP (stdio) → Bridge local → InDesign
```

Arquitetura: **Document Model em cache**, **UUIDs persistentes**, **~15–25 tools semânticas** e **operações em lote** via um único `dispatcher.jsx`. Detalhes em [`PLAN.md`](./PLAN.md).

## Status

**Fase 2 (Document Model + UUID + cache)** — scan rico grava `mcp:<uuid>` nos labels; `SessionStore` em processo; tools de sessão + snapshots.

Tools: `ping_indesign`, `scan_document`, `refresh_document`, `get_document_model`, `get_selection`, `snapshot`, `summarize_changes`.

## Prerequisites

- macOS
- Node.js 20+
- Adobe InDesign instalado e **aberto** (Automation/acessibilidade se o macOS pedir)
- Documento `.indd` aberto para exercitar `scan_document`

## Install & build

```bash
npm install
npm run build
```

## Doctor (round-trip)

Com o InDesign aberto (idealmente com um `.indd`):

```bash
npm run doctor
# ou force a versão:
INDESIGN_APP_NAME="Adobe InDesign 2026" npm run doctor
```

Esperado: versão do app, scan com UUIDs estáveis na 2ª chamada, e `getSelection`.

Scripts:

| Script | Função |
| --- | --- |
| `npm run build` | Compila TypeScript → `dist/` |
| `npm start` | Sobe o MCP (`node dist/index.js`) |
| `npm run dev` | MCP via `tsx` (sem build) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run doctor` | Probe InDesign (ping / scan / UUID / selection) |

## Fluxo do agent (Fase 2)

```
1. ping_indesign
2. scan_document          → Document Model no cache (+ snapshot before)
3. get_document_model     → usa cache (sem reler)
4. get_selection          → uuids da seleção
5. … edições (Fase 3+) …
6. refresh_document / snapshot after
7. summarize_changes
```

## Connect to Cursor

Após o build, adicione ao MCP config (`~/.cursor/mcp.json` ou `.cursor/mcp.json` do projeto):

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

Reinicie o Cursor (ou recarregue os MCP servers) e chame `ping_indesign` → `scan_document`.

## Env

| Var | Default |
| --- | --- |
| `INDESIGN_APP_NAME` | auto (maior ano em `/Applications`) |
| `INDESIGN_SCRIPT_TIMEOUT_SEC` | `300` |
| `INDESIGN_TEMP_DIR` | `tmpdir/mcp-indesign-agent` |
| `INDESIGN_BRIDGE` | `applescript` |

## License

MIT
