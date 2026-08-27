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
  // ---- RPA de cadastro no Catalog v3 (aba "Cadastrar estampas") ----
  GITHUB_TOKEN?: string;        // token com acesso ao repo do robô (Actions + conteúdo)
  GITHUB_REPO?: string;         // "owner/repo" do robô
  GITHUB_REF?: string;          // branch do código (default: main)
  GITHUB_WORKFLOW?: string;     // arquivo do workflow (default: cadastrar-estampas.yml)
  RPA_TOKEN?: string;           // segredo compartilhado: só o robô pode reportar progresso
  DB: Db;
}

function json(body: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(extraHeaders || {}) },
  });
}

/* ==================== Rastro das rotas do robô ====================
 *
 * O outro lado desta integração (o robô, no GitHub Actions) tem um rastro
 * detalhado. Sem o mesmo aqui, metade da conversa fica invisível: quando um
 * lote trava, não dava pra saber se o robô não pediu, se o app não respondeu,
 * ou se respondeu errado.
 *
 * Sai no `console.log` do Worker (visível no GoDeploy). Vale a MESMA regra do
 * lado do robô: nome do campo sim, valor de credencial nunca. Aqui isso é
 * ainda mais importante porque o corpo das chamadas carrega imagem em base64
 * -- logar corpo inteiro entupiria o log e não ajudaria ninguém.
 */
const CAMPOS_SENSIVEIS = /token|secret|senha|password|auth|cookie|key|chave|b64|dados/i;

/** Mantém os NOMES dos parâmetros e esconde os valores sensíveis. */
function queryLimpa(url: URL): string {
  const partes: string[] = [];
  url.searchParams.forEach((valor, nome) => {
    partes.push(CAMPOS_SENSIVEIS.test(nome) ? `${nome}=<${valor.length} chars>` : `${nome}=${valor}`);
  });
  return partes.join('&');
}

function traceRpa(evento: string, campos: Record<string, unknown>): void {
  try {
    const limpo: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(campos)) {
      limpo[k] = CAMPOS_SENSIVEIS.test(k)
        ? `<oculto ${String(v ?? '').length} chars>`
        : typeof v === 'string' && v.length > 300
          ? v.slice(0, 300) + `…(+${v.length - 300})`
          : v;
    }
    console.log('RPA ' + JSON.stringify({ evento, ...limpo }));
  } catch {
    // Log nunca derruba requisição.
  }
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

/**
 * Tags criadas pelo usuário na página "Criar Tag" (menu Ilustração). São a ÚNICA fonte das
 * opções de Coleção (categoria 'colecao') e Licenciado (categoria 'licenciado') no seletor de
 * Segmento — não há mais lista fixa no código. Futebol continua travado nos 18 times oficiais.
 * `nome_norm` (slug) existe só para impedir duplicata por acento/caixa ("Verão 2027" x "verao 2027").
 */
async function ensureTagsTable(env: Env): Promise<void> {
  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      user_email TEXT,
      categoria TEXT NOT NULL,
      nome TEXT NOT NULL,
      nome_norm TEXT NOT NULL
    )`,
    [],
  );
  await env.DB.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS tags_cat_nome ON tags (categoria, nome_norm)`,
    [],
  );
}

/**
 * Copys — biblioteca de textos ("copy") cadastrados de antemão, disponíveis para inserir como
 * elemento de texto no board de adaptação (Novo ID / Adaptar ID). Lista simples, sem categoria:
 * cor, tamanho e traçado são propriedades de CADA instância inserida no board, não do cadastro.
 * `texto_norm` existe só para impedir duplicata por espaço/caixa.
 */
// Seed único: legendas de copyright/marca registrada extraídas de "Copy_para_editar.psd" (Wellington,
// 2026-08-25) — as 11 camadas de texto do arquivo (o resto eram camadas raster). INSERT OR IGNORE
// é idempotente: não duplica em chamadas futuras, graças ao UNIQUE de texto_norm criado abaixo.
const COPYS_SEED = [
  '© MARVEL',
  '©Disney',
  '©Disney/Pixar',
  '©Mattel.',
  '©&™Lucasfilm Ltd',
  '© & ™ WBEI (s26)',
  '© & ™ HBO (s26)',
  '© & ™ DC. (s25)',
  '© & ™ CN. (s25)',
  '©2026 Paws, Inc.',
  '© 2026 &TM Spin Master Ltd.',
];
async function ensureCopysTable(env: Env): Promise<void> {
  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS copys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      user_email TEXT,
      texto TEXT NOT NULL,
      texto_norm TEXT NOT NULL
    )`,
    [],
  );
  await env.DB.exec(`CREATE UNIQUE INDEX IF NOT EXISTS copys_texto_norm ON copys (texto_norm)`, []);
  for (const texto of COPYS_SEED) {
    await env.DB.exec(
      `INSERT OR IGNORE INTO copys (created_at, user_email, texto, texto_norm) VALUES (?, ?, ?, ?)`,
      [new Date().toISOString(), null, texto, slugify(texto)],
    );
  }
}

/**
 * Alocação de um item JÁ EXISTENTE (achado na aba "Adaptar ID") numa tag. Diferente de
 * registros_estampas, que é a nomeação de uma estampa NOVA: aqui o produto já existe no
 * catálogo e só está sendo classificado. Uma alocação por item (o UNIQUE em item_ref faz o
 * upsert trocar a tag em vez de acumular histórico duplicado).
 */
async function ensureAlocacoesTable(env: Env): Promise<void> {
  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS itens_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      user_email TEXT,
      item_ref TEXT NOT NULL,
      produto TEXT,
      design TEXT,
      segmento TEXT NOT NULL,
      tag TEXT NOT NULL
    )`,
    [],
  );
  await env.DB.exec(`CREATE UNIQUE INDEX IF NOT EXISTS itens_tags_ref ON itens_tags (item_ref)`, []);
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

