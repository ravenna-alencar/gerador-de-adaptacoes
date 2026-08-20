// Gerador de Adaptações — worker (GoDeploy / Cloudflare Workers)
//
// Fluxo: o usuário envia uma imagem e escolhe tamanhos (presets). Para cada
// preset, a IA RECOMPÕE os elementos da imagem no novo formato (não estica, não
// corta o conteúdo — redistribui). Dois estágios:
//   1. IA (AI Proxy visão -> prompt) + PiApp (gera no aspect preset mais próximo)
//   2. Canvas no cliente finaliza no tamanho exato (cover-crop)
//
// Secrets (setAppSecret):
//   PIAPP_TOKEN      obrigatório — geração de imagem (PiApp)
//   AI_PROXY_TOKEN   opcional — descreve a imagem p/ prompt mais fiel (visão) e nomeia estampas
//   PIAPP_URL        opcional (default: https://piapp-v2.vercel.app)
//   AI_PROXY_URL     opcional (default: https://ai-proxy.gogroupbr.com/v1/chat/completions)
//   AI_MODEL         opcional (default: gpt-5.5)
//   PIAPP_MODEL      opcional (default: gemini-2.5-flash-image)
//   REMOVEBG_KEY     opcional — se presente, remove o fundo (PNG transparente) via remove.bg
//   REMOVEBG_URL     opcional (default: https://api.remove.bg/v1.0/removebg)
//
// Identificação de estampa (Etapa 0 da aba "Adaptar PSD"):
//   Antes de subir o PSD, o usuário escolhe categoria (Case/Térmicos/Têxteis) e
//   segmento (Futebol/Autoral/Licenciado) + a tag correspondente (time/coleção/
//   licenciado). Ao ler o PSD, /api/estampas/gerar-nome sugere 3 nomes via IA
//   (mesmo AI Proxy usado em describeImage). Ao confirmar, /api/estampas/registrar
//   grava o registro em env.DB (SQLite nativo do GoDeploy) junto com o e-mail do
//   usuário autenticado (header x-godeploy-user-email, injetado pelo gateway).

interface DbResult { columns: string[]; rows: Record<string, unknown>[]; rowsRead: number }
interface DbExecResult { rowsWritten: number }
interface Db {
  query(sql: string, params?: unknown[]): Promise<DbResult>;
  exec(sql: string, params?: unknown[]): Promise<DbExecResult>;
}

interface Env {
  PIAPP_TOKEN?: string;
  PIAPP_URL?: string;
  PIAPP_MODEL?: string;
  AI_PROXY_TOKEN?: string;
  AI_PROXY_URL?: string;
  AI_MODEL?: string;
  REMOVEBG_KEY?: string;
  REMOVEBG_URL?: string;
  PROXY_BASE_URL?: string;
  METABASE_TOKEN?: string; // consulta o Catalog (Prisma, db 19) via API do Metabase
  METABASE_URL?: string;
  GOOGLE_CLIENT_EMAIL?: string; // conta de serviço p/ gravar o registro na planilha dedicada
  GOOGLE_PRIVATE_KEY?: string;
  DB: Db;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

const PIAPP_MCP = 'https://piapp-v2.vercel.app/api/ai/mcp';

/** Decodifica um data URL (data:image/png;base64,....) em bytes + mime. */
function decodeDataUrl(dataUrl: string): { bytes: Uint8Array; mime: string } {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  if (!m) throw new Error('data URL inválido');
  const mime = m[1];
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, mime };
}

/** Chama uma tool do MCP do PiApp (JSON-RPC sobre HTTP, resposta em SSE). */
async function piappMcpCall(
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(PIAPP_MCP, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`MCP ${name} HTTP ${res.status}: ${text.slice(0, 200)}`);
  // extrai a linha "data: {...}" do SSE
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  if (!line) throw new Error(`MCP ${name}: resposta sem data`);
  const parsed = JSON.parse(line.slice(6)) as {
    result?: { content?: { text?: string }[] };
    error?: { message?: string };
  };
  if (parsed.error) throw new Error(`MCP ${name}: ${parsed.error.message}`);
  const inner = parsed.result?.content?.[0]?.text;
  if (!inner) throw new Error(`MCP ${name}: conteúdo vazio`);
  return JSON.parse(inner);
}

/** Sobe a imagem como referência no PiApp e devolve a URL pública. */
async function uploadReference(env: Env, dataUrl: string): Promise<string> {
  const { bytes, mime } = decodeDataUrl(dataUrl);
  const ext = mime.split('/')[1] || 'png';
  const up = (await piappMcpCall(env.PIAPP_TOKEN!, 'upload_reference', {
    filename: `ref.${ext}`,
    content_type: mime,
  })) as { upload_url: string; upload_token: string; public_url: string };
  const put = await fetch(up.upload_url, {
    method: 'PUT',
    headers: { 'content-type': mime, authorization: `Bearer ${up.upload_token}` },
    body: bytes,
  });
  if (!put.ok) throw new Error(`upload PUT HTTP ${put.status}: ${(await put.text()).slice(0, 200)}`);
  return up.public_url;
}

