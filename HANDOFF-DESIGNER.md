# Handoff — MCP InDesign (para designers)

**Versão:** v0.1.0  
**Para quem:** quem vai editar documentos InDesign conversando com o Cursor (em português ou inglês).  
**Nesta máquina:** a ferramenta já está instalada e ligada ao Adobe InDesign 2026.

---

## Em uma frase

Você abre o **InDesign** com o arquivo, abre o **Cursor**, e pede mudanças em linguagem natural — o assistente lê o documento, planeja e aplica as alterações direto no `.indd` aberto.

Não precisa escrever código. Não precisa saber o nome das “tools”. Basta descrever o resultado desejado com clareza.

---

## Antes de começar (checklist rápido)

1. **Adobe InDesign aberto** (nesta máquina: 2026).
2. O **documento `.indd` que você quer editar** aberto e em primeiro plano (documento ativo).
3. **Cursor** aberto; o servidor MCP `mcp-indesign-agent` deve aparecer ligado (Settings → MCP). Se estiver vermelho/desligado: Reload MCP ou reinicie o Cursor.
4. Na **primeira vez**, o macOS pode pedir permissão de Automação (Cursor controlando o InDesign). Aceite. Se falhar depois: *System Settings → Privacy & Security → Automation*.

Se algo não responder: feche e reabra o InDesign com o arquivo, confirme que é o documento certo, e peça de novo: *“Ping no InDesign e diga se tem documento aberto”*.

---

## Como conversar com o assistente

### O que funciona bem

- Pedidos **concretos** e **visuais**: “aumenta o espaço entre os títulos da página 1”, “alinha tudo ao centro”, “aplica o estilo Heading 1 no título”.
- Falar do **que está selecionado** no InDesign: selecione no app e diga “move a seleção 20 pontos para baixo”.
- Falar por **papéis** depois que ele “analisar a página”: título, subtítulo, corpo, legenda, imagem, etc.
- Pedir **várias mudanças de uma vez**: “troca o texto do título, aplica estilo X e aumenta o gap entre os blocos”.

### O que evita confusão

- Deixe claro **qual página** (página 1 = primeira; se preferir, diga “primeira página” / “página 2”).
- Se você **editou na mão** no InDesign no meio do chat, diga: *“Atualiza o que você sabe do documento”* (ele precisa reler).
- Prefira **um documento por sessão** de trabalho. Se trocar de arquivo, peça um novo scan.

### Frases de partida úteis

- “Confere se o InDesign está conectado e faz um scan do documento ativo.”
- “Analisa a página 1 e me diz o que é título, corpo e imagem.”
- “Resume o que mudou depois das últimas edições.”

---

## O que você pode pedir (cobertura completa)

### 1. Conexão e visão do documento

| Você pode pedir… | O que acontece |
| --- | --- |
| Verificar se o InDesign responde | Confirma app, versão e nome do arquivo aberto |
| “Lê / escaneia o documento” | Mapeia páginas, caixas de texto, imagens, estilos, links |
| “O que tem na seleção?” | Usa o que está selecionado **agora** no InDesign |
| “Mostra um resumo do documento” | Páginas, quantidade de itens, estilos, links |
| “Atualiza / refresca” | Relê o arquivo depois de edições manuais |

### 2. Entender a página (papéis semânticos)

Depois de um scan, você pode pedir para **analisar a página**. O assistente classifica os objetos, por exemplo:

- **Header** — título / manchete  
- **Subtitle** — subtítulo  
- **Body** — texto corrido  
- **Caption** — legenda  
- **Image** — imagem / gráfico  
- **Background** — fundo grande  
- **Logo** — marca pequena  
- **Decorative** — linhas, detalhes  
- **Unknown** — não ficou claro  

Isso permite falar assim: *“Aumenta o espaço entre os Headers da página 1”* em vez de apontar objeto por objeto.

A classificação é **heurística** (posição, tamanho, estilo de parágrafo, tamanho de fonte). Se errar, corrija na conversa: *“Esse não é título, é legenda — trata como Caption”* ou selecione o objeto certo no InDesign.

### 3. Texto

- Trocar o texto inteiro de uma caixa  
- Localizar e substituir trechos  
- Mudar fonte, estilo da fonte, tamanho (em pontos)  
- **Criar um novo parágrafo / text frame** (não precisa duplicar outro)  
- Trabalhar na **seleção** ou no que ele identificou como título/corpo  