/* ===================================================================
   RPA — cadastro em lote de estampas no Catalog v3
   ===================================================================
   A tela aqui só monta o pedido; quem clica no Catalog é o robô Playwright,
   que roda no GitHub Actions (aqui dentro não existe navegador). O caminho:

     tela  ->  POST /api/rpa/lote            cria o lote (metadados)
           ->  POST /api/rpa/lote/imagem     PNG em pedaços, guardados no env.DB
           ->  POST /api/rpa/lote/disparar   só avisa o Actions ("roda o job X")
     robô  ->  GET  /api/rpa/job?job=        pega a receita do lote
           ->  GET  /api/rpa/imagem?job=&…   baixa cada PNG
           ->  POST /api/rpa/progresso       cada passo que ele dá
           ->  POST /api/rpa/finalizar       fim do lote (apaga as imagens)
     tela  ->  GET  /api/rpa/status?job=     pergunta de 2 em 2s e mostra ao vivo

   **As imagens nunca passam pelo GitHub.** Os repositórios são públicos, e
   arte da Gocase num repositório público fica exposta na internet -- e o git
   guarda o arquivo no histórico mesmo depois de apagado. Então os PNGs moram
   no banco do app (em pedaços, porque uma estampa passa fácil de 5MB) e o robô
   os baixa autenticado. O GitHub só recebe o id do lote.

   A sessão do Catalog NÃO passa por aqui: ela é um segredo do GitHub, usada
   só dentro do Actions. Este worker nunca vê credencial do Catalog.
*/

const RPA_MATERIAL_CASE = 'standard-iphone11';

const RPA_GRUPOS_POR_CATEGORIA: Record<string, string[]> = {
  case: ['Top Camera', '2/5-Center', '1/3-Left-Thin', '1/3-Left-Large', '1/3-Left-Center', '1/3-Center'],
  termico: [
    'Fresh 1200 - CLARO', 'Fresh 1200 - ESCURO', 'Fresh 350ml - Claro', 'Fresh 350ml - Escuro',
    'Fresh v2 650ml', 'Fresh v2 650ml - Escuro', 'Fresh v2 950ml', 'Fresh v2 950ml - Escuro',
    'Copo Vibe - Branco', 'Copo Vibe - Preto', 'Copo Life 880ml - Claro', 'Copo Life 880ml - Escuro',
    'Copo Life - Claro', 'Copo Life - Escuro', 'Urban 500ml', 'Urban 500ml - Escuro',
    'Garrafa Pro - 750ml - CLARO', 'Garrafa Pro - 750ml - ESCURO',
  ],
  textil: [], // ainda sem lista confirmada
};

const RPA_MATERIAIS_POR_CATEGORIA: Record<string, { label: string; value: string }[]> = {
  termico: [
    { label: 'Fresh 950ml - Claro', value: '360freshbrancav3-garrafafresh950' },
    { label: 'Fresh 950ml - Escuro', value: '360freshpretav3-garrafafresh950' },
    { label: 'Fresh 650ml - Claro', value: '360freshbrancav3-garrafafresh650' },
    { label: 'Fresh 650ml - Escuro', value: '360freshpretav3-garrafafresh650' },
    { label: 'Vibe 470ml - Claro', value: '360vibebranco-copovibe470' },
    { label: 'Vibe 470ml - Escuro', value: '360vibepreto-copovibe470' },
    { label: 'Life 880ml - Claro', value: '360lifebranco-copolife880' },
    { label: 'Life 880ml - Escuro', value: '360lifepreto-copolife880' },
    { label: 'Life 1180ml - Claro', value: '360lifebranco-copolife1180' },
    { label: 'Life 1180ml - Escuro', value: '360lifepreto-copolife1180' },
    { label: 'Urban 500ml - Claro', value: '360urbanbranca-garrafaurban500' },
    { label: 'Urban 500ml - Escuro', value: '360urbanpreta-garrafaurban500' },
    { label: 'Flip Pro - Claro', value: '360flipprobranco-360flippro' },
    { label: 'Flip Pro - Escuro', value: '360flippropreto-360flippro' },
  ],
  textil: [],
};

const RPA_STATUS_ABERTOS = ['montando', 'na_fila', 'rodando'];