/** Usa o AI Proxy (visão) para descrever os elementos/estilo da imagem. */
async function describeImage(env: Env, dataUrl: string): Promise<string> {
  if (!env.AI_PROXY_TOKEN) return '';
  const endpoint = env.AI_PROXY_URL || 'https://ai-proxy.gogroupbr.com/v1/chat/completions';
  const model = env.AI_MODEL || 'gpt-5.5';
  const system =
    'You analyze an image and list its reusable visual DNA so another image model can recreate a ' +
    'visually consistent artwork in a different aspect ratio. Describe ONLY: the main visual elements/motifs, ' +
    'the illustration/art style and technique, the color palette, textures and the background. ' +
    'Ignore the current layout, framing and aspect ratio. Return ONE concise English paragraph (40-80 words), ' +
    'no preamble, no markdown.';
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.AI_PROXY_TOKEN}` },
      signal: AbortSignal.timeout(25000), // não deixa a visão travar o /api/prepare
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Describe the reusable visual DNA of this image.' },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
    });
    if (!res.ok) return '';
    const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return (j.choices?.[0]?.message?.content || '').trim();
  } catch {
    return '';
  }
}

// Segmento -> rótulo da tag associada (usado no prompt de nomeação e no registro).
const TAG_LABEL: Record<string, string> = {
  futebol: 'time',
  autoral: 'coleção',
  licenciado: 'licenciado',
};

/** Usa o AI Proxy (visão) para sugerir 3 nomes de estampa coerentes com o estilo Gocase. */
async function sugerirNomesEstampa(
  env: Env,
  dataUrl: string,
  ctx: { categoria: string; segmento: string; tag: string; evitar: string[] },
): Promise<string[]> {
  if (!env.AI_PROXY_TOKEN) throw new Error('AI_PROXY_TOKEN não configurado');
  const endpoint = env.AI_PROXY_URL || 'https://ai-proxy.gogroupbr.com/v1/chat/completions';
  const model = env.AI_MODEL || 'gpt-5.5';
  const tagLabel = TAG_LABEL[ctx.segmento] || 'tag';
  const contexto = [
    `Categoria do produto: ${ctx.categoria || 'não informada'}`,
    `Segmento: ${ctx.segmento || 'não informado'}`,
    ctx.tag ? `${tagLabel}: ${ctx.tag}` : '',
  ].filter(Boolean).join('. ');
  const system =
    'Você nomeia estampas para a Gocase (capinhas, térmicos e têxteis). Olhando a imagem da estampa e o ' +
    'contexto informado, sugira 3 nomes curtos (2 a 5 palavras), em português, no estilo Gocase: descritivos, ' +
    'vendáveis, sem repetir o nome do time/licenciado/coleção sozinho, sem aspas, sem numeração, sem emojis. ' +
    'Responda APENAS um array JSON de 3 strings, nada mais.';
  const evitarTxt = ctx.evitar.length
    ? ` Evite repetir (já usados): ${ctx.evitar.slice(0, 30).join(', ')}.`
    : '';
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.AI_PROXY_TOKEN}` },
    signal: AbortSignal.timeout(25000),
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: [
            { type: 'text', text: `${contexto}.${evitarTxt} Sugira 3 nomes para esta estampa.` },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`AI Proxy HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const raw = (j.choices?.[0]?.message?.content || '').trim();
  const m = /\[[\s\S]*\]/.exec(raw);
  if (!m) throw new Error('resposta da IA sem array de nomes');
  const arr = JSON.parse(m[0]) as unknown[];
  const nomes = arr.map((n) => String(n).trim()).filter(Boolean).slice(0, 3);
  if (!nomes.length) throw new Error('IA não retornou nomes');
  return nomes;
}

async function ensureRegistrosTable(env: Env): Promise<void> {
  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS registros_estampas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      user_email TEXT,
      categoria TEXT NOT NULL,
      segmento TEXT NOT NULL,
      tag TEXT,
      nome TEXT NOT NULL,
      arquivo_nome TEXT,
      sheet_synced INTEGER NOT NULL DEFAULT 0,
      identifier TEXT,
      sku TEXT
    )`,
    [],
  );
  // Migrações idempotentes: tabelas criadas antes desta versão não tinham estas colunas.
  for (const ddl of [
    `ALTER TABLE registros_estampas ADD COLUMN sheet_synced INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE registros_estampas ADD COLUMN identifier TEXT`,
    `ALTER TABLE registros_estampas ADD COLUMN sku TEXT`,
  ]) {
    try { await env.DB.exec(ddl, []); } catch { /* coluna já existe — segue normalmente */ }
  }
  // Uma linha por ITEM registrado. No fluxo com PSD, cada produto/tamanho que o usuário
  // adaptar e BAIXAR vira uma linha própria aqui (mesmo registro_id — a "nomeação" —, mas
  // Identifier/SKU podem ser diferentes por item, editáveis antes do download). No fluxo
  // sem PSD ("Adicionar imagem"), gera-se um único item (produto_key NULL) na hora de
  // aprovar o nome, já que não existe etapa de adaptar pra esperar.
  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS registros_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      registro_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      produto_key TEXT,
      produto_label TEXT NOT NULL,
      identifier TEXT NOT NULL,
      sku TEXT NOT NULL,
      sheet_synced INTEGER NOT NULL DEFAULT 0,
      oficial_futebol_aplicavel INTEGER NOT NULL DEFAULT 0,
      oficial_futebol_synced INTEGER NOT NULL DEFAULT 0
    )`,
    [],
  );
}

// ---------------------------------------------------------------------------
// Identifier = slug do nome da estampa (sem acentos/maiúsculas — ex.: "Escudo Alvinegro
// Imponente" -> "escudo-alvinegro-imponente"), único por estampa (sufixo -2/-3 só no caso
// raro de duas estampas com o mesmo nome). Um SKU por ITEM (produto/tamanho) é calculado no
// cliente como sugestão e pode ser editado antes de registrar — ver registrar-item.
// ---------------------------------------------------------------------------

const CATEGORIA_SLUG: Record<string, string> = { Case: 'case', 'Térmicos': 'termicos', 'Têxteis': 'texteis' };

function slugify(s: string): string {
  return s
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // remove acentos (marcas de combinação, após NFD)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'item';
}

/**
 * Garante que o identifier seja único: se o slug "base" (nome da estampa) já existir em
 * algum registro anterior, sufixa com "-2", "-3", etc. até achar um livre. Sem isso, duas
 * estampas com o mesmo nome colidiriam de identifier e de SKU (que é derivado dele).
 */
async function identifierUnico(env: Env, base: string): Promise<string> {
  const r = await env.DB.query(
    `SELECT identifier FROM registros_estampas WHERE identifier = ? OR identifier LIKE ?`,
    [base, `${base}-%`],
  );
  const existentes = new Set(r.rows.map((row) => String(row.identifier)));
  if (!existentes.has(base)) return base;
  let n = 2;
  while (existentes.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

// ---------------------------------------------------------------------------
// Google Sheets (conta de serviço) — o registro da estampa (Etapa 0/2 da aba
// "Adaptar PSD") também é gravado numa planilha dedicada, além do env.DB.
// Credenciais (secrets): GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY — mesma conta
// de serviço do Nomeador de Estampas (nomeador-estampas@n8n-gizele.iam.gserviceaccount.com),
// compartilhada como Editor na planilha REGISTRO_SHEET_ID. O Worker não tem os
// módulos crypto do Node, então o JWT (RS256) é assinado via Web Crypto (SubtleCrypto).
// ---------------------------------------------------------------------------

// Planilha "Registros — Gerador de Adaptações" — dedicada a este app (não é nenhuma das
// planilhas de SKU do Nomeador de Estampas: aquelas têm esquema de colunas próprio, usado
// pelo pipeline de geração de SKU/catálogo, e misturar os registros de nome aqui bagunçaria
// esse formato). Compartilhada como Editor com a mesma conta de serviço do Nomeador de Estampas.
const REGISTRO_SHEET_ID = '1IgXrORxbUzAhxZVH1Whin4YQzJP7ZL8-TCL4RH8QeQ0';

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const clean = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/** Troca o JWT (assinado com a chave da conta de serviço) por um access_token OAuth2. */
async function googleAccessToken(env: Env, scope: string): Promise<string> {
  if (!env.GOOGLE_CLIENT_EMAIL || !env.GOOGLE_PRIVATE_KEY) {
    throw new Error('GOOGLE_CLIENT_EMAIL/GOOGLE_PRIVATE_KEY não configurados');
  }
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: env.GOOGLE_CLIENT_EMAIL,
    scope,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const encHeader = b64url(new TextEncoder().encode(JSON.stringify(header)));
  const encClaim = b64url(new TextEncoder().encode(JSON.stringify(claim)));
  const signInput = `${encHeader}.${encClaim}`;
  // secrets do GoDeploy vêm como texto puro; a chave PEM costuma ter \n literais escapados.
  const pem = env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(pem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signInput));
  const jwt = `${signInput}.${b64url(sig)}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }).toString(),
  });
  const j = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!res.ok || !j.access_token) {
    throw new Error(`OAuth2 HTTP ${res.status}: ${j.error_description || j.error || 'sem access_token'}`);
  }
  return j.access_token;
}

/** Nome da primeira aba da planilha (evita assumir "Sheet1" vs "Página1"). */
async function sheetsFirstTabTitle(token: string, sheetId: string): Promise<string> {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties.title`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`Sheets metadata HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { sheets?: { properties?: { title?: string } }[] };
  const title = j.sheets?.[0]?.properties?.title;
  if (!title) throw new Error('planilha sem abas');
  return title;
}

