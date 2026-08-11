# MCP InDesign Agent

MCP server para editar Adobe InDesign via linguagem natural no Cursor.

```
Cursor Agent → MCP (stdio) → Bridge local (AppleScript + dispatcher.jsx) → InDesign
```

**v0.1.0** — Document Model em cache, UUIDs persistentes (`mcp:<uuid>`), ~22 tools semânticas e operações em lote. Plano: [`PLAN.md`](./PLAN.md).

## Prerequisites

- **macOS** (bridge v1 = AppleScript + ExtendScript)
- **Node.js 20+**
- **Adobe InDesign** instalado e **aberto**, com um `.indd` ativo para scan/batch
- Permissão de **Automação** (veja abaixo)

## macOS Automation

Na primeira chamada (`npm run doctor` ou o MCP no Cursor), o macOS pode pedir permissão para controlar o InDesign.

1. **System Settings → Privacy & Security → Automation**
2. Garanta que o app que lança o MCP (Cursor, Terminal, etc.) pode controlar **Adobe InDesign**
3. Se o bridge falhar com timeout / Apple Event errors: reabra o InDesign, confirme o nome do app com `npm run doctor`, e aceite o diálogo de Automação de novo

O script não usa UI scripting frágil: envia JSON ao `extendscript/dispatcher.jsx` via `do script`.

## Install & build

```bash
npm install
npm run build
npm run doctor
```

`doctor` imprime apps detectados, versão, doc ativo e smoke de UUID / batch / styles / analyze.

Defina o nome do app se a detecção automática não bater:

```bash
INDESIGN_APP_NAME="Adobe InDesign 2026" npm run doctor
```

Nomes típicos: `Adobe InDesign 2026`, `Adobe InDesign 2025` (veja `/Applications`).

## Connect to Cursor

1. `npm run build`
2. Adicione em `~/.cursor/mcp.json` (ou `.cursor/mcp.json` do projeto):

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

3. Substitua o path absoluto e o `INDESIGN_APP_NAME` pelo resultado do `doctor`
4. Recarregue os MCP servers no Cursor
5. Teste: *“Ping InDesign e faça scan do documento ativo”*

## Fluxo do agent (obrigatório na prática)

```
ping_indesign
  → scan_document                 # cache + snapshot before
  → analyze_page                  # roles (Header, Body…)
  → preview_batch | layout_assistant (opcional)
  → checkpoint                    # cópia .indd em disco (automática, ver abaixo)
  → execute_batch | layout_assistant fix
  → summarize_changes
```

Meta: pedido editorial típico em **≤ 3 round-trips** MCP (scan → batch → summarize).

### Checkpoint: a rede que o `snapshot` não é

Em 11/08/2026, 18 scripts de patch ad-hoc em ~20 minutos destruíram a p.8 de um
livro em produção. Não havia como voltar: `snapshot` guarda só `bounds`,
`paragraphStyle` e um `textPreview` truncado, e **não tem restore**; nenhum
script usava transação, então cada um virava várias entradas de undo.

O servidor agora recusa mutação sem rede:

- **`op: "checkpoint"`** — `doc.saveACopy()` para `<pasta do .indd>/_checkpoints/`
  com nome `<base>-<tag>-<YYYYMMDD-HHMMSS>.indd`, mantendo os `keep` mais
  recentes (default 12). Disponível em `execute_operation` e como comando de
  `execute_batch`. Roda **antes e fora** da transação — a cópia precisa
  sobreviver ao rollback que ela existe para permitir.
- **Gate no `execute_batch`** — todo batch mutante exige um checkpoint da
  *geração* atual do documento (`meta.generation`). Por default o servidor tira
  a cópia sozinho (`INDESIGN_CHECKPOINT_MODE=auto`) e **recusa o batch** se o
  `saveACopy` falhar. `skipCheckpoint: true` é a saída deliberada.
- **Uma transação por pedido** — todo batch mutante roda dentro de
  `app.doScript(…, UndoModes.ENTIRE_SCRIPT, "<nome>")`. Um Cmd+Z desfaz o pedido
  inteiro e uma exceção no meio reverte tudo. O nome do undo é forçado a ASCII.