Exemplos:

- “Adiciona um parágrafo de corpo abaixo do título com lorem ipsum.”  
- “Troca o título da página 1 para: Relatório Anual 2026.”  
- “No corpo, troca ‘cliente’ por ‘parceiro’.”  
- “Deixa o subtítulo em 18 pt.”

### 4. Estilos do InDesign (paragraph / character / object)

- Listar estilos disponíveis no documento  
- **Aplicar** um estilo existente a um alvo (título, seleção, etc.)  
- **Criar** um estilo novo (a partir da seleção ou com especificação: família, tamanho, entrelinha, espaço antes/depois)  
- **Atualizar** a definição de um estilo (incluindo renomear)

Exemplos:

- “Quais paragraph styles existem?”  
- “Aplica Heading 1 no título da página 1.”  
- “Cria um estilo Caption 9pt a partir da seleção.”  
- “No estilo Body, aumenta o space after para 8 pt.”

### 5. Layout e geometria

Tudo em **pontos (pt)** — a unidade natural do InDesign editorial.

| Tipo de pedido | Exemplos |
| --- | --- |
| Mover | “Sobe o título 12 pt”, “move a seleção 20 pt para a direita” |
| Redimensionar | “Aumenta a altura da caixa de corpo” |
| Alinhar | esquerda / centro / direita / topo / meio / base |
| Centralizar na página | “Centraliza a imagem na página” |
| Distribuir | espaçamento igual na horizontal ou vertical |
| Empilhar com gap fixo | “Empilha os títulos com 24 pt de espaço entre eles” |
| Margens / área segura | “Puxa os elementos para dentro de 24 pt de margem” |
| Duplicar / apagar | “Duplica a seleção”, “apaga os objetos decorativos da página 2” |

### 6. Assistente de layout (sobreposição e aperto)

Quando textos estão **colados**, **sobrepostos** ou **fora da margem**:

1. *“Diagnostica o layout da página 1”* — ele aponta problemas  
2. *“Mostra o plano de correção (preview), sem aplicar”* — você revisa a intenção  
3. *“Aplica a correção”* — ele desempilha textos, ajusta gaps e, se fizer sentido, puxa para a área segura  

Útil para: “textos sobrepostos”, “títulos colados no corpo”, “caixa saindo da página”.

### 7. Imagens e links (painel Links)

- Listar assets/links do documento (caminho, status, página)  
- Checar links **missing** ou **out of date**  
- **Relinkar / substituir** o arquivo no disco  
- **Embed** (incorporar) um link no documento  

Exemplos:

- “Tem imagem missing? Lista.”  
- “Relinka a foto da capa para `/Users/…/capa.tif`.”  
- “Incorpora esse logo no arquivo.”

### 8. Revisar o que mudou

O assistente pode guardar um “antes” e um “depois” e **resumir as mudanças** (o que moveu, o que foi apagado, o que mudou de texto/bounds).

Peça: *“Resume o que mudou no documento desde o início desta edição.”*

Isso ajuda a revisar antes de salvar / enviar para produção.

### 9. Voltar atrás (o que te protege)

Duas redes existem, e uma delas **não** é o que parece:

- **“Resumo das mudanças” (snapshot) não é backup.** Ele só descreve posição,
  estilo e um pedaço do texto. Não dá para restaurar a partir dele.
- **Checkpoint é o backup de verdade:** uma cópia do `.indd` em
  `_checkpoints/`, na mesma pasta do documento. O assistente tira uma sozinho
  antes de qualquer alteração e **se recusa a mexer** se não conseguir gravar a
  cópia. Ficam as 12 mais recentes; para voltar, é só abrir a cópia.
- **Um Cmd+Z desfaz o pedido inteiro.** Se você pediu cinco mudanças de uma vez,
  elas entram como um único passo no histórico — e se algo falhar no meio, nada
  é aplicado, em vez de deixar a página pela metade.

Peça: *“Faz um checkpoint antes, com a tag reescrita-p8.”*

Isso existe porque uma sequência de correções pequenas, cada uma adivinhando
qual quadro era o alvo, já destruiu uma página inteira. Peça **uma** mudança
grande em vez de dez pequenas.

---

## Exemplos de pedidos reais (copie e adapte)

**Setup da sessão**  
> Abre conexão com o InDesign, faz scan do documento ativo e analisa a página 1. Me diz o que é título, corpo e imagem.

