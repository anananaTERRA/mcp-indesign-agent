# Plano de implementação — MCP InDesign Agent (v2)

MCP server para editar Adobe InDesign via linguagem natural no Cursor.

**Objetivo:** Cursor → MCP stdio → bridge local → InDesign, com **Document Model em cache**, **UUIDs persistentes**, **tools semânticas (~15–25)** e **operações em lote** — aproveitando que InDesign é desktop com estado, não uma API HTTP stateless como o Google Slides.

**Herança do [`google-slides-agent`](../google-slides-agent):** entry MCP, Zod, `withToolError`, geometria/layout em `lib/`.  
**Ruptura deliberada:** não espelhar “1 tool = 1 chamada remota”. InDesign permite sessão, seleção e commit em batch.

**Fora deste chat:** execução (código, commits, setup) fica para sessão seguinte.

---

## 0. Princípios (2026 — Cursor + MCP + desktop)

1. **Poucas tools inteligentes** (15–25), não dezenas de micro-ops.
2. **Um dispatcher JSX permanente** — MCP só envia JSON de comandos.
3. **Document Model + session cache** — scan uma vez; mutações atualizam o cache.
4. **UUID no `label` do page item** — nunca `pageIndex:itemIndex` como identidade.
5. **Semântica antes de geometria** — `analyze_page` classifica Header/Body/Image…
6. **Styles e assets cedo** — o editorial gira em torno disso, não de overlap.
7. **Scan → plan → batch commit** — como um mini-git, não tool-ping-pong.
8. **Bridge intercambiável** (`BridgeAdapter`) — AppleScript/ExtendScript no v1; UXP depois sem reescrever tools.

---

## 1. Arquitetura alvo

```
Cursor Agent
    │
    ▼
MCP (Node/TS) ─────────────────────────────┐
    │                                       │
    ├─ SessionStore (Document Model cache)  │
    ├─ SnapshotDiff                         │
    └─ CommandPlanner                       │
    │                                       │
    ▼                                       │
BridgeAdapter.run(commands[]) ──────────────┘
    │
    ▼
dispatcher.jsx  (único script no InDesign)
    switch(command) { move | align | replaceText | … }
    │
    ▼
InDesign (doc aberto, seleção, undo stack)
```

### Fluxo feliz do agent

```
1. ping / ensure_session
2. scan_document          → Document Model no cache
3. analyze_page           → papéis semânticos (Header, Body…)
4. (opcional) get_selection
5. LLM planeja operações
6. preview_batch          → diff sem aplicar (quando possível)
7. execute_batch          → commit no InDesign + atualiza cache
8. summarize_changes      → snapshot_before vs snapshot_after
```

Isso reduz idas e vindas, melhora coerência e facilita desfazer/revisar.

---

## 2. Bridge: dispatcher único + adapter

### O que NÃO fazer

Gerar um `.jsx` novo por tool a cada chamada (escrever arquivo → osascript → engine → destruir contexto). Funciona, mas é lento e caro de manter.

### O que fazer

**Um `dispatcher.jsx` versionado no repo**, carregado/reutilizado no InDesign. O MCP envia apenas:

```json
{
  "requestId": "…",
  "commands": [
    { "op": "moveItem", "target": "uuid-…", "dx": 0, "dy": 20 },
    { "op": "applyStyle", "target": "uuid-…", "style": "Heading 1" }
  ]
}
```

O dispatcher faz `switch(op)`, executa em sequência (transação lógica) e devolve:

```json
{
  "ok": true,
  "results": […],
  "modelPatch": { "updated": […], "removed": […] }
}
```

`modelPatch` permite atualizar o cache sem rescan completo.

### Interface `BridgeAdapter`

```ts
interface BridgeAdapter {
  ping(): Promise<PingInfo>;
  run(payload: DispatcherPayload): Promise<DispatcherResult>;
}
```

| Adapter | Quando |
| --- | --- |
| `AppleScriptExtendScriptAdapter` | **v1** — macOS, `osascript` + `do script` |
| `UxpPersistentAdapter` | **v2+** — se UXP/socket local for viável |
| `WindowsComAdapter` | follow-up |

Regras do adapter AppleScript (v1):

1. InDesign **aberto** antes do `osascript`.
2. `with timeout of N seconds`.
3. AppleScript em **arquivo** (não `-e` multi-linha).
4. Paths absolutos POSIX.
5. I/O só via JSON (args in / result out).

Env:

| Var | Default |
| --- | --- |
| `INDESIGN_APP_NAME` | detectar via `doctor` |
| `INDESIGN_SCRIPT_TIMEOUT_SEC` | `300` |
| `INDESIGN_TEMP_DIR` | `tmpdir/mcp-indesign-agent` |
| `INDESIGN_BRIDGE` | `applescript` |

---

## 3. Document Model + Session Cache

### Modelo (uma leitura rica)

```
Document
  meta: { name, path, pageCount, pageSize, units }
  pages[]
  items[]          // com uuid, pageIndex, type, bounds, textPreview…
  hierarchy        // groups / parent
  layers[]
  styles: { paragraph[], character[], object[] }
  swatches[]
  fonts[]
  links[] / assets[]
  masterPages[]
  selection[]      // uuids atuais
```

### SessionStore (no processo MCP)

```
scan_document
  → bridge.run({ op: "scanDocument", depth: "full" })
  → SessionStore.set(model)
  → Snapshot.capture("before")

mutações
  → usam cache para resolver alvos (uuid / role semântico)
  → execute_batch no InDesign
  → aplicam modelPatch OU invalidam páginas tocadas
  → Snapshot.capture("after")

invalidate quando
  → usuário editou manualmente no InDesign (detectar via generation/hash)
  → tool `refresh_document`
  → patch incompleto / conflito
```

**Regra:** tools de mutação **não** relêem o documento inteiro por padrão.

---

## 4. Identidade: UUID persistente (obrigatório)

**Proibido no MVP como identidade:** `pageIndex:itemIndex`.

Quebra com group/ungroup, duplicate, paste, reorder.

### Estratégia

Na primeira vez que o scanner vê um page item:

1. Se `item.label` já é `mcp:<uuid>` → reutilizar.
2. Senão → gerar UUID, gravar em `item.label = "mcp:<uuid>"`.
3. Expor só o UUID (sem prefixo) nas tools.

Índices/bounds/texto continuam como **filtros auxiliares**, nunca como ID canônico.

---

## 5. Camada semântica

Usuários pedem “aumenta o espaço entre os títulos”, não “mova o objeto 53”.

### `analyze_page`

Classifica items da página em papéis, por exemplo:

`Header | Subtitle | Body | Caption | Image | Background | Logo | Decorative | Unknown`

Heurísticas v1 (sem ML externo):

- posição (topo/base), tamanho relativo, tipo (TextFrame vs Image)
- paragraph style name (forte sinal)
- comprimento de texto, font size
- camadas / master

O resultado grava `role` no Document Model. Tools aceitam alvo por:

```ts
target: { uuid } | { role: "Header", pageIndex: 0 } | { selection: true }
```

---

## 6. Catálogo de tools (alvo: ~20)

Poucas tools, cada uma com modos/operações. Evitar explodir em `align_left`, `align_right`, etc.

### Sessão e modelo

| Tool | Função |
| --- | --- |
| `ping_indesign` | App aberto? versão? doc ativo? |
| `scan_document` | Lê modelo completo → cache |
| `refresh_document` | Invalida/recarrega (full ou páginas) |
| `get_document_model` | Devolve resumo/cache (sem reler se fresco) |
| `get_selection` | Selection atual → uuids + sync cache |
| `analyze_page` | Papéis semânticos na página |

### Snapshots e batch (núcleo do agent)

| Tool | Função |
| --- | --- |
| `snapshot` | `mode: before \| after \| list \| diff` |
| `preview_batch` | Valida plano contra o model (dry-run no MCP; apply opcional no bridge) |
| `execute_batch` | Lista de ops → dispatcher único → patch cache |
| `summarize_changes` | Diff snapshot before/after em linguagem de agent |

### Operações (via batch ou tool fina de conveniência)

Em vez de N tools, **uma família**:

| Tool | Ops / modes |
| --- | --- |
| `execute_operation` | `move`, `resize`, `delete`, `duplicate`, `setText`, `replaceText`, `setFont`, `setFill`, `replaceColor` — **preferir** encapsular em `execute_batch` |
| `layout_operation` | `align`, `distribute`, `center`, `stack`, `applyMargins` |
| `layout_assistant` | `mode: diagnose \| fix \| preview` |

`execute_operation` / `layout_*` existem para comandos pontuais; o caminho recomendado no system prompt do agent é **sempre batch**.

### Styles (prioridade alta — antes de overlap)

| Tool | Função |
| --- | --- |
| `list_styles` | paragraph / character / object |
| `apply_style` | aplica style a target(s) |
| `create_style` | cria a partir de seleção ou spec |
| `update_style` | atualiza definição |

### Assets / links (no MVP, não “depois”)