Criar/apagar frames muda a geração e invalida o checkpoint anterior; editar
texto não muda, então uma cópia cobre uma sequência de edições de texto.

Exemplos:

| Pedido | Sequência |
| --- | --- |
| “Aumenta o espaço entre os títulos” | `scan` → `analyze_page` → `execute_batch` com `stack` em `{role:"Header"}` → `summarize_changes` |
| “Textos sobrepostos” | `scan` → `layout_assistant` diagnose → preview → fix |
| “Aplica Heading 1 no título” | `scan` → `analyze_page` → `apply_style` / batch `applyStyle` |
| “Relinka a imagem missing” | `scan` → `check_missing_links` → `relink_asset` |

**Targets:** `uuid` \| `{ uuid }` \| `{ role, pageIndex? }` \| `{ selection: true }`.  
**Nunca** use `pageIndex:itemIndex` como identidade. Geometria em **points**.

## Tools (teto ~25)

Novas capacidades entram como **`op` no dispatcher + comando de batch**, não como tool MCP nova — salvo superfície semântica clara (`analyze_page`, `layout_assistant`).

| Grupo | Tools |
| --- | --- |
| Sessão | `ping_indesign`, `scan_document`, `refresh_document`, `get_document_model`, `get_selection` |
| Semântica | `analyze_page` |
| Batch / snapshots | `snapshot`, `preview_batch`, `execute_batch`, `summarize_changes` |
| Conveniência (thin) | `execute_operation`, `layout_operation` |
| Layout assist | `layout_assistant` (`diagnose` \| `preview` \| `fix`) |
| Styles | `list_styles`, `apply_style`, `create_style`, `update_style` |
| Assets | `list_assets`, `check_missing_links`, `relink_asset`, `replace_asset`, `embed_asset` |

**Preferir sempre `execute_batch`** para mutações multi-passo. Thin tools existem para 1 op.

### Ops de `execute_batch`

`checkpoint`, `move`, `resize`, `delete`, `duplicate`, `createTextFrame`, `setText`, `replaceText`, `setFont`, `setFill`, `align`, `distribute`, `center`, `stack`, `applyMargins`, `applyStyle`, `createStyle`, `updateStyle`, `relinkAsset`, `replaceAsset`, `embedAsset`.

`checkpoint` é a única que não muta o documento.

## Env

| Var | Default |
| --- | --- |
| `INDESIGN_APP_NAME` | auto (maior ano em `/Applications`) |
| `INDESIGN_SCRIPT_TIMEOUT_SEC` | `300` |
| `INDESIGN_TEMP_DIR` | `tmpdir/mcp-indesign-agent` |
| `INDESIGN_BRIDGE` | `applescript` |
| `INDESIGN_CHECKPOINT_MODE` | `auto` (`require` = só recusa, nunca salva sozinho; `off` = sem gate) |
| `INDESIGN_CHECKPOINT_KEEP` | `12` |
| `INDESIGN_CHECKPOINT_MAX_AGE_MIN` | `120` (`0` desliga a expiração) |

## Scripts

| Script | Uso |
| --- | --- |
| `npm run build` | Compila `dist/` |
| `npm start` | Sobe o MCP (`node dist/index.js`) |
| `npm run dev` | MCP via `tsx` (dev) |
| `npm run doctor` | Probe bridge + smoke |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Gate de checkpoint + transação (`node --test`, sem InDesign) |

## Layout do repo

```
extendscript/dispatcher.jsx   # Único script de runtime no InDesign
src/
  index.ts                    # Entry MCP + agent instructions
  agent-instructions.ts       # Orientação scan→batch para o client
  bridge/                     # BridgeAdapter (AppleScript v1)
  session/                    # Document Model, cache, snapshots, checkpoints, semantic
  commands/                   # Zod schema, planner, batch, checkpoint gate, mutations
  tools/                      # Tools MCP registradas
  lib/                        # geometry + text-layout (pts) + layout-assistant + ascii
tests/                        # Gate + transação (fake bridge, não abre o InDesign)
```

## License

MIT
