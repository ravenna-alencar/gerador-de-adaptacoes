# Gerador de Adaptações — contexto do projeto

App interno da Gocase que **recompõe estampas via IA** para os diferentes tamanhos/máscaras
de produto, sem esticar nem deixar bordas vazias. Ajuda o time de Ilustra a ver quais estampas
mais vendidas ainda **faltam ser adaptadas** para outros produtos e a **gerar essas adaptações**.

- **Plataforma:** GoDeploy (Cloudflare Workers). `appId: 2cf259c9`
- **URL:** https://gerador-de-adaptacoes.devgogroup.com/ (visibility `authenticated` — login Google Gogroup)
- **Fonte local:** `/Users/ravennaalencar/projetos/gerador-de-adaptacoes/`
  - `src/server.ts` — worker (fetch handler, todas as rotas `/api/*`)
  - `public/index.html` — frontend inteiro (HTML + CSS + JS inline, sem build)
  - `favicon.svg`, `package.json` (mínimo)
- Dona: ravenna.alencar@gocase.com

> App SEPARADO do `benchmark-mockups` (captura de mockups de marcas). Não confundir.

---

## Abas (frontend)

App bar fixo (marca + segmented tabs). Quatro abas, alternadas por `data-view`. **Ordem no menu e
padrão ao abrir: `Adaptar PSD` é a PRINCIPAL** (primeira e selecionada ao carregar; `view-psd` sem
`hidden`, `view-estampas` com `hidden`). Na abertura roda `setTimeout(ensurePsdMaskOptions, 0)` — o defer
evita TDZ (a chamada fica antes das `let` da seção PSD no arquivo). Estampas carrega sob demanda (ao clicar).

1. **Adaptar PSD** (principal) — envia o **PSD em camadas da estampa** e reposiciona os elementos com
   **fidelidade total (SEM IA)**. Ver seção dedicada abaixo.
2. **Estampas Gocase** — ranking das estampas mais vendidas (90d) por categoria-fonte
   (Capinha, Garrafa Fresh, Tote Daily), com **checklist de cobertura**: em quais produtos a
   estampa já existe (✅) e onde falta (⬜). Clicar em "Adaptar" gera a adaptação.
3. **Adaptar ID** — cola um **ID de produto** (spree_products.id), **SKU**, **engine_identifier**
   ou **identifier do Catalog** (ex: `laco-com-flores-texteis`) → resolve a estampa e mostra as
   adaptações (mesma UI da aba Estampas).
4. **Adaptar imagem** — ferramenta genérica: envia uma imagem, escolhe tamanhos (todas as
   máscaras dos produtos, via `/api/produtos`) e gera com IA. Aplica as regras de composição do segmento.

No menu **Cadastro** há também a aba real **Cadastrar no Catalog** (`data-view="rpa"`,
`#view-rpa`): monta um lote de estampas (PNG + identifier + categoria + grupos) e aciona o
**robô Playwright que roda no GitHub Actions** — aqui dentro não existe navegador. A tela só
manda o pedido e acompanha por polling; quem clica no Catalog é o robô, com a conta `rpa_ia`.
Ver a seção de endpoints `/api/rpa/*` e `SETUP-NUVEM.md` no repositório do robô.

O **painel Adaptar** (compartilhado) busca a arte de referência automaticamente, gera **uma
versão por máscara/volumetria** do produto e mostra, por resultado: **Baixar PNG · Remover fundo
· Gerar nova versão**. Remoção de fundo é **pós-visualização** (só chama o remove.bg quando clica).

---

## Pipeline de geração (2 estágios)

1. **IA recompõe** (PiApp / `gemini-2.5-flash-image`): recebe a arte de referência
   (`reference_image_urls`) + prompt com a regra de composição do segmento, gera no aspect preset
   mais próximo do alvo (9:16, 4:5, 1:1, 16:9, 21:9 — `gemini` não faz dimensão custom).
2. **Canvas finaliza** (cliente): `cover`-crop para o **tamanho exato** da máscara e exporta PNG.
   Opcional: remove.bg → PNG transparente.