async function ensureRpaTables(env: Env): Promise<void> {
  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS rpa_jobs (
      job_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      user_email TEXT,
      status TEXT NOT NULL,
      total INTEGER NOT NULL DEFAULT 0,
      element_type TEXT,
      erro TEXT,
      finished_at TEXT,
      run_url TEXT
    )`,
    [],
  );
  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS rpa_estampas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      ordem INTEGER NOT NULL,
      identifier TEXT NOT NULL,
      arquivo TEXT NOT NULL,
      categoria TEXT NOT NULL,
      material TEXT,
      grupos TEXT,
      rapport INTEGER NOT NULL DEFAULT 0,
      nome_fonte TEXT,
      tamanho_fonte TEXT,
      cor_fonte TEXT,
      enviada INTEGER NOT NULL DEFAULT 0
    )`,
    [],
  );
  await env.DB.exec(`CREATE INDEX IF NOT EXISTS rpa_estampas_job ON rpa_estampas (job_id, ordem)`, []);
  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS rpa_eventos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      at TEXT NOT NULL DEFAULT (datetime('now')),
      identifier TEXT,
      status TEXT,
      message TEXT
    )`,
    [],
  );
  await env.DB.exec(`CREATE INDEX IF NOT EXISTS rpa_eventos_job ON rpa_eventos (job_id, id)`, []);
  // Os PNGs entram em pedaços (uma estampa passa fácil de 5MB, e linha gigante
  // de SQLite é pedir problema). Apagados quando o lote termina.
  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS rpa_imagens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      arquivo TEXT NOT NULL,
      parte INTEGER NOT NULL,
      total_partes INTEGER NOT NULL,
      dados TEXT NOT NULL
    )`,
    [],
  );
  await env.DB.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS rpa_imagens_parte ON rpa_imagens (job_id, arquivo, parte)`,
    [],
  );
}

function rpaGhHeaders(env: Env): Record<string, string> {
  return {
    authorization: `Bearer ${env.GITHUB_TOKEN}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'gerador-de-adaptacoes-rpa',
    'content-type': 'application/json',
  };
}

function rpaGhConfig(env: Env) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) {
    throw new Error('O robô não está configurado: faltam os segredos GITHUB_TOKEN e/ou GITHUB_REPO.');
  }
  return {
    repo: env.GITHUB_REPO,
    ref: env.GITHUB_REF || 'main',
    workflow: env.GITHUB_WORKFLOW || 'cadastrar-estampas.yml',
  };
}

/** Junta os pedaços de um PNG guardado no banco. Devolve null se faltar pedaço. */
async function rpaMontarImagem(env: Env, jobId: string, arquivo: string): Promise<Uint8Array | null> {
  const r = await env.DB.query(
    `SELECT parte, total_partes, dados FROM rpa_imagens
       WHERE job_id = ? AND arquivo = ? ORDER BY parte`,
    [jobId, arquivo],
  );
  if (!r.rows.length) return null;
  const total = Number(r.rows[0].total_partes);
  if (r.rows.length !== total) return null;

  const b64 = r.rows.map((row) => String(row.dados)).join('');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function rpaGhDispatch(env: Env, jobId: string): Promise<string> {
  const { repo, ref, workflow } = rpaGhConfig(env);
  const r = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
    method: 'POST',
    headers: rpaGhHeaders(env),
    body: JSON.stringify({ ref, inputs: { job_id: jobId } }),
  });
  if (!r.ok) throw new Error(`Não consegui acionar o robô no GitHub: ${r.status} ${await r.text()}`);
  return `https://github.com/${repo}/actions/workflows/${workflow}`;
}

const RPA_ID_VALIDO = /^[a-z0-9][a-z0-9-]{1,80}$/;


