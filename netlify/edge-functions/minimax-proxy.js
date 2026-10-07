const MINIMAX_HOST = 'https://api.minimaxi.com';
const DEFAULT_MODEL = 'image-01';

const RATIOS = [
  ['1:1', 1], ['16:9', 16/9], ['4:3', 4/3], ['3:2', 3/2],
  ['2:3', 2/3], ['3:4', 3/4], ['9:16', 9/16], ['21:9', 21/9],
];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function sizeToRatio(size) {
  if (typeof size !== 'string') return '1:1';
  const m = size.match(/^(\d+)\s*[x×*]\s*(\d+)$/i);
  if (!m) return '1:1';
  const wh = Number(m[1]) / Number(m[2]);
  let best = RATIOS[0];
  for (const r of RATIOS) {
    if (Math.abs(r[1] - wh) < Math.abs(best[1] - wh)) best = r;
  }
  return best[0];
}

export default async function handler(request, context) {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (url.pathname === '/img') {
    const target = url.searchParams.get('u');
    if (!target) return new Response('missing u', { status: 400, headers: CORS });
    let host = '';
    try { host = new URL(target).host; } catch (e) {
      return new Response('bad url', { status: 400, headers: CORS });
    }
    if (!/(^|\.)minimaxi\.com$|(^|\.)minimax\.com$|(^|\.)minimax\.chat$|(^|\.)minimaxi\.chat$/.test(host)) {
      return new Response('host not allowed', { status: 403, headers: CORS });
    }
    const r = await fetch(target);
    return new Response(r.body, {
      status: r.status,
      headers: {
        'Content-Type': r.headers.get('Content-Type') || 'image/png',
        'Cache-Control': 'public, max-age=3600',
        ...CORS,
      },
    });
  }

  if (url.pathname.endsWith('/models')) {
    return json({
      object: 'list',
      data: [
        { id: 'image-01', object: 'model', owned_by: 'minimax' },
        { id: 'image-01-live', object: 'model', owned_by: 'minimax' },
      ],
    });
  }

  if (request.method !== 'POST') {
    return json({ error: { message: '只支持 POST' } }, 405);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: { message: '请求体不是合法 JSON' } }, 400);
  }

  const prompt = body.prompt || body.input || '';
  if (!prompt) return json({ error: { message: '缺少 prompt' } }, 400);

  const model = body.model && body.model !== 'dall-e-3' ? body.model : DEFAULT_MODEL;
  const ratio = body.aspect_ratio || sizeToRatio(body.size);

  const auth = request.headers.get('Authorization') || '';
  const key = Deno.env.get('MINIMAX_API_KEY') || auth.replace(/^Bearer\s+/i, '').trim();
  if (!key) return json({ error: { message: '缺少 API Key' } }, 401);

  const payload = {
    model: model,
    prompt: prompt,
    aspect_ratio: ratio,
    response_format: 'url',
    n: 1,
    prompt_optimizer: true,
    aigc_watermark: false,
  };

  let up;
  try {
    up = await fetch(MINIMAX_HOST + '/v1/image_generation', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + key,
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return json({ error: { message: '连接 Minimax 失败：' + e.message } }, 502);
  }

  const text = await up.text();
  let raw;
  try { raw = JSON.parse(text); } catch (e) {
    return json({ error: { message: 'Minimax 返回非 JSON（HTTP ' + up.status + '）：' + text.slice(0, 400) } }, 502);
  }

  const br = raw.base_resp || {};
  if (br.status_code && br.status_code !== 0) {
    return json({ error: { message: 'Minimax 错误 ' + br.status_code + '：' + (br.status_msg || '未知') } }, 400);
  }

  const d = raw.data || {};
  const urls = d.image_urls || d.image_url || [];
  const list = Array.isArray(urls) ? urls : [urls];
  const origin = url.origin;
  const out = [];
  for (const u of list) {
    if (!u) continue;
    out.push({ url: origin + '/img?u=' + encodeURIComponent(u) });
  }

  if (!out.length) {
    return json({ error: { message: 'Minimax 返回里没找到图片字段：' + text.slice(0, 600) } }, 502);
  }

  return json({ created: Math.floor(Date.now() / 1000), data: out });
}