| Tool | Função |
| --- | --- |
| `list_assets` | links, status, path, página |
| `replace_asset` / `relink_asset` | troca arquivo |
| `check_missing_links` | missing / out-of-date |
| `embed_asset` | embed quando fizer sentido |

### Fora do v0.1 (explícito)

- Criação de docs complexos from scratch / templates enterprise
- GREP styles avançados, footnotes, tables completas
- Export PDF/IDML (candidato v0.2)
- UXP adapter (v0.2+), Windows COM
- NestJS / HTTP wrapper

**Teto:** não passar de ~25 tools registradas no MCP. Novas capacidades entram como `op` no dispatcher, não como tool nova — salvo superfície semântica clara (`analyze_page`, `layout_assistant`).

---

## 7. Estrutura do repositório

```
mcp-indesign-agent/
├── PLAN.md
├── README.md
├── package.json
├── tsconfig.json
├── .gitignore
├── scripts/
│   └── probe-indesign.mts
├── extendscript/
│   └── dispatcher.jsx          # ÚNICO script de runtime no InDesign
└── src/
    ├── index.ts
    ├── session/
    │   ├── document-model.ts   # tipos do model
    │   ├── session-store.ts    # cache + invalidação
    │   ├── snapshots.ts
    │   └── semantic.ts         # analyze_page heuristics
    ├── bridge/
    │   ├── types.ts            # BridgeAdapter, DispatcherPayload
    │   ├── applescript-adapter.ts
    │   └── index.ts            # factory via INDESIGN_BRIDGE
    ├── commands/
    │   ├── schema.ts           # Zod de todas as ops
    │   ├── planner.ts          # resolve targets (uuid/role/selection)
    │   └── batch.ts            # preview + execute + patch
    ├── tools/
    │   ├── helpers.ts
    │   ├── session.ts          # ping, scan, refresh, get_model, selection
    │   ├── semantic.ts         # analyze_page
    │   ├── batch.ts            # snapshot, preview_batch, execute_batch, summarize
    │   ├── operations.ts       # execute_operation (thin)
    │   ├── layout.ts           # layout_operation + layout_assistant
    │   ├── styles.ts
    │   └── assets.ts
    └── lib/
        ├── filters.ts
        ├── geometry.ts         # points
        └── text-layout.ts
```

---

## 8. Stack e scripts

Igual ao Slides onde faz sentido: TypeScript, `@modelcontextprotocol/sdk`, Zod, `tsx`.

```json
{
  "build": "tsc",
  "start": "node dist/index.js",
  "dev": "tsx src/index.ts",
  "typecheck": "tsc --noEmit",
  "doctor": "tsx scripts/probe-indesign.mts"
}
```

Sem OAuth. Setup = InDesign aberto + `doctor` verde + MCP apontando para `dist/index.js`.

---

## 9. Fases de desenvolvimento

### Fase 0 — Bootstrap (½ dia)

- [ ] package.json, tsconfig, .gitignore
- [ ] Entry MCP com `ping_indesign` stub
- [ ] README mínimo + este PLAN
- [ ] Commit inicial

### Fase 1 — BridgeAdapter + dispatcher (1–1,5 dia) — **crítico**

- [ ] `extendscript/dispatcher.jsx` com ops: `ping`, `scanDocument` (mínimo), `noop`
- [ ] `AppleScriptExtendScriptAdapter`
- [ ] `npm run doctor` round-trip JSON real
- [ ] Detecção / config de `INDESIGN_APP_NAME`
- [ ] Erros claros: app fechado, sem doc, timeout, JSX exception

**Done:** doctor imprime versão + nome do doc ativo via dispatcher.

### Fase 2 — Document Model + UUID + cache (1,5–2 dias)

- [ ] Scan rico → SessionStore
- [ ] Gravação de `mcp:<uuid>` em labels
- [ ] `scan_document`, `refresh_document`, `get_document_model`
- [ ] `get_selection`
- [ ] Snapshots before/after + `summarize_changes` básico

**Done:** scan no Cursor; segunda chamada usa cache; items têm UUID estável após group/ungroup smoke test.

### Fase 3 — Batch + ops geométricas/texto (1,5–2 dias)

- [ ] Schema Zod de commands
- [ ] `execute_batch` / `preview_batch`
- [ ] Ops: move, resize, delete, setText, replaceText, setFont, setFill
- [ ] `layout_operation` (align / distribute / center / stack)
- [ ] Planner resolve `target` por uuid | role | selection
- [ ] modelPatch atualiza cache

**Done:** “mova o título 20pt” via role ou selection, em **um** batch, sem rescan.

### Fase 4 — Styles + Assets (1,5 dia) — **antes de overlap**