### Tipo de estampa (Localizada / Pattern) — seletor nos 2 fluxos (2026-07-29)
Antes de gerar, o usuário escolhe **Localizada** (arte central concentrada) ou **Pattern** (padrão corrido
repetido, seamless). Aparece na aba **Adaptar imagem** (`#tipoImg`) e na **Adaptar PSD** (`#tipoPsd`).
- **Adaptar imagem (IA):** o tipo vai no `/api/generate` (`tipo`) → `buildPrompt(aspect,desc,seg,tipo)`.
  `tipo` tem prioridade sobre o `seg`: pattern = all-over seamless; localizada = composição central. O
  fundo sólido (#fff/#000) continua sendo aplicado quando `seg` é térmico/têxtil.
- **Adaptar PSD (client):** Localizada → `autoLayout('center')` (+ botões Preencher/Centralizar/Espalhar
  e rapport disponíveis). Pattern → `patternLayout()`: ladrilha os motivos numa grade `cols×rows` que
  divide a máscara em partes exatas (emenda contínua nas 2 direções — o que sangra à direita reaparece à
  esquerda). Motivos escalados por **cover** da célula (preenchem, sangram → sem vãos). `#psdCols` (2–8)
  controla a densidade. Camadas full-canvas ficam de fundo (cover), não ladrilham. Render/export via
  `tileOffsetsFor(e,W,H)` (grade do pattern OU rapport lateral). `patternMode()`/`isSpanning()` helpers.

### Regras de composição por segmento (`buildPrompt(aspect, desc, seg, tipo)`)
- **Térmicos** (`seg='termicos'`): **rapport** — padrão contínuo no eixo horizontal, borda
  esquerda casa com a direita (dá a volta no produto), sem foco central.
- **Têxteis** (`seg='texteis'`): arte **centralizada**, margem de segurança, nada cortado nas bordas.
- **Genérico** (sem seg): redistribui preenchendo o canvas.

O `seg` é derivado da categoria do produto (`Térmicos`/`Têxteis`) no frontend e enviado ao `/api/generate`.

---

## Aba "Adaptar PSD" — reposicionamento fiel (100% client-side, sem IA)

Fluxo alternativo ao pipeline de IA, para garantir **fidelidade total**: o PSD em camadas é lido no
navegador e cada camada é reaproveitada pixel a pixel — a arte NÃO é reinterpretada. Tudo roda no
cliente; o servidor só fornece `/api/produtos` (máscaras). Sem chamada ao PiApp/AI Proxy.

- **Leitor:** [`ag-psd`](https://github.com/Agamnentzar/ag-psd) vendorizado em `public/vendor/ag-psd.js`
  (UMD, global `window.agPsd`, ~810KB), carregado **sob demanda** (`loadAgPsd`, `<script>` injetado no 1º uso).
  `readPsd(buf,{useImageData:false, skipLinkedFilesData:true, skipThumbnail:true})`.
- **Parse (`parsePsd` + `nodeToElement`):** itera `psd.children` (index 0 = camada de baixo → desenha
  nessa ordem = fundo→topo). Camada raster → usa `node.canvas`. Grupo/PASTA → `rasterizeGroup` compõe
  as folhas visíveis num canvas no bbox do grupo, vira 1 elemento com `isFolder:true` + `kids` (filhos).
  Pula camadas `hidden`.
- **Pastas abríveis (`expandFolder`):** elemento-pasta tem botão "abrir pasta" na lista → troca a pasta
  pelos filhos (via `nodeToElement`), como elementos independentes, na MESMA posição z. Preserva o visual:
  cada filho recebe `t` a partir do `t` atual da pasta × escala (`t.w/ow`), então nada se move ao abrir.
  Pastas aninhadas viram sub-pastas abríveis de novo. O caminho da pasta vira contexto (`el.group`,
  tag `.psdGroupTag` na lista). Toggle do olho (visível) NÃO re-arranja (preserva ajuste manual);
  toggle fundo⇄elemento re-roda `applyAutoLayout` (mudança estrutural).
- **Separar motivos de uma mesma camada (`splitLayer`):** botão "separar" (camadas não-pasta, não-fundo)
  detecta ILHAS de pixels opacos separadas por transparência (connected-components 8-viz no canal alfa,
  rotulado em baixa-res ~460px + dilatação p/ juntar vãos pequenos), recorta cada ilha do canvas em
  resolução TOTAL, mascara pelo rótulo (remove vazamento de vizinho) e vira 1 elemento independente por
  motivo — preservando a posição visual atual. Ex: camada com 5 estrelas → 5 elementos. Motivos que se
  tocam/sobrepõem ficam num bloco só. `<2` ilhas → avisa que é contíguo.
- **Desfazer (`undoLastSplit`):** pilha LIFO `psdHistory` — cada separar/abrir-pasta registra
  `{original, children}`. O botão "↩︎ Desfazer" remove os filhos e recoloca o elemento original na mesma
  posição z (identidade de objeto, não índice). Reseta ao carregar novo PSD. Funciona com operações
  aninhadas/misturadas (LIFO).
- **Classificação fundo × elemento:** camada que cobre ≥90% do canvas E tem `opaqueFraction≥0.8`
  vira **fundo** (fixo, atrás); o resto são **elementos móveis**. Cada camada tem um badge
  clicável (fundo⇄elemento) e um olho (mostrar/ocultar) — ex: ocultar o monograma "Seu Nome".
- **⚠️ Efeitos de camada NÃO são bakeados** nos canvases crus do ag-psd (só no composite `psd.canvas`).
  Ex real: a camada "Fundo" da estampa Mavi Copa tem um Color Overlay → crua sai cinza-azulado
  [177,198,211], mas o composite é amarelo [251,206,90]. **Solução:** modo de fundo **`auto` (padrão)**
  amostra a **cor de fundo do composite real** (`sampleBgColor`, moda das bordas de `psd.canvas`) e
  preenche sólido — que é o que a estampa Gocase precisa. Outros modos: `layer` (imagem crua da
  camada de fundo, p/ fundos que são foto/imagem real), branco, preto, transparente.
- **Auto-arranjo (`autoLayout`):** **Centralizar** (têxtil) = mantém arranjo relativo, escala pra caber
  centralizado com margem. **Espalhar** (térmico/wrap-around) = distribui os motivos ao longo da
  largura na ordem horizontal original, escala uniforme preenchendo ~72% da altura da faixa (margem lateral 4%).
- **Preencher — Sobrepor / Não sobrepor (`#psdOverlap`, `psdFillOverlap`):** sub-opção do Preencher.
  Sobrepor (default) = distribuição atual (motivos podem se sobrepor). Não sobrepor = `fillGridNoOverlap`:
  grade 1-motivo-por-célula (cols≈√(n·W/H)), cada motivo escalado a ~76% da célula + jitter determinístico
  → 0 sobreposição, com respiro. Validado: sobrepor 13 pares sobrepostos vs não-sobrepor 0.
- **Editores independentes por produto (2026-07-31):** a seção 3 é um **checklist** (`#psdMaskList`).
  Cada produto marcado vira um **bloco de editor independente** empilhado em `#psdEditors` (estado global
  `editors[]` = `{maskIdx, S, dom, canvas}`; `S` = `{tipo,bgMode,rapport,arrangeMode,overlap,cols}`).
  Cada bloco tem **stage interativo (arrastável)** + os **próprios controles abaixo** (Tipo, Fundo,
  Rapport, Arranjo, Sobreposição, cols) construídos em JS (`buildBlock`, classes `js-*`). Cada `ed`
  guarda `layout={T:Map(e→t),pattern,star}`, `nodes=Map(e→{node,ghosts})`, `disp`, `sel`. Layout puro:
  `layoutCompute(mk,S)→{T,pattern,star}` (`autoCompute`/`patternCompute`/`fillGridNoOverlap`);
  `relayout(ed)` recalcula+`edRenderStage(ed)`; **drag/resize** (`edAttachDrag`/`edPositionEl`) muta
  `ed.layout.T` e reposiciona só os nós daquele bloco. Fundo/Rapport → `edRenderStage` (mantém arrastes);
  Tipo/Arranjo/Overlap/cols → `relayout`. Download por bloco: `composeFrom(ed)` (usa `ed.layout`, respeita
  arrastes). **SEM botão Gerar na lateral** (removido) — cada bloco tem **Baixar PNG**. Ferramentas de
  camada (globais) chamam `refreshAllBlocks()` (=relayout todos). `updateEditorsHint` mostra/oculta o hint.
- **Menu remodelado (2026-07-31):** controles por bloco = **Tipo de estampa** (Pattern=padrão | Localizada)
  + **Estilo de adaptação** (opções mudam pelo tipo, via `ESTILOS`/`DEFAULT_ESTILO`). Fundo **removido**
  (sempre transparente — sem fill no compose/render). Rapport **removido** do menu (sempre ligado no
  Pattern: `wrapOffsets` = ±largura; Localizada não repete). `defaultSettings()={tipo:'pattern',estilo:'stickers'}`.
  - **Pattern:** `Stickers` = `autoCompute('fill',{overlap:true})` (preencher+sobrepor); `Linear` =
    `fillGridNoOverlap` grade; `Distribuído` = mesma grade com linhas ímpares deslocadas meia célula
    (xadrez, param `stagger`). `patternCompute` (ladrilho antigo) ficou morto.
  - **Localizada:** `Estrela` = só o elemento ⭐ (`PSD.starEl`), centralizado (~62% da menor dim), demais
    removidos (`layout.onlyStar`). Sem ⭐ → centraliza tudo (`autoCompute('center')`).
- **Elemento principal (⭐):** botão `.psdStar` por camada não-fundo em "2. Elementos detectados" define
  `PSD.starEl` (só um; global). Usado pelo estilo Localizada/Estrela.
- **Sidebar fixa:** `#view-psd .psdSideCol` é `position:sticky; top:84px; max-height:calc(100vh-100px)`
  com `.psdSideScroll` rolável interno e o `.psdGerarBar` em `margin-top:auto` (≥821px) → Gerar sempre
  visível no rodapé enquanto os blocos rolam.
- **Preencher 2D (`autoLayout('fill')`):** para PADRÃO denso — não deixa espaço lateral vazio. Estica a
  distribuição dos motivos até as bordas nos DOIS eixos, baseando-se na extensão dos CENTROS (não das
  bboxes — camadas full-canvas com conteúdo central não enganam). Escala uniforme (média geom. do
  esticamento, clamp 0.4–1.8) + cada motivo **preso dentro da máscara** (clamp x∈[0,W-w], y∈[0,H-h]) →
  toca a borda mas não estoura. Camadas **full-canvas** (bbox ≥85% do canvas) são tratadas à parte:
  **cover** na máscara (preenchem, recortam a sobra), não entram na distribuição.
- **Arranjo escolhido pela MÁSCARA (`chooseMode`):** ao selecionar/abrir uma máscara o editor já aplica
  o arranjo adequado — **≥12 elementos (padrão denso) → preencher (2D)**; senão `seg==='termicos'` OU
  proporção ≥1.7 (faixa larga) → **espalhar**; senão → **centralizar**. 3 botões manuais: Preencher /
  Centralizar / Espalhar.
- **Editor:** stage escalado (`psdDisp`), cada elemento é um `<div.psdEl>` absoluto arrastável
  (pointer events) + alça de resize proporcional (mantém centro). Transforms guardados em px do ALVO.
  `positionEl(e)` posiciona o elemento e seus fantasmas juntos.
- **Rapport (dá a volta):** checkbox `#psdRapport` (default ON quando `seg==='termicos'`). Com ele ligado,
  cada elemento ganha 2 "fantasmas" (`.psdEl.ghost`, `pointer-events:none`) deslocados de ±largura da
  máscara, que acompanham o arraste AO VIVO → o motivo que sai por um lado entra pelo outro (emenda
  contínua p/ produto cilíndrico). Ao soltar, o centro é normalizado p/ `[0,W)` (posição idêntica, x
  limitado). No **export** cada elemento é desenhado 3×: em `x`, `x−W` e `x+W`, garantindo a emenda no PNG.
- **Export:** canvas offscreen no **tamanho exato da máscara**, desenha fundo + cada elemento visível
  em resolução total → `toBlob('image/png')` → download `estampa-<key>-WxH.png`. Fidelidade 100%.
- **Fallback PSD achatado:** se todas as camadas viram fundo (nenhum elemento móvel), o modo `auto`/
  `layer` cobre-recorta a arte inteira — degrada pro comportamento de cover-crop.

---

## Fontes de dados

O app NÃO tem dados próprios de catálogo; consulta bancos externos:

| Fonte | Como o app acessa | Uso |
|---|---|---|
| **Site** (Spree, Metabase db 2) | Proxy GoDeploy `POST ${PROXY_BASE_URL}/site/_query` body `{sql}`, com **cookie do visitante** (exige login) | Ranking de vendas (`consolidated_product_sales`), cobertura (`spree_products` + `spree_product_translations`), refimg (`velociraptor_products.image_br`), resolução por id/SKU/engine_identifier |
| **Factory** (Metabase db 3) | (usado só por mim, no design; não em runtime) | Dimensões das máscaras (`materials.width/height`) — hardcoded no `PRODUTOS` |
| **Catalog / Prisma** (Metabase db 19) | **API do Metabase** `POST https://metabase.gocase.com.br/api/dataset` header `x-api-key`, body `{database:19,type:'native',native:{query}}` | Resolver `identifier` do Catalog (`design_customizations`) que não existe no Site |

> O proxy do GoDeploy só expõe `site/factory/datamart/clickhouse` — **NÃO** o Catalog. Por isso o
> Catalog é acessado via API do Metabase (secret `METABASE_TOKEN`).

### Estampa / imagem de referência
- A estampa NÃO tem campo próprio; vem do **nome** (`spree_product_translations.name`, pt-BR).
  Capinha: o nome É a estampa. Outros: `"<Produto> - <estampa>"`.
- **Muitos nomes têm ESPAÇO inicial** (ex `" Tote Mini - Futurist"`) → sempre normalizar com
  `lower(btrim(...))` nos matchers ancorados (`LIKE 'x%'`), senão dá falso-negativo.
- Arte de referência (Site): `https://custom-case-images.s3.amazonaws.com/` + o `stamp=` extraído de
  `velociraptor_products.image_br` (mesma lógica do card Metabase 21318).
- Arte de referência (Catalog): `design_customizations.preview_pt` do grupo base.

---

## Endpoints (`src/server.ts`)

- `GET /api/produtos` — registro de produtos + máscaras (fonte única p/ aba Adaptar imagem). Estático.
- `GET /api/estampas/top?cat=&dias=90` — top-15 estampas da categoria + cobertura embutida.
- `GET /api/estampas/coverage?e=<estampa>` — cobertura de uma estampa (checklist).
- `GET /api/estampas/refimg?e=<estampa>` — URL da arte da estampa (via velociraptor image_br).
- `GET /api/estampas/byid?id=<id|sku|engine_identifier|catalog identifier>` — resolve produto →
  estampa + cobertura + refUrl. Ordem: spree id (num) → engine_identifier → SKU → **fallback Catalog** (Metabase API).
- `POST /api/generate {refUrl, aspect, desc, seg}` — dispara geração no PiApp → `{jobId}`.
- `GET /api/status?job=<id>` — polling do job.
- `GET /img?job=<id>&nobg=1` — serve a imagem gerada (proxy dos bytes; `nobg=1` aplica remove.bg).
- `POST /api/prepare {imageBase64}` — (aba Adaptar imagem) sobe a imagem enviada como referência (PiApp upload_reference) + descreve via visão.

### RPA — cadastro no Catalog v3 (menu Cadastro → "Cadastrar no Catalog")

- `GET  /api/rpa/config` — grupos de adaptação e materiais base por categoria + `configurado` (se os segredos do GitHub existem).
- `POST /api/rpa/lote` — cria o lote (só metadados) → `{job_id, arquivos}`. Valida identifier (`^[a-z0-9][a-z0-9-]{1,80}$`), duplicata e categoria; máx. 50 estampas.
- `POST /api/rpa/lote/imagem {job_id, arquivo, dataUrl}` — **um PNG por chamada** (evita estourar o tamanho de requisição); grava em `jobs/<job_id>/` no branch `jobs` do repo do robô. Máx. 25MB, só PNG.
- `POST /api/rpa/lote/disparar {job_id}` — monta o `config.json` a partir do banco e chama o `workflow_dispatch`.
- `POST /api/rpa/progresso` / `POST /api/rpa/finalizar` — **o robô** reportando (exige header `x-rpa-token` = segredo `RPA_TOKEN`).
- `GET  /api/rpa/status?job=&desde=` — polling da tela (2,5s), devolve o job + eventos novos desde o id `desde`.
- `GET  /api/rpa/lotes` — histórico (últimos 20) de quem está olhando.

Tabelas próprias em `env.DB`: `rpa_jobs`, `rpa_estampas`, `rpa_eventos` (criadas por `ensureRpaTables`).

---

## Secrets (setAppSecret) — nunca no código

- `PIAPP_TOKEN` — geração de imagem (PiApp REST `piapp-v2.vercel.app/api/v1`; upload via MCP `.../api/ai/mcp`). Time "ilustra".
- `AI_PROXY_TOKEN` — visão/descrição (`ai-proxy.gogroupbr.com/v1/chat/completions`, modelo `gpt-5.5`).
- `REMOVEBG_KEY` — remove.bg (**plano free = saída 0.25MP**; upgrade pago = alta resolução).
- `METABASE_TOKEN` — API key do Metabase (`mb_...`) p/ consultar o Catalog (db 19).
- `PROXY_BASE_URL` — injetado pelo GoDeploy (proxy de dados do Site).
- `GITHUB_TOKEN` + `GITHUB_REPO` — acionam o robô de cadastro (repo privado `rpaiagogroup/catalog-estampas-rpa`). Sem eles a aba "Cadastrar no Catalog" aparece com aviso e botão desabilitado; o resto do app não muda.
- `RPA_TOKEN` — senha combinada com o robô; sem ela `/api/rpa/progresso` e `/api/rpa/finalizar` respondem 401.
- Opcionais: `GITHUB_REF` (default `main`), `GITHUB_JOBS_BRANCH` (default `jobs`), `GITHUB_WORKFLOW` (default `cadastrar-estampas.yml`).

> **A sessão do Catalog nunca passa por este app.** Ela é segredo do GitHub (`CATALOG_AUTH_STATE`),
> lida só dentro do Actions. Setup completo em `SETUP-NUVEM.md`, no repositório do robô.

---

## Registro de produtos e máscaras (`PRODUTOS` em `src/server.ts`)

Cada produto tem `masks: [{w,h}]` (várias = volumetrias). `adaptavel` = tem máscara.
Dimensões puxadas do Factory (`materials`), verificadas contra as conhecidas.

- **Case:** Capinha (origem — sem máscara).
- **Térmicos:** Garrafa Fresh [2754×2340, 3380×2114], Garrafa Urban [2672×1465], Garrafa Mini
  [2754×1335], Garrafa Fun [2783×1524], Garrafa Flip [2915×2102, 2754×2340], Garrafa Magsafe
  [2915×2102, 2754×2340], Copo Life [3488×1890(600ml), 3495×2384(880ml), 3827×2598(1180ml)],
  Copo Térmico [3512×1441, 2672×1465].
- **Têxteis:** Tote Daily [2244×1831], Tote Mini [2126×1654], Mala Trip [3567×850], Mochila Pop
  [2126×1772], Mochila Fun [6297×5411], Necessaire Makeup Double [2296×831], Bolsa de Garrafa [1535×2008].
- **Pendentes:** Tote Pop (sem máscara real no Factory — só placeholder 1000×1000).

`CLASSIFY_SQL` mapeia produto → key por nome real do catálogo (com `btrim`). `groupToKey()` mapeia
os grupos do Catalog → keys do registro.

---

## Deploy

App = `src/server.ts` (entrypoint) + `public/index.html` (asset). **Sempre subir os dois** (o upload
substitui o app inteiro). Fluxo:

```
1. getUploadToken → { uploadToken, uploadUrl }   (token single-use, expira em 1h)
2. curl -F "index.html=@./public/index.html" -F "src/server.ts=@./src/server.ts" \
        -F "favicon.svg=@./public/favicon.svg" -F "vendor/ag-psd.js=@./public/vendor/ag-psd.js" \
        -F "package.json=@./package.json" \
        -H "Authorization: Bearer <uploadToken>" <uploadUrl>   → { uploadId }
3. updateApp({ appId: '2cf259c9', uploadId, entrypoint: 'src/server.ts',
              assets: ['index.html','favicon.svg','vendor/ag-psd.js'] })
```

> O campo do `-F` = caminho servido. `vendor/ag-psd.js` PRECISA estar tanto no upload quanto em
> `assets` (é asset estático servido pela plataforma; o worker só trata `/api/*` e `/img`).

Se o bundle tiver erro de sintaxe, `updateApp` **recusa** e o app no ar não muda (rede de segurança).
Debug: `getAppLogs`.

---

## Gotchas / decisões

- **Cobertura é ao vivo** (consulta o Site a cada abertura do painel). Sem cron de varredura — decisão da usuária.
- Endpoints que usam o `_query` do Site **exigem login** (cookie do visitante); via curl anônimo dão `not_authenticated`. Testes de dados eu faço direto no Metabase.
- `gemini-2.5-flash-image` NÃO faz dimensão custom → gera no aspect preset e o Canvas faz cover-crop.
- Nomes com espaço inicial: usar `btrim` (ver acima).
- Resolução final limitada pelo remove.bg free (0.25MP) quando o fundo é removido; upgrade pago resolve.
- `name_pt` no Catalog costuma ser nulo → a aba Adaptar ID exibe o identifier de-slugificado.

---

## Ideias / pendências

- Habilitar Tote Pop quando houver máscara.
- Mala Voyage (2940×4548) saiu da aba Adaptar imagem (não está no registro) — readicionar se quiser.
- Nome bonito do design na aba Adaptar ID (cruzar com a versão `-case` no Site).
- Upgrade do plano remove.bg + modelo 4K, se precisar de alta resolução.
