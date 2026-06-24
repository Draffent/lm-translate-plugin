// LM Studio 翻译代理 — 本地HTTP中转百度API，绕过CORS
// 启动: node lm-translate-proxy.mjs
// 监听: http://127.0.0.1:18990

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const PORT = 18990;
const BAIDU_APP_ID = '20260203002552175';
const BAIDU_SECRET = 'waizdDTnFIhLvLAkCtwh';

function md5(s) {
  return createHash('md5').update(s, 'utf8').digest('hex');
}

function buildBaiduUrl(text, from, to) {
  const salt = Date.now().toString();
  const sign = md5(BAIDU_APP_ID + text + salt + BAIDU_SECRET);
  const params = new URLSearchParams({
    q: text, from, to, appid: BAIDU_APP_ID, salt, sign,
  });
  return `https://fanyi-api.baidu.com/api/trans/vip/translate?${params}`;
}

async function baiduTranslate(text, from = 'en', to = 'zh') {
  const url = buildBaiduUrl(text, from, to);
  const resp = await fetch(url);
  const data = await resp.json();
  if (data.error_code) {
    throw new Error(`Baidu API ${data.error_code}: ${data.error_msg}`);
  }
  return data.trans_result?.map(r => r.dst) || [];
}

const server = createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'LM Translate Proxy v1.0' }));
    return;
  }

  // 单个翻译: /translate?q=hello&from=en&to=zh
  if (req.url.startsWith('/translate')) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const q = url.searchParams.get('q');
      const from = url.searchParams.get('from') || 'en';
      const to = url.searchParams.get('to') || 'zh';
      if (!q) throw new Error('Missing "q" parameter');
      const result = await baiduTranslate(q, from, to);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, translations: result }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // 批量翻译: POST /batch  body: {texts:[...], from:"en", to:"zh"}
  if (req.url === '/batch' && req.method === 'POST') {
    try {
      const body = await new Promise((resolve) => {
        let d = '';
        req.on('data', c => d += c);
        req.on('end', () => resolve(d));
      });
      const { texts, from = 'en', to = 'zh' } = JSON.parse(body);
      if (!texts || !texts.length) throw new Error('Missing "texts" array');
      const combined = texts.join('\n|||\n');
      const results = await baiduTranslate(combined, from, to);
      const allText = results.join('\n');
      const split = allText.split('\n|||\n').map(s => s.trim());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, translations: split }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`🌐 LM Translate Proxy on http://127.0.0.1:${PORT}`);
  console.log('   GET  /translate?q=hello&from=en&to=zh');
  console.log('   POST /batch  {"texts":["a","b"],"from":"en","to":"zh"}');
});
