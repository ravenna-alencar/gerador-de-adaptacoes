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
//   AI_PROXY_TOKEN   opcional — descreve a imagem p/ prompt mais fiel (visão)
//   PIAPP_URL        opcional (default: https://piapp-v2.vercel.app)
//   AI_PROXY_URL     opcional (default: https://ai-proxy.gogroupbr.com/v1/chat/completions)
//   AI_MODEL         opcional (default: gpt-5.5)
//   PIAPP_MODEL      opcional (default: gemini-2.5-flash-image)
//   REMOVEBG_KEY     opcional — se presente, remove o fundo (PNG transparente) via remove.bg
//   REMOVEBG_URL     opcional (default: https://api.remove.bg/v1.0/removebg)

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