- [ ] `list_styles`, `apply_style`, `create_style`, `update_style`
- [ ] `list_assets`, `relink_asset` / `replace_asset`, `check_missing_links`, `embed_asset`

**Done:** aplicar paragraph style por comando natural; listar e relinkar imagem missing.

### Fase 5 — Semântica + layout assistant (1,5–2 dias)

- [ ] `analyze_page` + roles no model
- [ ] `layout_assistant` modes: diagnose | fix | preview
- [ ] Portar heurísticas de overlap/stack de `lib/text-layout` (pts, não EMU)
- [ ] Exemplos de fluxo agent: scan → analyze → batch → summarize

**Done:** “aumenta o espaço entre os títulos” resolve via roles + layout_assistant/batch.

### Fase 6 — Polimento (½–1 dia)

- [ ] README (Automation macOS, app name, Cursor mcp.json)
- [ ] System/tool descriptions orientando o agent ao fluxo scan→batch
- [ ] Teto de tools documentado; ops novas só no dispatcher
- [ ] Tag v0.1.0

---

## 10. Configuração Cursor (alvo)

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

Pré-reqs: macOS, InDesign aberto com `.indd`, Node 20+, permissão Automation se o SO pedir.

---

## 11. Riscos e mitigações

| Risco | Mitigação |
| --- | --- |
| Cache stale (edição manual no InDesign) | hash/generation no scan; `refresh_document`; patch conservador |
| Label UUID sobrescrito por usuário/script | namespace `mcp:`; re-bind por geometria+texto se label sumir |
| Dispatcher JSX cresce demais | modularizar com `#include` ou concatenação no build do dispatcher |
| AppleScript lento | batch (1 round-trip N ops); depois UXP adapter |
| LLM chama micro-tools demais | descrições + README empurram `execute_batch`; micro-tools thin |
| Nome do app por versão | `doctor` + env |
| ExtendScript ES3 | dispatcher em sintaxe antiga; lógica moderna só no TS |

---

## 12. Critérios de sucesso v0.1

1. `ping` + `scan_document` no Cursor com UUIDs persistentes.
2. `get_selection` + `analyze_page` permitem falar em “esse título” / “Header”.
3. Styles e assets usáveis sem rescan a cada passo.
4. Um pedido editorial típico resolve com **≤ 3 round-trips MCP** (scan → batch → summarize).
5. Diff de snapshot explica o que mudou.
6. ≤ ~25 tools; novas capacidades entram como `op` no dispatcher.
7. Outro dev sobe o MCP em < 15 min (com InDesign instalado).

---

## 13. Ordem no próximo chat

1. Confirmar versão InDesign → `INDESIGN_APP_NAME`.
2. Fase 0 + **Fase 1 (dispatcher)** até doctor verde.
3. Fase 2 (model + UUID + cache) antes de qualquer mutação.
4. Fase 3 (batch) — não adicionar dezenas de tools soltas.
5. Fase 4 (styles + assets) **antes** de overlap/fix.
6. Fase 5 (semântica + layout_assistant).
7. Só então polir docs / tag.

**Não pular:** dispatcher único e UUID. Sem isso, o resto herda a arquitetura “API Slides” que queremos deixar para trás.

---

## 14. Comparativo com o plano v1

| Tema | v1 (Slides-like) | v2 (este plano) |
| --- | --- | --- |
| Scripts | 1 JSX por tool | 1 dispatcher permanente |
| Tools | ~20 micro-ops 1:1 | ~20 tools inteligentes + muitas `op`s |
| Estado | Stateless por chamada | Session cache + Document Model |
| IDs | `page:index` MVP | UUID em `label` desde o dia 1 |
| Semântica | Ausente | `analyze_page` + roles |
| Styles / assets | Adiados | MVP (Fase 4, antes de overlap) |
| Layout | diagnose + fix separados | `layout_assistant` com modes |
| Agent loop | tool → tool → tool | scan → plan → batch → summarize |
| Bridge | osascript fixo | `BridgeAdapter` intercambiável |

---

## 15. Avaliação do rumo (pós-benchmark)

| Dimensão | Meta |
| --- | --- |
| Arquitetura geral | Manter o alto nível do v1, com estado desktop |
| Escalabilidade | Ops no dispatcher, não novas tools |
| Performance | Batch + cache; 1 round-trip por commit |
| Integração Cursor Agent 2026 | Fluxo scan/plan/batch alinhado a agents |

---

*Documento vivo: ao executar, marcar checkboxes e registrar decisões (ex.: formato exato do `modelPatch`, heurísticas de `analyze_page`) neste arquivo.*