export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    // Só as rotas do robô entram no rastro. As outras (geração de imagem,
    // catálogo) já têm o próprio caminho de erro e logar tudo viraria ruído.
    const rastrear = pathname.startsWith('/api/rpa');
    const t0 = Date.now();
    if (rastrear) {
      traceRpa('chegou', {
        metodo: request.method,
        rota: pathname,
        query: queryLimpa(url),
        // Quem está chamando: o robô manda o x-rpa-token; a tela manda o
        // e-mail de quem está logado. Saber isso separa "o robô sumiu" de
        // "a tela não pediu".
        quem: request.headers.get('x-rpa-token')
          ? 'robo (com x-rpa-token)'
          : request.headers.get('x-godeploy-user-email')
            ? 'tela (usuario logado)'
            : 'anonimo',
      });
    }

    const resposta = await (async (): Promise<Response> => {
    try {
      // ==================== RPA — cadastro no Catalog v3 ====================

      // Listas que a tela usa pra montar os seletores (mesma fonte do robô).
      if (pathname === '/api/rpa/config') {
        return json({
          gruposPorCategoria: RPA_GRUPOS_POR_CATEGORIA,
          materiaisPorCategoria: RPA_MATERIAIS_POR_CATEGORIA,
          materialCasePadrao: RPA_MATERIAL_CASE,
          configurado: !!(env.GITHUB_TOKEN && env.GITHUB_REPO),
        });
      }

      // Passo 1: cria o lote (só metadados -- as imagens vêm nas chamadas seguintes).
      if (pathname === '/api/rpa/lote' && request.method === 'POST') {
        await ensureRpaTables(env);
        rpaGhConfig(env); // falha cedo e com mensagem clara se faltar segredo
        const body = (await request.json()) as {
          element_type?: string;
          estampas?: {
            identifier?: string; categoria?: string; material?: string; grupos?: string[];
            rapport?: boolean; nome_fonte?: string; tamanho_fonte?: string; cor_fonte?: string;
          }[];
        };
        const lista = Array.isArray(body.estampas) ? body.estampas : [];
        if (!lista.length) return json({ error: 'nenhuma estampa no lote' }, 400);
        if (lista.length > 50) return json({ error: 'máximo de 50 estampas por lote' }, 400);

        const vistos = new Set<string>();
        for (const e of lista) {
          const id = String(e.identifier || '').trim().toLowerCase();
          if (!RPA_ID_VALIDO.test(id)) {
            return json({ error: `identifier inválido: "${e.identifier}" (só minúsculas, números e hífen)` }, 400);
          }
          if (vistos.has(id)) return json({ error: `identifier repetido no lote: "${id}"` }, 400);
          vistos.add(id);
          const cat = String(e.categoria || 'case');
          if (!(cat in RPA_GRUPOS_POR_CATEGORIA)) return json({ error: `categoria desconhecida: "${cat}"` }, 400);
        }

        const jobId = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
        const userEmail = request.headers.get('x-godeploy-user-email') || null;
        await env.DB.exec(
          `INSERT INTO rpa_jobs (job_id, user_email, status, total, element_type)
           VALUES (?, ?, 'montando', ?, ?)`,
          [jobId, userEmail, lista.length, String(body.element_type || 'Imagem (Sua foto)')],
        );

        const arquivos: { ordem: number; identifier: string; arquivo: string }[] = [];
        for (let i = 0; i < lista.length; i++) {
          const e = lista[i];
          const identifier = String(e.identifier || '').trim().toLowerCase();
          const categoria = String(e.categoria || 'case');
          const arquivo = `${String(i).padStart(2, '0')}_${identifier}.png`;
          const material = categoria === 'case' ? RPA_MATERIAL_CASE : String(e.material || '');
          await env.DB.exec(
            `INSERT INTO rpa_estampas
               (job_id, ordem, identifier, arquivo, categoria, material, grupos, rapport, nome_fonte, tamanho_fonte, cor_fonte)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              jobId, i, identifier, arquivo, categoria, material,
              JSON.stringify(Array.isArray(e.grupos) ? e.grupos : []),
              e.rapport ? 1 : 0,
              String(e.nome_fonte || ''), String(e.tamanho_fonte || ''), String(e.cor_fonte || ''),
            ],
          );
          arquivos.push({ ordem: i, identifier, arquivo });
        }
        return json({ job_id: jobId, arquivos });
      }

      // Passo 2: os PNGs, em pedaços. Um pedaço por chamada -- requisição pequena
      // e a tela consegue mostrar progresso real de upload.
      if (pathname === '/api/rpa/lote/imagem' && request.method === 'POST') {
        await ensureRpaTables(env);
        const body = (await request.json()) as {
          job_id?: string; arquivo?: string; parte?: number; total_partes?: number; dadosB64?: string;
        };
        const jobId = String(body.job_id || '');
        const arquivo = String(body.arquivo || '');
        const parte = Number(body.parte);
        const totalPartes = Number(body.total_partes);
        if (!jobId || !arquivo || !body.dadosB64 || !Number.isInteger(parte) || !Number.isInteger(totalPartes)) {
          return json({ error: 'job_id, arquivo, parte, total_partes e dadosB64 obrigatórios' }, 400);
        }
        if (totalPartes < 1 || totalPartes > 200 || parte < 0 || parte >= totalPartes) {
          return json({ error: 'numeração de pedaços inválida' }, 400);
        }
        if (String(body.dadosB64).length > 700_000) {
          return json({ error: 'pedaço muito grande (máx. ~512KB por chamada)' }, 400);
        }

        const dono = await env.DB.query(
          `SELECT e.arquivo FROM rpa_estampas e
             JOIN rpa_jobs j ON j.job_id = e.job_id
            WHERE e.job_id = ? AND e.arquivo = ? AND j.status = 'montando'`,
          [jobId, arquivo],
        );
        if (!dono.rows.length) return json({ error: 'arquivo não faz parte de um lote em montagem' }, 404);

        await env.DB.exec(
          `INSERT OR REPLACE INTO rpa_imagens (job_id, arquivo, parte, total_partes, dados)
           VALUES (?, ?, ?, ?, ?)`,
          [jobId, arquivo, parte, totalPartes, String(body.dadosB64)],
        );

        const contagem = await env.DB.query(
          `SELECT COUNT(*) AS n FROM rpa_imagens WHERE job_id = ? AND arquivo = ?`, [jobId, arquivo],
        );
        const completa = Number(contagem.rows[0].n) === totalPartes;
        if (completa) {
          await env.DB.exec(
            `UPDATE rpa_estampas SET enviada = 1 WHERE job_id = ? AND arquivo = ?`, [jobId, arquivo],
          );
        }
        traceRpa('pedaco-recebido', {
          job: jobId, arquivo, parte, total_partes: totalPartes, completa,
        });
        return json({ ok: true, completa });
      }

      // Passo 3: avisa o robô. Nenhum arquivo sai daqui -- ele vem buscar.
      if (pathname === '/api/rpa/lote/disparar' && request.method === 'POST') {
        await ensureRpaTables(env);
        const body = (await request.json()) as { job_id?: string };
        const jobId = String(body.job_id || '');
        if (!jobId) return json({ error: 'job_id obrigatório' }, 400);

        const jobRes = await env.DB.query(
          `SELECT status, element_type FROM rpa_jobs WHERE job_id = ?`, [jobId],
        );
        if (!jobRes.rows.length) return json({ error: 'lote não encontrado' }, 404);
        if (String(jobRes.rows[0].status) !== 'montando') {
          return json({ error: 'este lote já foi disparado' }, 409);
        }

        const est = await env.DB.query(
          `SELECT identifier, enviada FROM rpa_estampas WHERE job_id = ? ORDER BY ordem`, [jobId],
        );
        const faltando = est.rows.filter((r) => !Number(r.enviada)).map((r) => String(r.identifier));
        if (faltando.length) {
          return json({ error: `faltou subir a imagem de: ${faltando.join(', ')}` }, 400);
        }

        traceRpa('disparando', {
          job: jobId,
          estampas: est.rows.length,
          element_type: String(jobRes.rows[0].element_type || ''),
        });
        const runUrl = await rpaGhDispatch(env, jobId);
        // Sem esta linha, "acionei o GitHub" e "o GitHub aceitou" eram
        // indistinguiveis quando nada acontecia depois.
        traceRpa('github-aceitou', { job: jobId, run_url: runUrl || '(sem url)' });

        await env.DB.exec(
          `UPDATE rpa_jobs SET status = 'na_fila', run_url = ? WHERE job_id = ?`, [runUrl, jobId],
        );
        await env.DB.exec(
          `INSERT INTO rpa_eventos (job_id, identifier, status, message)
           VALUES (?, '', 'info', 'Lote enviado pro robô. Aguardando ele iniciar (costuma levar 1 a 2 minutos).')`,
          [jobId],
        );
        return json({ ok: true, run_url: runUrl });
      }

      // ---- As 2 rotas que o robô usa pra buscar o lote (exigem o token) ----

      // A receita do lote: o que cadastrar e com quais opções.
      if (pathname === '/api/rpa/job') {
        if (!env.RPA_TOKEN || request.headers.get('x-rpa-token') !== env.RPA_TOKEN) {
          return json({ error: 'não autorizado' }, 401);
        }
        await ensureRpaTables(env);
        const jobId = url.searchParams.get('job');
        if (!jobId) return json({ error: 'job obrigatório' }, 400);

        const jobRes = await env.DB.query(
          `SELECT element_type FROM rpa_jobs WHERE job_id = ?`, [jobId],
        );
        if (!jobRes.rows.length) return json({ error: 'lote não encontrado' }, 404);

        const est = await env.DB.query(
          `SELECT identifier, arquivo, categoria, material, grupos, rapport,
                  nome_fonte, tamanho_fonte, cor_fonte
             FROM rpa_estampas WHERE job_id = ? ORDER BY ordem`, [jobId],
        );
        return json({
          job_id: jobId,
          element_type: String(jobRes.rows[0].element_type || 'Imagem (Sua foto)'),
          estampas: est.rows.map((r) => ({
            identifier: String(r.identifier),
            arquivo: String(r.arquivo),
            categoria: String(r.categoria),
            material: String(r.material || ''),
            grupos: JSON.parse(String(r.grupos || '[]')),
            rapport: !!Number(r.rapport),
            nome_fonte: String(r.nome_fonte || ''),
            tamanho_fonte: String(r.tamanho_fonte || ''),
            cor_fonte: String(r.cor_fonte || ''),
          })),
        });
      }

      // Os bytes de um PNG do lote.
      if (pathname === '/api/rpa/imagem') {
        if (!env.RPA_TOKEN || request.headers.get('x-rpa-token') !== env.RPA_TOKEN) {
          return new Response('não autorizado', { status: 401 });
        }
        await ensureRpaTables(env);
        const jobId = url.searchParams.get('job');
        const arquivo = url.searchParams.get('arquivo');
        if (!jobId || !arquivo) return new Response('job e arquivo obrigatórios', { status: 400 });

        const bytes = await rpaMontarImagem(env, jobId, arquivo);
        if (!bytes) return new Response('imagem incompleta ou inexistente', { status: 404 });
        return new Response(bytes, {
          headers: { 'content-type': 'image/png', 'cache-control': 'no-store' },
        });
      }

      // O robô reportando progresso. Só ele entra aqui (segredo compartilhado).
      if (pathname === '/api/rpa/progresso' && request.method === 'POST') {
        if (!env.RPA_TOKEN || request.headers.get('x-rpa-token') !== env.RPA_TOKEN) {
          return json({ error: 'não autorizado' }, 401);
        }
        await ensureRpaTables(env);
        const body = (await request.json()) as { job_id?: string; identifier?: string; status?: string; message?: string };
        const jobId = String(body.job_id || '');
        if (!jobId) return json({ error: 'job_id obrigatório' }, 400);
        await env.DB.exec(
          `INSERT INTO rpa_eventos (job_id, identifier, status, message) VALUES (?, ?, ?, ?)`,
          [jobId, String(body.identifier || ''), String(body.status || 'info'), String(body.message || '')],
        );
        await env.DB.exec(
          `UPDATE rpa_jobs SET status = 'rodando' WHERE job_id = ? AND status = 'na_fila'`, [jobId],
        );
        return json({ ok: true });
      }

      if (pathname === '/api/rpa/finalizar' && request.method === 'POST') {
        if (!env.RPA_TOKEN || request.headers.get('x-rpa-token') !== env.RPA_TOKEN) {
          return json({ error: 'não autorizado' }, 401);
        }
        await ensureRpaTables(env);
        const body = (await request.json()) as { job_id?: string; erro?: string | null };
        const jobId = String(body.job_id || '');
        if (!jobId) return json({ error: 'job_id obrigatório' }, 400);
        await env.DB.exec(
          `UPDATE rpa_jobs SET status = ?, erro = ?, finished_at = datetime('now') WHERE job_id = ?`,
          [body.erro ? 'erro' : 'concluido', body.erro ? String(body.erro) : null, jobId],
        );
        // As imagens já cumpriram o papel -- não ficam ocupando o banco.
        await env.DB.exec(`DELETE FROM rpa_imagens WHERE job_id = ?`, [jobId]);
        return json({ ok: true });
      }

      // A tela perguntando "e aí, como vai?" -- de 2 em 2 segundos.
      if (pathname === '/api/rpa/status') {
        await ensureRpaTables(env);
        const jobId = url.searchParams.get('job');
        if (!jobId) return json({ error: 'job obrigatório' }, 400);
        const desde = Number(url.searchParams.get('desde') || 0);

        const jobRes = await env.DB.query(
          `SELECT job_id, status, total, erro, run_url, created_at, finished_at
             FROM rpa_jobs WHERE job_id = ?`, [jobId],
        );
        if (!jobRes.rows.length) return json({ error: 'lote não encontrado' }, 404);
        const j = jobRes.rows[0];

        const ev = await env.DB.query(
          `SELECT id, at, identifier, status, message FROM rpa_eventos
             WHERE job_id = ? AND id > ? ORDER BY id LIMIT 500`, [jobId, desde],
        );
        return json({
          job: {
            jobId: String(j.job_id),
            status: String(j.status),
            total: Number(j.total),
            erro: (j.erro as string | null) || null,
            runUrl: (j.run_url as string | null) || null,
            criadoEm: String(j.created_at || ''),
            terminadoEm: (j.finished_at as string | null) || null,
            aberto: RPA_STATUS_ABERTOS.includes(String(j.status)),
          },
          eventos: ev.rows.map((r) => ({
            id: Number(r.id),
            at: String(r.at || ''),
            identifier: String(r.identifier || ''),
            status: String(r.status || 'info'),
            message: String(r.message || ''),
          })),
        });
      }

      // Histórico -- os últimos lotes de quem está olhando a tela.
      if (pathname === '/api/rpa/lotes') {
        await ensureRpaTables(env);
        const userEmail = request.headers.get('x-godeploy-user-email') || null;
        const r = await env.DB.query(
          `SELECT job_id, created_at, status, total, erro, run_url, user_email
             FROM rpa_jobs
            WHERE (? IS NULL OR user_email = ?)
            ORDER BY created_at DESC LIMIT 20`,
          [userEmail, userEmail],
        );
        return json({
          lotes: r.rows.map((row) => ({
            jobId: String(row.job_id),
            criadoEm: String(row.created_at || ''),
            status: String(row.status),
            total: Number(row.total),
            erro: (row.erro as string | null) || null,
            runUrl: (row.run_url as string | null) || null,
            criadoPor: displayNameFromEmail(row.user_email as string | null),
          })),
        });
      }

      // Lista o registro de produtos (para o cliente montar o checklist).
      if (pathname === '/api/estampas/produtos') {
        return json({ produtos: PRODUTOS });
      }

      // Registro de produtos + máscaras (fonte única para a aba "Adaptar imagem").
      if (pathname === '/api/produtos') {
        return json({ produtos: PRODUTOS.map((p) => ({ key: p.key, label: p.label, cat: p.cat, masks: p.masks })) });
      }

      // ---- Tags (página "Criar Tag") — alimentam Coleção e Licenciado no Segmento ----
      if (pathname === '/api/tags' && request.method === 'GET') {
        await ensureTagsTable(env);
        const r = await env.DB.query(
          `SELECT id, categoria, nome, created_at, user_email FROM tags ORDER BY categoria, nome COLLATE NOCASE`,
          [],
        );
        const tags = r.rows.map((row) => ({
          id: Number(row.id),
          categoria: String(row.categoria),
          nome: String(row.nome),
          criadoEm: String(row.created_at || ''),
          criadoPor: displayNameFromEmail(row.user_email as string | null),
        }));
        return json({ tags });
      }

      if (pathname === '/api/tags' && request.method === 'POST') {
        await ensureTagsTable(env);
        const body = (await request.json()) as { categoria?: string; nome?: string };
        const categoria = String(body.categoria || '').trim();
        const nome = String(body.nome || '').trim().replace(/\s+/g, ' ');
        if (categoria !== 'colecao' && categoria !== 'licenciado') {
          return json({ error: 'categoria deve ser "colecao" ou "licenciado"' }, 400);
        }
        if (!nome) return json({ error: 'nome da tag é obrigatório' }, 400);
        if (nome.length > 60) return json({ error: 'nome da tag muito longo (máx. 60 caracteres)' }, 400);
        const nomeNorm = slugify(nome);
        const dup = await env.DB.query(
          `SELECT nome FROM tags WHERE categoria = ? AND nome_norm = ?`,
          [categoria, nomeNorm],
        );
        if (dup.rows.length) {
          return json({ error: `já existe uma tag "${String(dup.rows[0].nome)}" nessa categoria` }, 409);
        }
        await env.DB.exec(
          `INSERT INTO tags (created_at, user_email, categoria, nome, nome_norm) VALUES (?, ?, ?, ?, ?)`,
          [new Date().toISOString(), request.headers.get('x-godeploy-user-email') || null, categoria, nome, nomeNorm],
        );
        const idRes = await env.DB.query('SELECT last_insert_rowid() AS id', []);
        return json({ ok: true, tag: { id: Number(idRes.rows[0]?.id ?? 0), categoria, nome } });
      }

      // Serve os bytes da arte de referência pela MESMA origem do app. Sem isso o canvas fica
      // "tainted" (CORS) e não dá para ler os pixels — que é o que a detecção de camadas faz.
      // Restrito aos hosts de arte conhecidos: não é um proxy aberto.
      if (pathname === '/api/img-proxy') {
        const alvo = url.searchParams.get('url') || '';
        let host = '';
        try { host = new URL(alvo).hostname; } catch { return json({ error: 'url inválida' }, 400); }
        const permitidos = ['custom-case-images.s3.amazonaws.com', 'ik.imagekit.io'];
        if (!permitidos.includes(host)) return json({ error: 'host não permitido' }, 403);
        const res = await fetch(alvo);
        if (!res.ok) return json({ error: `imagem indisponível (HTTP ${res.status})` }, 502);
        return new Response(res.body, {
          headers: {
            'content-type': res.headers.get('content-type') || 'image/png',
            'cache-control': 'public, max-age=3600',
          },
        });
      }

      // ---- Fontes de customização (Catalog/Prisma) ----
      // A tabela `fonts` (db 19) guarda só o CAMINHO do arquivo, num JSON tipo
      // {"id":"font/1/file/<hash>.ttf","storage":"store",...}. O arquivo em si é servido
      // publicamente pelo host do engine de customização (mesma base que o Prisma usa no site,
      // descoberta no bundle do engine), com CORS liberado — então o navegador carrega a fonte
      // direto, sem proxy. Sem cache: consulta o Catalog ao vivo a cada chamada, pra fonte nova
      // cadastrada lá aparecer aqui na hora (o front também busca de novo toda vez que a barra
      // "Adicionar Fonte" é aberta — ver loadFontes() no index.html).
      if (pathname === '/api/fontes') {
        if (!env.METABASE_TOKEN) return json({ error: 'METABASE_TOKEN não configurado' }, 500);
        const rows = await metabaseQuery(
          env,
          `SELECT id, name, file_data FROM fonts
           WHERE file_data IS NOT NULL AND file_data <> '' ORDER BY name`,
        );
        const BASE = 'https://static-goengines.gocase.com.br/uploads/';
        const fontes = rows.map((r) => {
          let caminho = '';
          try { caminho = String((JSON.parse(String(r.file_data)) as { id?: string }).id || ''); } catch { /* linha com JSON inválido — ignorada abaixo */ }
          return { id: Number(r.id), nome: String(r.name || ''), url: caminho ? BASE + caminho : '' };
        }).filter((f) => f.url && /\.(ttf|otf|woff2?)$/i.test(f.url));
        return json({ fontes }, 200, { 'cache-control': 'no-store' });
      }

      // ---- Alocação de um item existente numa tag (aba "Adaptar ID") ----
      if (pathname === '/api/estampas/alocar-tag' && request.method === 'POST') {
        await ensureAlocacoesTable(env);
        const body = (await request.json()) as {
          itemRef?: string; produto?: string; design?: string; segmento?: string; tag?: string;
        };
        const itemRef = String(body.itemRef || '').trim();
        const segmento = String(body.segmento || '').trim();
        const tag = String(body.tag || '').trim();
        if (!itemRef) return json({ error: 'itemRef obrigatório' }, 400);
        if (!segmento || !tag) return json({ error: 'segmento e tag são obrigatórios' }, 400);
        const userEmail = request.headers.get('x-godeploy-user-email') || null;
        // Uma alocação por item: refazer a alocação troca a tag (não acumula).
        await env.DB.exec('DELETE FROM itens_tags WHERE item_ref = ?', [itemRef]);
        await env.DB.exec(
          `INSERT INTO itens_tags (created_at, user_email, item_ref, produto, design, segmento, tag)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [new Date().toISOString(), userEmail, itemRef, body.produto || null, body.design || null, segmento, tag],
        );
        return json({ ok: true, alocacao: { itemRef, segmento, tag, por: displayNameFromEmail(userEmail) } });
      }

      // Alocação atual de um item (mostrada ao buscar na aba "Adaptar ID").
      if (pathname === '/api/estampas/alocacao' && request.method === 'GET') {
        await ensureAlocacoesTable(env);
        const ref = (url.searchParams.get('ref') || '').trim();
        if (!ref) return json({ error: 'ref obrigatório' }, 400);
        const r = await env.DB.query(
          'SELECT segmento, tag, created_at, user_email FROM itens_tags WHERE item_ref = ?',
          [ref],
        );
        if (!r.rows.length) return json({ alocacao: null });
        const row = r.rows[0];
        return json({
          alocacao: {
            segmento: String(row.segmento), tag: String(row.tag),
            em: String(row.created_at || ''), por: displayNameFromEmail(row.user_email as string | null),
          },
        });
      }

      if (pathname === '/api/tags/excluir' && request.method === 'POST') {
        await ensureTagsTable(env);
        const body = (await request.json()) as { id?: number };
        const id = Number(body.id);
        if (!id) return json({ error: 'id obrigatório' }, 400);
        await env.DB.exec('DELETE FROM tags WHERE id = ?', [id]);
        return json({ ok: true });
      }

      // ---- Copys (página "Copys") — biblioteca de textos p/ inserir como elemento no board ----
      if (pathname === '/api/copys' && request.method === 'GET') {
        await ensureCopysTable(env);
        const r = await env.DB.query(
          `SELECT id, texto, created_at, user_email FROM copys ORDER BY texto COLLATE NOCASE`,
          [],
        );
        const copys = r.rows.map((row) => ({
          id: Number(row.id),
          texto: String(row.texto),
          criadoEm: String(row.created_at || ''),
          criadoPor: displayNameFromEmail(row.user_email as string | null),
        }));
        return json({ copys });
      }

      if (pathname === '/api/copys' && request.method === 'POST') {
        await ensureCopysTable(env);
        const body = (await request.json()) as { texto?: string };
        const texto = String(body.texto || '').trim().replace(/\s+/g, ' ');
        if (!texto) return json({ error: 'texto é obrigatório' }, 400);
        if (texto.length > 120) return json({ error: 'texto muito longo (máx. 120 caracteres)' }, 400);
        const textoNorm = slugify(texto);
        const dup = await env.DB.query(`SELECT texto FROM copys WHERE texto_norm = ?`, [textoNorm]);
        if (dup.rows.length) {
          return json({ error: `já existe um copy "${String(dup.rows[0].texto)}"` }, 409);
        }
        await env.DB.exec(
          `INSERT INTO copys (created_at, user_email, texto, texto_norm) VALUES (?, ?, ?, ?)`,
          [new Date().toISOString(), request.headers.get('x-godeploy-user-email') || null, texto, textoNorm],
        );
        const idRes = await env.DB.query('SELECT last_insert_rowid() AS id', []);
        return json({ ok: true, copy: { id: Number(idRes.rows[0]?.id ?? 0), texto } });
      }

      if (pathname === '/api/copys/excluir' && request.method === 'POST') {
        await ensureCopysTable(env);
        const body = (await request.json()) as { id?: number };
        const id = Number(body.id);
        if (!id) return json({ error: 'id obrigatório' }, 400);
        await env.DB.exec('DELETE FROM copys WHERE id = ?', [id]);
        return json({ ok: true });
      }

      // Cadastro em lote — usado pra colar vários copys de uma vez (ex.: legendas de
      // copyright extraídas de um PSD) em vez de repetir POST /api/copys um por um.
      // Cada texto passa pela mesma validação/normalização/dedupe do cadastro individual;
      // duplicatas (já existentes OU repetidas dentro do próprio lote) não travam o resto.
      if (pathname === '/api/copys/lote' && request.method === 'POST') {
        await ensureCopysTable(env);
        const body = (await request.json()) as { textos?: string[] };
        const textos = Array.isArray(body.textos)
          ? body.textos.map((t) => String(t || '').trim().replace(/\s+/g, ' ')).filter(Boolean)
          : [];
        if (!textos.length) return json({ error: 'textos obrigatório (lista não vazia)' }, 400);
        const userEmail = request.headers.get('x-godeploy-user-email') || null;
        const criados: string[] = [];
        const duplicados: string[] = [];
        const erros: { texto: string; error: string }[] = [];
        for (const texto of textos) {
          if (texto.length > 120) { erros.push({ texto, error: 'texto muito longo (máx. 120 caracteres)' }); continue; }
          const textoNorm = slugify(texto);
          try {
            const dup = await env.DB.query('SELECT id FROM copys WHERE texto_norm = ?', [textoNorm]);
            if (dup.rows.length) { duplicados.push(texto); continue; }
            await env.DB.exec(
              `INSERT INTO copys (created_at, user_email, texto, texto_norm) VALUES (?, ?, ?, ?)`,
              [new Date().toISOString(), userEmail, texto, textoNorm],
            );
            criados.push(texto);
          } catch (e) {
            erros.push({ texto, error: String((e as Error).message || e) });
          }
        }
        return json({ ok: true, criados, duplicados, erros });
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
          const sku = `${identifier}-${catSlug}`;   // slug contínuo, sem espaços
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
      const erro = String((e as Error).message || e);
      if (rastrear) traceRpa('estourou', { rota: pathname, erro: erro.slice(0, 300), ms: Date.now() - t0 });
      return json({ error: erro }, 500);
    }
    return new Response('Not found', { status: 404 });
    })();

    if (rastrear) {
      traceRpa('respondeu', { rota: pathname, status: resposta.status, ms: Date.now() - t0 });
    }
    return resposta;
  },
};