async function sheetsAppendRow(token: string, sheetId: string, tab: string, row: unknown[]): Promise<void> {
  // Aspas simples no nome da aba são necessárias em notação A1 sempre que o título tem espaço
  // (ex.: "Térmicos " com espaço no final) — funcionam também pra nomes simples, então usamos
  // sempre, sem precisar checar caractere por caractere.
  const quotedTab = `'${tab.replace(/'/g, "''")}'`;
  const range = encodeURIComponent(`${quotedTab}!A:Z`);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}:append` +
      `?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ values: [row] }),
    },
  );
  if (!res.ok) throw new Error(`Sheets append HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

const REGISTRO_HEADER = [
  'Criado em', 'Usuário', 'Categoria', 'Segmento', 'Tag', 'Produto', 'Nome', 'Identifier', 'SKU', 'Arquivo',
];

/** GoDeploy só entrega e-mail (x-godeploy-user-email) — deriva um nome de exibição a partir
 * do local-part ("joao.wellington" -> "Joao Wellington"), pra planilha/UI mostrarem um nome
 * de pessoa em vez do e-mail cru. Sem acentuação (não dá pra recuperar isso do e-mail). */
function displayNameFromEmail(email: string | null | undefined): string {
  if (!email) return '';
  const local = email.split('@')[0] || '';
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join(' ');
}

interface RegistroRow {
  createdAt: string;
  userEmail: string | null;
  categoria: string;
  segmento: string;
  tag: string;
  produto: string;
  nome: string;
  identifier: string;
  sku: string;
  arquivoNome: string;
}

/** Garante que a linha 1 seja exatamente REGISTRO_HEADER (cria ou corrige se já tiver um cabeçalho antigo/menor). */
async function ensureSheetHeader(token: string, sheetId: string, tab: string): Promise<void> {
  const range = encodeURIComponent(`${tab}!A1:${String.fromCharCode(64 + REGISTRO_HEADER.length)}1`);
  const headRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  const headJson = headRes.ok ? ((await headRes.json()) as { values?: unknown[][] }) : {};
  const current = headJson.values?.[0] || [];
  const matches = REGISTRO_HEADER.length === current.length &&
    REGISTRO_HEADER.every((h, i) => h === current[i]);
  if (matches) return;
  const putRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ values: [REGISTRO_HEADER] }),
    },
  );
  if (!putRes.ok) throw new Error(`Sheets header update HTTP ${putRes.status}: ${(await putRes.text()).slice(0, 200)}`);
}

/** Grava uma linha do registro na planilha dedicada (cria/corrige o cabeçalho se preciso). */
async function registrarNaPlanilha(env: Env, row: RegistroRow): Promise<void> {
  if (!REGISTRO_SHEET_ID) throw new Error('REGISTRO_SHEET_ID ainda não configurado');
  const token = await googleAccessToken(env, 'https://www.googleapis.com/auth/spreadsheets');
  const tab = await sheetsFirstTabTitle(token, REGISTRO_SHEET_ID);
  await ensureSheetHeader(token, REGISTRO_SHEET_ID, tab);
  await sheetsAppendRow(token, REGISTRO_SHEET_ID, tab, [
    row.createdAt, displayNameFromEmail(row.userEmail), row.categoria, row.segmento, row.tag, row.produto,
    row.nome, row.identifier, row.sku, row.arquivoNome,
  ]);
}

// ---------------------------------------------------------------------------
// Planilha OFICIAL de Futebol (produção — outras pessoas/pipelines usam essa planilha,
// não é nossa). Fase de TESTE: só a aba "Térmicos " (sem data — criada manualmente pelo
// usuário como aba de teste). Continuamos NÃO escrevendo nas 3 planilhas de SKU
// (Licenciado/Autoral/Futebol "oficiais" originais) além desta, por ora.
//
// Formato real da aba (confirmado lendo a planilha): título mesclado na linha 1, cabeçalho
// na linha 2 = Clube | Produto | Ilustrador | Nome | Identifier | SKU | Cadastro Catalog |
// Aprovação | Cadastro Spree | CORES | OBS | Estampa 360 | Data de Cadastro | Lançamento | OK.
// "Produto" aqui é o MODELO físico (Fresh/Urban/Mini/Life/Cerveja/Flip Pro/Magsafe/Kids) — uma
// mesma estampa gera uma linha por modelo marcado, todas com o mesmo Identifier mas SKU com
// sufixo próprio (ex.: "<base>-termicos" no Identifier, "<base>-gf" no SKU do modelo Fresh).
// Só preenchemos o que o app sabe (Clube/Produto/Ilustrador/Nome/Identifier/SKU/Data de
// Cadastro); as colunas de fluxo (Cadastro Catalog/Aprovação/Cadastro Spree/CORES/OBS/Estampa
// 360/Lançamento/OK) ficam em branco, pra equipe preencher manualmente depois — por decisão
// explícita do usuário.
// ---------------------------------------------------------------------------

const OFICIAL_FUTEBOL_SHEET_ID = '1_vEADICxH-EJzHhpbo6ZxDgvPLX4XU_V3r60MtOQAZM';
const OFICIAL_TERMICOS_TAB = 'Térmicos '; // aba de teste (sem data) criada pelo usuário

interface OficialFutebolRow {
  clube: string; produto: string; ilustrador: string; nome: string; identifier: string; sku: string; dataCadastro: string;
}

/** Grava uma linha na aba "Térmicos" da planilha OFICIAL de Futebol. Não mexe no cabeçalho
 * (linha 1 é um título mesclado, linha 2 já tem o cabeçalho fixo dessa planilha de terceiros —
 * diferente da nossa planilha dedicada, aqui não corrigimos/recriamos nada, só acrescentamos). */
async function gravarOficialFutebolTermicos(env: Env, row: OficialFutebolRow): Promise<void> {
  const token = await googleAccessToken(env, 'https://www.googleapis.com/auth/spreadsheets');
  await sheetsAppendRow(token, OFICIAL_FUTEBOL_SHEET_ID, OFICIAL_TERMICOS_TAB, [
    row.clube, row.produto, row.ilustrador, row.nome, row.identifier, row.sku,
    '', '', '', '', '', '', row.dataCadastro, '', '',
  ]);
}

interface RegistrarItemArgs {
  registroId: number;
  categoria: string; segmento: string; tag: string; nome: string;
  userEmail: string | null; userName: string;
  produtoKey: string | null; produtoLabel: string;
  identifier: string; sku: string; arquivoNome: string;
}
interface RegistrarItemResult {
  identifier: string; sku: string; sheetSynced: boolean; sheetError: string | null;
  oficialFutebol: { synced: boolean; error: string | null } | null;
}

/** Registra UM item (produto/tamanho) — grava em registros_itens, tenta sincronizar com a
 * nossa planilha "Registros" e, se for Térmicos+Futebol com um produto mapeado, também tenta
 * a planilha OFICIAL de Futebol (aba "Térmicos"). Usado tanto pelo fluxo sem PSD (1 item,
 * na hora de aprovar o nome) quanto por cada download de PNG no fluxo com PSD. */
async function registrarItemInterno(env: Env, a: RegistrarItemArgs): Promise<RegistrarItemResult> {
  const oficial = a.produtoKey ? PRODUTO_KEY_TO_OFICIAL[a.produtoKey] : undefined;
  const oficialAplicavel = a.categoria === 'Térmicos' && a.segmento === 'futebol' && !!oficial;

  await env.DB.exec(
    `INSERT INTO registros_itens
       (registro_id, produto_key, produto_label, identifier, sku, sheet_synced, oficial_futebol_aplicavel, oficial_futebol_synced)
     VALUES (?, ?, ?, ?, ?, 0, ?, 0)`,
    [a.registroId, a.produtoKey, a.produtoLabel, a.identifier, a.sku, oficialAplicavel ? 1 : 0],
  );
  const idRes = await env.DB.query('SELECT last_insert_rowid() AS id', []);
  const itemId = idRes.rows[0]?.id as number | undefined;

  let sheetError: string | null = null;
  try {
    await registrarNaPlanilha(env, {
      createdAt: new Date().toISOString(), userEmail: a.userEmail, categoria: a.categoria, segmento: a.segmento,
      tag: a.tag, produto: a.produtoLabel, nome: a.nome, identifier: a.identifier, sku: a.sku, arquivoNome: a.arquivoNome,
    });
    if (itemId != null) await env.DB.exec('UPDATE registros_itens SET sheet_synced = 1 WHERE id = ?', [itemId]);
  } catch (e) {
    sheetError = String((e as Error).message || e);
  }

  let oficialFutebol: { synced: boolean; error: string | null } | null = null;
  if (oficialAplicavel && oficial) {
    let synced = false; let error: string | null = null;
    try {
      await gravarOficialFutebolTermicos(env, {
        clube: a.tag, produto: oficial.label, ilustrador: a.userName, nome: a.nome,
        identifier: a.identifier, sku: a.sku, dataCadastro: new Date().toISOString().slice(0, 10),
      });
      synced = true;
      if (itemId != null) await env.DB.exec('UPDATE registros_itens SET oficial_futebol_synced = 1 WHERE id = ?', [itemId]);
    } catch (e) {
      error = String((e as Error).message || e);
    }
    oficialFutebol = { synced, error };
  }

  return { identifier: a.identifier, sku: a.sku, sheetSynced: !sheetError, sheetError, oficialFutebol };
}

function orientationLabel(aspect: string): string {
  const [w, h] = aspect.split(':').map(Number);
  if (!w || !h) return 'new';
  if (w > h * 1.1) return 'wide horizontal';
  if (h > w * 1.1) return 'tall vertical';
  return 'square';
}

// seg: 'termicos' (rapport contínuo) | 'texteis' (centralizado c/ margem) | '' (genérico)
// tipo: 'localizada' (arte central concentrada) | 'pattern' (estampa corrida seamless) | '' (usa seg)
function buildPrompt(aspect: string, desc: string, seg = '', tipo = ''): string {
  const orient = orientationLabel(aspect);
  let p =
    `Recompose the artwork from the reference image into a ${orient} composition. ` +
    `Use the SAME visual elements and the EXACT same illustration style. No stretching and ` +
    `no distortion of individual elements. ` +
    `IMPORTANT: ignore and exclude any brand logos, watermarks, monograms, letters or placeholder ` +
    `personalization text present in the reference — reproduce ONLY the decorative pattern/artwork.`;

  // Fundo chapado (sólido branco ou preto) p/ térmicos e têxteis — permite recorte limpo depois.
  const solidBg = ` BACKGROUND: place the artwork on a SINGLE FLAT SOLID background — either pure white (#FFFFFF) ` +
    `or pure black (#000000), whichever contrasts best with the artwork. The background must be perfectly ` +
    `uniform edge to edge: absolutely no gradients, texture, pattern, shadow or vignette in the background.`;

  // Tipo de estampa (selecionado pelo usuário) tem prioridade sobre a regra por segmento.
  const useSolid = seg === 'termicos' || seg === 'texteis';
  if (tipo === 'pattern') {
    p += ` COMPOSITION RULES (all-over repeating pattern / "estampa corrida"): identify the individual motifs ` +
      `and REPEAT them to fill the ENTIRE canvas as a seamless, continuous surface pattern. Distribute the ` +
      `motifs uniformly and densely across the whole area with regular, even spacing. The pattern MUST TILE ` +
      `SEAMLESSLY — the left edge continues into the right edge (and top into bottom) with no visible seam, no ` +
      `abrupt cut at the borders and no large empty areas. Do NOT create a single central focal point.` +
      (useSolid ? solidBg : '');
    if (desc) p += ` Visual DNA to preserve: ${desc}`;
    return p;
  }
  if (tipo === 'localizada') {
    p += ` COMPOSITION RULES (localized print): build ONE CENTERED composition. Keep the artwork concentrated ` +
      `in the central region of the canvas, arranged as a single balanced group, with a comfortable safety ` +
      `margin around it. It must NOT be a full-bleed repeating pattern, and nothing important may be cut off ` +
      `at the edges or corners.` +
      (useSolid ? solidBg : '');
    if (desc) p += ` Visual DNA to preserve: ${desc}`;
    return p;
  }

  if (seg === 'termicos') {
    // Produto cilíndrico: a arte dá a volta -> precisa ser rapport (padrão contínuo).
    p += ` COMPOSITION RULES (wrap-around product): create a SEAMLESS horizontally-repeating pattern (rapport). ` +
      `The LEFT edge must tile perfectly with the RIGHT edge, with no visible seam, cut, break or misalignment ` +
      `when the image wraps around the product. Distribute the motifs evenly and continuously along the horizontal ` +
      `axis so the pattern reads as fluid and repeating; do NOT place a single centered focal element and avoid large empty areas.` +
      solidBg;
  } else if (seg === 'texteis') {
    // Bolsa/mala: arte centralizada, nada cortado, margem de segurança.
    p += ` COMPOSITION RULES (flat panel): CENTER the main artwork in the canvas. Keep a generous safety margin ` +
      `around every side — NO element may be cropped or cut off at the edges, sides or corners. Keep all important ` +
      `elements well inside the canvas, away from the extremities; the area near the borders should stay calm/uncluttered. ` +
      `The composition must be balanced and centered, not a full-bleed edge-to-edge pattern.` +
      solidBg;
  } else {
    // Genérico (aba "Adaptar imagem"): redistribui preenchendo o canvas, mantendo o fundo da referência.
    p += ` REDISTRIBUTE the elements to evenly fill the entire canvas with balanced spacing, no large empty areas. ` +
      `Keep the same background as the reference.`;
  }

  if (desc) p += ` Visual DNA to preserve: ${desc}`;
  return p;
}

/** Dispara a geração no PiApp e devolve o job_id. */
async function piappGenerate(
  env: Env,
  refUrl: string,
  aspect: string,
  prompt: string,
): Promise<string> {
  const base = (env.PIAPP_URL || 'https://piapp-v2.vercel.app').replace(/\/$/, '');
  const model = env.PIAPP_MODEL || 'gemini-2.5-flash-image';
  const res = await fetch(`${base}/api/v1/generate-image`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.PIAPP_TOKEN}` },
    body: JSON.stringify({ prompt, model, aspect_ratio: aspect, reference_image_urls: [refUrl] }),
  });
  const j = (await res.json()) as { job_id?: string; error?: string };
  if (!res.ok || !j.job_id) throw new Error(j.error || `generate HTTP ${res.status}`);
  return j.job_id;
}

async function piappJob(
  env: Env,
  jobId: string,
): Promise<{ status: string; output_url?: string; error?: string }> {
  const base = (env.PIAPP_URL || 'https://piapp-v2.vercel.app').replace(/\/$/, '');
  const res = await fetch(`${base}/api/v1/jobs?ids=${encodeURIComponent(jobId)}`, {
    headers: { authorization: `Bearer ${env.PIAPP_TOKEN}` },
  });
  if (!res.ok) return { status: 'processing' };
  const j = (await res.json()) as { jobs?: { status?: string; output_url?: string; error?: string }[] };
  const job = j.jobs?.[0] || {};
  return { status: job.status || 'processing', output_url: job.output_url, error: job.error };
}

// Registro de produtos p/ cobertura de estampa. `adaptavel` = já temos dimensão
// no gerador (Estágio 2 liga o botão "Adaptar"). Ordem = ordem de exibição.
// Cada produto pode ter VÁRIAS máscaras (volumetrias diferentes). Dimensões puxadas do
// Factory (materials.width/height), revisadas 2026-07-24. `adaptavel` = tem máscara.
interface Mask { w: number; h: number; vol?: string; } // vol = volumetria (ml), quando aplicável
interface Produto { key: string; label: string; cat: string; masks: Mask[]; }
const m = (w: number, h: number, vol?: string): Mask => (vol ? { w, h, vol } : { w, h });
const PRODUTOS: Produto[] = [
  { key: 'capinha', label: 'Capinha', cat: 'Case', masks: [] },
  { key: 'garrafa-fresh', label: 'Garrafa Fresh', cat: 'Térmicos', masks: [m(2754, 2340, '650'), m(3380, 2114, '950')] },
  { key: 'garrafa-urban', label: 'Garrafa Urban', cat: 'Térmicos', masks: [m(2672, 1465, '500')] },
  { key: 'garrafa-mini', label: 'Garrafa Mini', cat: 'Térmicos', masks: [m(2754, 1335, '350')] },
  { key: 'garrafa-fun', label: 'Garrafa Fun', cat: 'Térmicos', masks: [m(2783, 1524)] },
  { key: 'copo-life', label: 'Copo Life', cat: 'Térmicos', masks: [m(3488, 1890, '600'), m(3495, 2384, '880'), m(3827, 2598, '1180')] },
  { key: 'copo-vibe', label: 'Copo Térmico', cat: 'Térmicos', masks: [m(3512, 1441, '470'), m(2672, 1465)] },
  { key: 'garrafa-flip', label: 'Garrafa Flip', cat: 'Térmicos', masks: [m(2915, 2102, '750'), m(2754, 2340, '750')] },
  { key: 'garrafa-magsafe', label: 'Garrafa Magsafe', cat: 'Térmicos', masks: [m(2915, 2102, '750'), m(2754, 2340, '650')] },
  { key: 'tote-daily', label: 'Tote Daily', cat: 'Têxteis', masks: [m(2244, 1831)] },
  { key: 'tote-mini', label: 'Tote Mini', cat: 'Têxteis', masks: [m(2126, 1654)] },
  { key: 'tote-pop', label: 'Tote Pop', cat: 'Têxteis', masks: [] },
  { key: 'mala-trip', label: 'Mala Trip', cat: 'Têxteis', masks: [m(3567, 850)] },
  { key: 'mochila-pop', label: 'Mochila Pop', cat: 'Têxteis', masks: [m(2126, 1772)] },
  { key: 'mochila-fun', label: 'Mochila Fun', cat: 'Têxteis', masks: [m(6297, 5411)] },
  { key: 'necessaire-makeup-double', label: 'Necessaire Makeup Double', cat: 'Têxteis', masks: [m(2296, 831)] },
  { key: 'bolsa-garrafa', label: 'Bolsa de Garrafa', cat: 'Têxteis', masks: [m(1535, 2008)] },
];

// Mapeia produto (chave do PRODUTOS acima) -> nome/código usados na planilha OFICIAL de
// Futebol (aba "Térmicos"). Só entra em jogo quando categoria=Térmicos + segmento=futebol.
// "copo-vibe" (rótulo interno "Copo Térmico") foi mapeado para "Cerveja" por inferência —
// é o nome usado pra esse mesmo copo nas ~700 linhas históricas da planilha oficial (código
// "ct"); os demais garrafa-fun/Kids não têm equivalente na planilha oficial hoje, ficam de fora.
const PRODUTO_KEY_TO_OFICIAL: Record<string, { label: string; code: string }> = {
  'garrafa-fresh': { label: 'Fresh', code: 'gf' },
  'garrafa-urban': { label: 'Urban', code: 'gu' },
  'garrafa-mini': { label: 'Mini', code: 'gm' },
  'copo-life': { label: 'Life', code: 'cl' },
  'copo-vibe': { label: 'Cerveja', code: 'ct' },
  'garrafa-flip': { label: 'Flip Pro', code: 'gfp' },
  'garrafa-magsafe': { label: 'Magsafe', code: 'gms' },
};

// Classifica um produto (por nome/tipo) em uma key do registro. Usado no SQL.
// Classificação por NOME real no catálogo (revisado 2026-07-24 contra spree_products).
// Ordem importa: linhas mais específicas antes das genéricas (ex: Copo Térmico Life/Vibe
// antes do "Copo Térmico" plano).
// n() = nome normalizado: minúsculo e SEM espaços nas pontas (muitos nomes vêm com
// espaço inicial no catálogo, ex " Tote Mini - Futurist", que quebrava o LIKE ancorado).
const CLASSIFY_SQL = `CASE
  WHEN p.product_type_code='case' THEN 'capinha'
  WHEN lower(btrim(p.name)) LIKE 'garrafa térmica fresh%' THEN 'garrafa-fresh'
  WHEN lower(btrim(p.name)) LIKE 'garrafa térmica urban%' THEN 'garrafa-urban'
  WHEN lower(btrim(p.name)) LIKE 'garrafa térmica mini%' THEN 'garrafa-mini'
  WHEN lower(btrim(p.name)) LIKE 'garrafa térmica fun%' THEN 'garrafa-fun'
  WHEN lower(btrim(p.name)) LIKE 'garrafa térmica flip%' THEN 'garrafa-flip'
  WHEN lower(btrim(p.name)) LIKE 'garrafa térmica magsafe%' THEN 'garrafa-magsafe'
  WHEN lower(btrim(p.name)) LIKE 'copo térmico life%' THEN 'copo-life'
  WHEN lower(btrim(p.name)) LIKE 'copo térmico vibe%' OR lower(btrim(p.name)) LIKE 'copo térmico -%' OR lower(btrim(p.name)) LIKE 'copo térmico + ebook%' THEN 'copo-vibe'
  WHEN lower(btrim(p.name)) LIKE 'tote daily%' OR lower(btrim(p.name)) LIKE 'totebag daily%' THEN 'tote-daily'
  WHEN lower(btrim(p.name)) LIKE 'tote mini%' THEN 'tote-mini'
  WHEN lower(btrim(p.name)) LIKE 'tote pop%' THEN 'tote-pop'
  WHEN lower(btrim(p.name)) LIKE 'mala%trip%' THEN 'mala-trip'
  WHEN lower(btrim(p.name)) LIKE 'mochila pop%' THEN 'mochila-pop'
  WHEN lower(btrim(p.name)) LIKE 'mochila fun%' THEN 'mochila-fun'
  WHEN lower(btrim(p.name)) LIKE '%makeup double%' THEN 'necessaire-makeup-double'
  WHEN lower(btrim(p.name)) LIKE 'bolsa%garrafa%' THEN 'bolsa-garrafa'
  ELSE NULL END`;

/** Roda um SELECT no banco Site via proxy Metabase-direct (cookie do visitante). */
async function sqlQuery(env: Env, cookie: string, sql: string): Promise<Record<string, unknown>[]> {
  const r = await fetch(`${env.PROXY_BASE_URL}/site/_query`, {
    method: 'POST',
    headers: { Cookie: cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ sql }),
  });
  if (r.status === 401) throw new Error('not_authenticated');
  const t = await r.text();
  if (!r.ok) throw new Error(`query HTTP ${r.status}: ${t.slice(0, 200)}`);
  return (JSON.parse(t).rows as Record<string, unknown>[]) || [];
}

/** Roda um SELECT no Catalog (Prisma, db 19) via API do Metabase (secret METABASE_TOKEN). */
async function metabaseQuery(env: Env, sql: string, database = 19): Promise<Record<string, unknown>[]> {
  const base = (env.METABASE_URL || 'https://metabase.gocase.com.br').replace(/\/$/, '');
  const res = await fetch(`${base}/api/dataset`, {
    method: 'POST',
    headers: { 'x-api-key': env.METABASE_TOKEN as string, 'content-type': 'application/json' },
    body: JSON.stringify({ database, type: 'native', native: { query: sql } }),
  });
  if (!res.ok) throw new Error(`metabase HTTP ${res.status}: ${(await res.text()).slice(0, 150)}`);
  const j = (await res.json()) as { data?: { cols?: { name: string }[]; rows?: unknown[][] } };
  const cols = (j.data?.cols || []).map((c) => c.name);
  return (j.data?.rows || []).map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i]])));
}

// Mapeia o "group" do Catalog (ex "Mochila-Pop---CLARO") para uma key do registro PRODUTOS.
function groupToKey(g: unknown): string | null {
  if (!g) return null;
  const s = String(g).toLowerCase().replace(/-/g, ' ');
  if (s.includes('mochila pop')) return 'mochila-pop';
  if (s.includes('mochila fun')) return 'mochila-fun';
  if (s.includes('bolsa garrafa') || s.includes('bolsa de garrafa')) return 'bolsa-garrafa';
  if (s.includes('tote daily') || s.includes('totebag daily')) return 'tote-daily';
  if (s.includes('tote mini')) return 'tote-mini';
  if (s.includes('tote pop')) return 'tote-pop';
  if (s.includes('mala') && s.includes('trip')) return 'mala-trip';
  if (s.includes('makeup') && s.includes('double')) return 'necessaire-makeup-double';
  if (s.includes('garrafa') && s.includes('fresh')) return 'garrafa-fresh';
  if (s.includes('garrafa') && s.includes('urban')) return 'garrafa-urban';
  if (s.includes('garrafa') && s.includes('mini')) return 'garrafa-mini';
  if (s.includes('garrafa') && s.includes('fun')) return 'garrafa-fun';
  if (s.includes('garrafa') && s.includes('flip')) return 'garrafa-flip';
  if (s.includes('garrafa') && s.includes('magsafe')) return 'garrafa-magsafe';
  if (s.includes('copo') && s.includes('life')) return 'copo-life';
  if (s.includes('copo')) return 'copo-vibe';
  if (s.includes('case') || s.includes('capinha')) return 'capinha';
  return null;
}

// De-slugifica o identifier p/ exibição (tira o sufixo de segmento e capitaliza).
function prettyIdentifier(id: string): string {
  return id.replace(/-(texteis|têxteis|case|mala|termicos?|térmicos?)$/i, '')
    .split('-').filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    try {
      // Lista o registro de produtos (para o cliente montar o checklist).
      if (pathname === '/api/estampas/produtos') {
        return json({ produtos: PRODUTOS });
      }

      // Registro de produtos + máscaras (fonte única para a aba "Adaptar imagem").
      if (pathname === '/api/produtos') {
        return json({ produtos: PRODUTOS.map((p) => ({ key: p.key, label: p.label, cat: p.cat, masks: p.masks })) });
      }

      // Sugere 3 nomes para a estampa (Etapa 0 da aba "Adaptar PSD"), a partir do
      // preview flatten do PSD + categoria/segmento/tag escolhidos pelo usuário.
      if (pathname === '/api/estampas/gerar-nome' && request.method === 'POST') {
        const body = (await request.json()) as {
          imageBase64?: string; categoria?: string; segmento?: string; tag?: string; evitar?: string[];
        };
        if (!body.imageBase64) return json({ error: 'imageBase64 obrigatório' }, 400);
        const nomes = await sugerirNomesEstampa(env, body.imageBase64, {
          categoria: body.categoria || '',
          segmento: body.segmento || '',
          tag: body.tag || '',
          evitar: Array.isArray(body.evitar) ? body.evitar.map(String) : [],
        });
        return json({ nomes });
      }

      // Aprova o nome da estampa (categoria/segmento/tag/nome + quem cadastrou) — cria (ou,
      // se já existir registroId, atualiza) a "nomeação". Sem PSD ("Adicionar imagem"), não
      // existe etapa de adaptar: já registra o único item na hora. Com PSD, só o "cabeçalho"
      // (identifier base) é salvo aqui — cada item vira uma linha depois, em /registrar-item,
      // no momento em que o usuário baixar o PNG daquele produto/tamanho.
      if (pathname === '/api/estampas/aprovar-nome' && request.method === 'POST') {
        const body = (await request.json()) as {
          registroId?: number; categoria?: string; segmento?: string; tag?: string; nome?: string;
          arquivoNome?: string; temAdaptacao?: boolean;
        };
        if (!body.categoria || !body.segmento || !body.nome) {
          return json({ error: 'categoria, segmento e nome são obrigatórios' }, 400);
        }
        await ensureRegistrosTable(env);
        const userEmail = request.headers.get('x-godeploy-user-email') || null;
        const userName = displayNameFromEmail(userEmail);

        let registroId = body.registroId;
        let identifier: string;
        if (registroId != null) {
          // Reaprovação (usuário voltou pra editar nome/categoria) — atualiza a mesma linha
          // em vez de duplicar. Só gera um identifier novo se o nome mudou de fato.
          const base = slugify(body.nome);
          const existing = await env.DB.query('SELECT identifier FROM registros_estampas WHERE id = ?', [registroId]);
          const prevIdentifier = String(existing.rows[0]?.identifier || '');
          const prevBase = prevIdentifier.replace(/-\d+$/, '');
          identifier = prevIdentifier && base === prevBase ? prevIdentifier : await identifierUnico(env, base);
          await env.DB.exec(
            `UPDATE registros_estampas SET categoria=?, segmento=?, tag=?, nome=?, arquivo_nome=?, identifier=? WHERE id=?`,
            [body.categoria, body.segmento, body.tag || null, body.nome, body.arquivoNome || null, identifier, registroId],
          );
        } else {
          const createdAt = new Date().toISOString();
          identifier = await identifierUnico(env, slugify(body.nome));
          await env.DB.exec(
            `INSERT INTO registros_estampas (created_at, user_email, categoria, segmento, tag, nome, arquivo_nome, identifier)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [createdAt, userEmail, body.categoria, body.segmento, body.tag || null, body.nome, body.arquivoNome || null, identifier],
          );
          const idRes = await env.DB.query('SELECT last_insert_rowid() AS id', []);
          registroId = idRes.rows[0]?.id as number | undefined;
        }

        let item: RegistrarItemResult | undefined;
        if (!body.temAdaptacao && registroId != null) {
          const catSlug = CATEGORIA_SLUG[body.categoria] || slugify(body.categoria);
          const sku = `${identifier} - ${catSlug}`;
          item = await registrarItemInterno(env, {
            registroId, categoria: body.categoria, segmento: body.segmento, tag: body.tag || '',
            nome: body.nome, userEmail, userName, produtoKey: null, produtoLabel: body.categoria,
            identifier, sku, arquivoNome: body.arquivoNome || '',
          });
        }

        return json({
          ok: true, registroId, userEmail, userName, identifier,
          sku: item?.sku ?? null, sheetSynced: item ? item.sheetSynced : null, sheetError: item?.sheetError ?? null,
          oficialFutebol: item?.oficialFutebol ?? null,
        });
      }

      // Registra UM item adaptado (produto/tamanho) — chamado a cada download de PNG na
      // etapa de Adaptar. identifier/sku vêm do cliente (sugeridos automaticamente lá, mas
      // editáveis antes de baixar) — aqui só persistimos e sincronizamos, sem recalcular.
      if (pathname === '/api/estampas/registrar-item' && request.method === 'POST') {
        const body = (await request.json()) as {
          registroId?: number; produtoKey?: string; produtoLabel?: string; identifier?: string; sku?: string;
        };
        if (!body.registroId || !body.produtoLabel || !body.identifier || !body.sku) {
          return json({ error: 'registroId, produtoLabel, identifier e sku são obrigatórios' }, 400);
        }
        await ensureRegistrosTable(env);
        const parent = await env.DB.query('SELECT * FROM registros_estampas WHERE id = ?', [body.registroId]);
        const p = parent.rows[0];
        if (!p) return json({ error: 'nomeação não encontrada — aprove o nome de novo' }, 404);
        const userEmail = request.headers.get('x-godeploy-user-email') || (p.user_email as string | null) || null;
        const userName = displayNameFromEmail(userEmail);
        const result = await registrarItemInterno(env, {
          registroId: body.registroId, categoria: String(p.categoria), segmento: String(p.segmento),
          tag: String(p.tag || ''), nome: String(p.nome), userEmail, userName,
          produtoKey: body.produtoKey || null, produtoLabel: body.produtoLabel,
          identifier: body.identifier, sku: body.sku, arquivoNome: String(p.arquivo_nome || ''),
        });
        return json({ ok: true, ...result });
      }

      // Histórico dos últimos registros (auditoria simples), com os itens de cada um.
      if (pathname === '/api/estampas/registros' && request.method === 'GET') {
        await ensureRegistrosTable(env);
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
        const r = await env.DB.query(
          `SELECT id, created_at, user_email, categoria, segmento, tag, nome, identifier, arquivo_nome
           FROM registros_estampas ORDER BY id DESC LIMIT ?`,
          [limit],
        );
        const ids = r.rows.map((row) => row.id).filter((id) => id != null);
        const itensPorRegistro: Record<string, unknown[]> = {};
        if (ids.length) {
          const placeholders = ids.map(() => '?').join(',');
          const itensRes = await env.DB.query(
            `SELECT * FROM registros_itens WHERE registro_id IN (${placeholders}) ORDER BY id ASC`,
            ids,
          );
          for (const it of itensRes.rows) {
            const key = String(it.registro_id);
            (itensPorRegistro[key] || (itensPorRegistro[key] = [])).push(it);
          }
        }
        const registros = r.rows.map((row) => ({
          ...row, user_name: displayNameFromEmail(row.user_email as string),
          itens: itensPorRegistro[String(row.id)] || [],
        }));
        return json({ registros });
      }

      // Reenvia pras planilhas os itens que ficaram pendentes (sheet_synced=0, e o mesmo pra
      // oficial_futebol_synced quando aplicável) — útil depois de configurar credenciais ou
      // depois de uma falha transitória (rede, token expirado etc.).
      if (pathname === '/api/estampas/resync-planilha' && request.method === 'POST') {
        await ensureRegistrosTable(env);
        const pending = await env.DB.query(
          `SELECT i.*, e.categoria, e.segmento, e.tag, e.nome, e.user_email, e.arquivo_nome
             FROM registros_itens i JOIN registros_estampas e ON e.id = i.registro_id
            WHERE i.sheet_synced = 0 ORDER BY i.id ASC LIMIT 100`, [],
        );
        let ok = 0;
        const erros: { id: unknown; error: string }[] = [];
        for (const r of pending.rows) {
          try {
            await registrarNaPlanilha(env, {
              createdAt: String(r.created_at), userEmail: (r.user_email as string) || null,
              categoria: String(r.categoria), segmento: String(r.segmento), tag: String(r.tag || ''),
              produto: String(r.produto_label), nome: String(r.nome), identifier: String(r.identifier),
              sku: String(r.sku), arquivoNome: String(r.arquivo_nome || ''),
            });
            await env.DB.exec('UPDATE registros_itens SET sheet_synced = 1 WHERE id = ?', [r.id]);
            ok++;
          } catch (e) {
            erros.push({ id: r.id, error: String((e as Error).message || e) });
          }
        }

        const pendingOficial = await env.DB.query(
          `SELECT i.*, e.tag, e.nome, e.user_email
             FROM registros_itens i JOIN registros_estampas e ON e.id = i.registro_id
            WHERE i.oficial_futebol_aplicavel = 1 AND i.oficial_futebol_synced = 0 ORDER BY i.id ASC LIMIT 100`, [],
        );
        let okOficial = 0;
        const errosOficial: { id: unknown; error: string }[] = [];
        for (const r of pendingOficial.rows) {
          try {
            const oficial = PRODUTO_KEY_TO_OFICIAL[String(r.produto_key)];
            await gravarOficialFutebolTermicos(env, {
              clube: String(r.tag || ''), produto: oficial ? oficial.label : String(r.produto_label),
              ilustrador: displayNameFromEmail((r.user_email as string) || ''), nome: String(r.nome),
              identifier: String(r.identifier), sku: String(r.sku), dataCadastro: String(r.created_at).slice(0, 10),
            });
            await env.DB.exec('UPDATE registros_itens SET oficial_futebol_synced = 1 WHERE id = ?', [r.id]);
            okOficial++;
          } catch (e) {
            errosOficial.push({ id: r.id, error: String((e as Error).message || e) });
          }
        }
        return json({
          tentativas: pending.rows.length, ok, erros,
          oficialFutebol: { tentativas: pendingOficial.rows.length, ok: okOficial, erros: errosOficial },
        });
      }

      // Top-15 estampas de UMA categoria-fonte, em unidades nos últimos N dias.
      if (pathname === '/api/estampas/top') {
        const cookie = request.headers.get('cookie') ?? '';
        const dias = Math.min(365, Math.max(1, Number(url.searchParams.get('dias')) || 90));
        const CATS: Record<string, { cond: string; design: string }> = {
          'Capinha': { cond: "p.product_type_code='case'", design: 'btrim(p.name)' },
          'Garrafa Fresh': { cond: "p.name ILIKE 'Garrafa Térmica Fresh%'", design: "btrim(regexp_replace(p.name,'^\\s*Garrafa Térmica Fresh( \\+ Ebook)?\\s*-\\s*',''))" },
          'Tote Daily': { cond: "p.name ILIKE 'Tote Daily%'", design: "btrim(regexp_replace(p.name,'^\\s*Tote Daily\\s*-\\s*',''))" },
        };
        const cat = url.searchParams.get('cat') || 'Capinha';
        const def = CATS[cat];
        if (!def) return json({ error: 'categoria inválida' }, 400);
        const sql = `
WITH base AS (
  SELECT ${def.design} AS design, cps.total_sales AS q
  FROM consolidated_product_sales cps
  JOIN spree_products p ON p.id=cps.product_id
  WHERE cps.date >= CURRENT_DATE - INTERVAL '${dias} days' AND p.deleted_at IS NULL
    AND ${def.cond} AND COALESCE(${def.design},'')<>''
    AND lower(btrim(${def.design})) NOT IN ('personalize com sua foto','bold magsafe')
),
agg AS (
  SELECT design, SUM(q) AS unidades, ROW_NUMBER() OVER (ORDER BY SUM(q) DESC) AS rn
  FROM base GROUP BY design
)
SELECT design, unidades FROM agg WHERE rn<=15 ORDER BY unidades DESC`;
        const rows = await sqlQuery(env, cookie, sql);

        // Cobertura de TODAS as estampas do ranking numa query só.
        const designs = [...new Set(rows.map((r) => String(r.design)))];
        const needleOf = (d: string) => d.toLowerCase().trim();
        const presentesPorNeedle: Record<string, Set<string>> = {};
        if (designs.length) {
          const values = designs
            .map((d) => {
              const n = needleOf(d).replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/[%_]/g, (m) => '\\' + m);
              return `('${n}')`;
            })
            .join(',');
          const covSql = `
WITH est(needle) AS (VALUES ${values}),
prods AS (
  SELECT DISTINCT ${CLASSIFY_SQL} AS pk, lower(btrim(p.name)) AS nm
  FROM spree_products p
  WHERE p.deleted_at IS NULL AND p.name IS NOT NULL AND (${CLASSIFY_SQL}) IS NOT NULL
)
SELECT e.needle, prods.pk
FROM est e JOIN prods ON prods.nm LIKE ('%' || e.needle || '%') ESCAPE '\\'
GROUP BY e.needle, prods.pk`;
          try {
            const cov = await sqlQuery(env, cookie, covSql);
            for (const r of cov) {
              const n = String(r.needle);
              (presentesPorNeedle[n] ||= new Set()).add(String(r.pk));
            }
          } catch { /* cobertura indisponível: segue sem checklist */ }
        }

        const montaEstampa = (design: string, unidades: number) => {
          const pres = presentesPorNeedle[needleOf(design)] || new Set<string>();
          const checklist = PRODUTOS.map((p) => ({ ...p, adaptavel: p.masks.length > 0, presente: pres.has(p.key) }));
          return {
            design,
            unidades,
            checklist,
            nPresente: checklist.filter((c) => c.presente).length,
            nFalta: checklist.filter((c) => !c.presente).length,
          };
        };

        const estampas = rows.map((r) => montaEstampa(String(r.design), Number(r.unidades)));
        return json({ dias, categoria: cat, totalProdutos: PRODUTOS.length, estampas });
      }

      // Cobertura de UMA estampa: em quais produtos do registro ela já existe.
      if (pathname === '/api/estampas/coverage') {
        const cookie = request.headers.get('cookie') ?? '';
        const e = (url.searchParams.get('e') || '').trim().toLowerCase();
        if (!e) return json({ error: 'parâmetro e obrigatório' }, 400);
        const safe = e.replace(/'/g, "''").replace(/[%_\\]/g, (m) => '\\' + m);
        const sql = `
SELECT ${CLASSIFY_SQL} AS produto
FROM spree_products p
WHERE p.deleted_at IS NULL AND p.name IS NOT NULL
  AND lower(btrim(p.name)) LIKE '%${safe}%'
GROUP BY 1`;
        const rows = await sqlQuery(env, cookie, sql);
        const presentes = new Set(rows.map((r) => r.produto).filter(Boolean) as string[]);
        return json({
          estampa: e,
          checklist: PRODUTOS.map((p) => ({ ...p, adaptavel: p.masks.length > 0, presente: presentes.has(p.key) })),
        });
      }

      // Imagem de referência (arte da estampa) via Prisma render: extrai o stamp de
      // velociraptor_products.image_br para uma capinha com o design informado (banco Site).
      if (pathname === '/api/estampas/refimg') {
        const cookie = request.headers.get('cookie') ?? '';
        const e = (url.searchParams.get('e') || '').trim();
        if (!e) return json({ error: 'parâmetro e obrigatório' }, 400);
        const safe = e.replace(/'/g, "''");
        const stampExpr = "SPLIT_PART(SPLIT_PART(vp.image_br, 'stamp=', 2), '&', 1)";
        const sql = `
SELECT 'https://custom-case-images.s3.amazonaws.com/' || ${stampExpr} AS img
FROM spree_products p
JOIN spree_product_translations pt ON pt.spree_product_id = p.id AND pt.locale = 'pt-BR'
JOIN velociraptor_products vp ON vp.spree_product_id = p.id
WHERE p.product_type_code = 'case' AND p.deleted_at IS NULL
  AND vp.image_br LIKE '%stamp=%' AND ${stampExpr} <> ''
  AND lower(btrim(pt.name)) = lower(btrim('${safe}'))
ORDER BY p.id DESC
LIMIT 1`;
        const rows = await sqlQuery(env, cookie, sql);
        const refUrl = rows[0]?.img as string | undefined;
        if (!refUrl) return json({ error: 'não encontrei a arte dessa estampa no catálogo' }, 404);
        return json({ refUrl });
      }

      // Resolve um produto por ID (spree_products.id) ou SKU → estampa + info + cobertura.
      if (pathname === '/api/estampas/byid') {
        const cookie = request.headers.get('cookie') ?? '';
        const id = (url.searchParams.get('id') || '').trim();
        if (!id) return json({ error: 'id obrigatório' }, 400);
        const safe = id.replace(/'/g, "''");
        const isNum = /^\d+$/.test(id);
        // design = estampa: para case é o próprio nome; para os demais, tira o prefixo "Produto - ".
        const designExpr =
          "CASE WHEN p.product_type_code='case' OR position(' - ' in pt.name)=0 " +
          "THEN btrim(pt.name) ELSE btrim(substring(pt.name from position(' - ' in pt.name)+3)) END";
        const sql = `
SELECT p.id, p.name AS produto, p.product_type_code AS tipo, ${designExpr} AS design,
       CONCAT('https://gocase.com.br/', (vp.slug ->> 'pt-BR'), '/p') AS link
FROM spree_products p
JOIN spree_product_translations pt ON pt.spree_product_id = p.id AND pt.locale = 'pt-BR'
LEFT JOIN velociraptor_products vp ON vp.spree_product_id = p.id
WHERE p.deleted_at IS NULL AND COALESCE(btrim(p.name),'') <> '' AND (
  ${isNum ? `p.id = ${id} OR ` : ''}
  lower(btrim(vp.engine_identifier)) = lower(btrim('${safe}'))
  OR EXISTS (SELECT 1 FROM spree_variants v WHERE v.product_id = p.id AND lower(btrim(v.sku)) = lower(btrim('${safe}')))
)
ORDER BY p.id DESC LIMIT 1`;
        const rows = await sqlQuery(env, cookie, sql);
        if (!rows.length) {
          // Fallback: identifier que só existe no Catalog (Prisma) — via API do Metabase.
          if (env.METABASE_TOKEN && !isNum) {
            try {
              const catRows = await metabaseQuery(env,
                `SELECT id, identifier, "group", preview_pt, preview FROM design_customizations
                 WHERE deleted_at IS NULL AND active = true AND lower(btrim(identifier)) = lower(btrim('${safe}'))
                 ORDER BY id`);
              if (catRows.length) {
                const baseRow = catRows.find((c) => !c.group) || catRows[0];
                const refUrl = (baseRow.preview_pt || baseRow.preview) as string;
                const presentesCat = new Set<string>();
                for (const c of catRows) { const k = groupToKey(c.group); if (k) presentesCat.add(k); }
                return json({
                  source: 'catalog', id, produto: id, tipo: 'catalog (Prisma)', link: null,
                  design: prettyIdentifier(id), refUrl,
                  checklist: PRODUTOS.map((p) => ({ ...p, adaptavel: p.masks.length > 0, presente: presentesCat.has(p.key) })),
                });
              }
            } catch (e) { console.log('catalog lookup falhou:', String((e as Error).message || e)); }
          }
          return json({ error: 'produto/identifier não encontrado (nem no Site nem no Catalog)' }, 404);
        }
        const r = rows[0];
        const design = String(r.design || '').trim();
        // cobertura da estampa (mesma lógica da aba Estampas)
        const safeE = design.toLowerCase().replace(/'/g, "''").replace(/[%_\\]/g, (mm) => '\\' + mm);
        const covRows = await sqlQuery(env, cookie,
          `SELECT ${CLASSIFY_SQL} AS produto FROM spree_products p
           WHERE p.deleted_at IS NULL AND p.name IS NOT NULL AND lower(btrim(p.name)) LIKE '%${safeE}%' GROUP BY 1`);
        const presentes = new Set(covRows.map((c) => c.produto).filter(Boolean) as string[]);
        return json({
          id: r.id, produto: r.produto, tipo: r.tipo, link: r.link, design,
          checklist: PRODUTOS.map((p) => ({ ...p, adaptavel: p.masks.length > 0, presente: presentes.has(p.key) })),
        });
      }

      if (!env.PIAPP_TOKEN && pathname.startsWith('/api')) {
        return json({ error: 'PIAPP_TOKEN não configurado' }, 500);
      }

      // Passo 1: sobe a referência e descreve a imagem (uma vez por upload).
      if (pathname === '/api/prepare' && request.method === 'POST') {
        const body = (await request.json()) as { imageBase64?: string };
        if (!body.imageBase64) return json({ error: 'imageBase64 obrigatório' }, 400);
        const [refUrl, desc] = await Promise.all([
          uploadReference(env, body.imageBase64),
          describeImage(env, body.imageBase64),
        ]);
        return json({ refUrl, desc });
      }

      // Passo 2: dispara uma geração para um preset (aspect escolhido no cliente).
      if (pathname === '/api/generate' && request.method === 'POST') {
        const body = (await request.json()) as { refUrl?: string; aspect?: string; desc?: string; seg?: string; tipo?: string };
        if (!body.refUrl || !body.aspect) return json({ error: 'refUrl e aspect obrigatórios' }, 400);
        const prompt = buildPrompt(body.aspect, body.desc || '', body.seg || '', body.tipo || '');
        const jobId = await piappGenerate(env, body.refUrl, body.aspect, prompt);
        return json({ jobId });
      }

      // Passo 3: polling do job.
      if (pathname === '/api/status') {
        const jobId = url.searchParams.get('job');
        if (!jobId) return json({ error: 'job obrigatório' }, 400);
        const s = await piappJob(env, jobId);
        return json({ status: s.status, ready: s.status === 'completed' && !!s.output_url, error: s.error });
      }

      // Serve os bytes da imagem gerada pelo mesmo origin (evita canvas "tainted").
      if (pathname === '/img') {
        // Serve a imagem gerada como está (fundo sólido). A remoção de fundo é feita
        // no cliente, em resolução total (flood-fill), sem perda de qualidade.
        const jobId = url.searchParams.get('job');
        if (!jobId) return new Response('job obrigatório', { status: 400 });
        const s = await piappJob(env, jobId);
        if (s.status !== 'completed' || !s.output_url) return new Response('not ready', { status: 404 });
        const img = await fetch(s.output_url);
        if (!img.ok) return new Response('fetch falhou', { status: 502 });
        return new Response(img.body, {
          headers: {
            'content-type': img.headers.get('content-type') || 'image/png',
            'cache-control': 'public, max-age=3600',
          },
        });
      }
    } catch (e) {
      return json({ error: String((e as Error).message || e) }, 500);
    }
    return new Response('Not found', { status: 404 });
  },
};