**Espaçamento editorial**  
> Aumenta o espaço vertical entre os títulos (Header) da página 1 para uns 24 pontos e me resume o que mudou.

**Texto + estilo**  
> No título da página 1, troca o texto para “Lançamento Q3” e aplica o paragraph style Heading 1.

**Seleção no InDesign**  
> (Com objetos selecionados no InDesign) Alinha a seleção ao centro da página e sobe 10 pt.

**Limpeza de layout**  
> Diagnostica sobreposição de texto na página 2. Se houver problema, mostra o preview e depois aplica a correção.

**Assets**  
> Verifica links missing ou desatualizados. Se a imagem da página 1 estiver missing, me avisa antes de relinkar.

**Várias ações de uma vez**  
> Na página 1: aplica Body no texto corrido, Caption nas legendas, empilha título e subtítulo com 16 pt de gap, e centraliza a imagem principal.

---

## Como o assistente “enxerga” o documento (sem jargão)

1. Ele **lê** o documento aberto uma vez (scan) e guarda um mapa na sessão.  
2. Cada objeto ganha um **ID estável** (você não precisa ver isso).  
3. Ele pode **classificar** papéis (título, corpo…).  
4. Ele aplica várias mudanças **em lote** no InDesign.  
5. No fim, pode **comparar antes/depois**.

Por isso: **não peça “escaneia de novo” a cada micro-ajuste**. Escaneia no começo; só peça refresh se você mexeu na mão no InDesign ou trocou de arquivo.

---

## O que ainda NÃO está no v0.1 (limites honestos)

Para não criar expectativa errada:

- Criar documentos complexos **do zero** / templates enterprise completos  
- Notas de rodapé, GREP styles avançados, tabelas completas como fluxo principal  
- Exportar **PDF / IDML** por este MCP (ainda não)  
- Windows (hoje é **macOS** + InDesign aberto)  
- Editar um arquivo que **não está aberto** no InDesign  
- Garantia 100% de acerto na classificação automática de “o que é título” — revise quando o layout for atípico  

Se precisar de algo fora dessa lista, anote para o time (candidato a v0.2).

---

## Dicas de produtividade

1. **Salve uma cópia** do `.indd` antes de campanhas grandes de edição automática.  
2. Use **Undo do InDesign** (Cmd+Z) se algo sair do esperado — as mudanças são reais no arquivo aberto.  
3. Trabalhe **página a página** em revistas longas (“faz a página 3, depois a 4”).  
4. Combine **seleção no InDesign** + pedido no Cursor quando a classificação automática falhar.  
5. Peça **preview / dry-run** quando o ajuste for arriscado (“só me mostra o plano, não aplica ainda”).  
6. No fim: *“Resume as mudanças”* + revise visualmente no InDesign antes de entregar.

---

## Se der problema

| Sintoma | O que tentar |
| --- | --- |
| “InDesign não responde” / timeout | App aberto? Documento aberto? Aceitou Automação no macOS? |
| Edita o arquivo errado | Confirme qual `.indd` está na frente no InDesign; peça ping + nome do documento |
| Pediu “título” e mexeu no objeto errado | Peça `analyze_page` de novo, corrija o papel, ou selecione o objeto certo e diga “a seleção” |
| Você editou na mão e o assistente “não viu” | “Atualiza / refresca o documento” |
| MCP aparece desligado no Cursor | Settings → MCP → Reload; ou reinicie o Cursor |
| Mudança não apareceu | Confira se o pedido foi aplicado; peça resumo; olhe a página correta |

Suporte técnico interno: repositório `mcp-indesign-agent`, comando de diagnóstico `npm run doctor` (time de engenharia).

---

## Resumo do que está na sua mão

Você pode, em conversa no Cursor, com o InDesign aberto:

- Ler e entender o documento (páginas, textos, imagens, estilos, links)  
- Classificar títulos / corpo / imagens  
- Editar texto, fonte e estilos  
- Mover, alinhar, distribuir, empilhar, ajustar margens  
- Diagnosticar e corrigir sobreposições  
- Relinkar / incorporar imagens  
- Revisar o diff do que mudou  

**Fluxo mental simples:**  
*Conectar → Ler o doc → (Analisar a página) → Pedir mudanças → Revisar o resumo no InDesign.*

Boa produção.
