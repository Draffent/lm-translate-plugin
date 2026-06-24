// LM Studio 翻译代理 v2.0 — 本地HTTP中转百度API + 数据采集存储
// 启动: node lm-translate-proxy.mjs
// 监听: http://127.0.0.1:18990
//
// v1.0: /translate /batch /health
// v2.0: /store /audit /data + 增强 /health

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { writeFileSync, readFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 18990;
const BAIDU_APP_ID = '20260203002552175';
const BAIDU_SECRET = 'waizdDTnFIhLvLAkCtwh';

// v2.0: 数据存储路径 (临时文件目录)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TMP_BASE = process.env.LM_SCRAPE_DIR || 'E:\\临时文件\\claude 临时文件';
const today = () => new Date().toISOString().slice(0, 10);
const scrapePath = () => join(TMP_BASE, today(), 'lm-studio-scrape.json');
const auditPath = () => join(TMP_BASE, today(), 'lm-studio-audit.jsonl');

function ensureDir(p) { const d = dirname(p); if (!existsSync(d)) mkdirSync(d, { recursive: true }); }

// 内存中保留最新快照
let _latestScrape = null;
let _scrapeCount = 0;
let _scrapeLastError = null;
let _scrapeLastTime = null;

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

  // v2.0: 增强健康检查
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      service: 'LM Translate Proxy v2.0',
      uptime: process.uptime(),
      scrape: {
        count: _scrapeCount,
        lastTime: _scrapeLastTime,
        lastError: _scrapeLastError,
        latestSize: _latestScrape ? JSON.stringify(_latestScrape).length : 0,
      }
    }));
    return;
  }

  // v2.0: 存储采集数据 POST /store
  if (req.url === '/store' && req.method === 'POST') {
    try {
      const body = await new Promise((resolve) => {
        let d = ''; req.on('data', c => d += c); req.on('end', () => resolve(d));
      });
      const data = JSON.parse(body);
      _latestScrape = data;
      _scrapeCount++;
      _scrapeLastTime = new Date().toISOString();
      _scrapeLastError = null;

      const sp = scrapePath();
      ensureDir(sp);
      writeFileSync(sp, JSON.stringify(data, null, 2), 'utf8');
      console.log(`📊 [store] ${data.models?.length || 0} models → ${sp}`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: sp, count: data.models?.length || 0 }));
    } catch (e) {
      _scrapeLastError = e.message;
      console.error('❌ [store]', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // v2.0: 存储审计日志 POST /audit
  if (req.url === '/audit' && req.method === 'POST') {
    try {
      const body = await new Promise((resolve) => {
        let d = ''; req.on('data', c => d += c); req.on('end', () => resolve(d));
      });
      const entries = JSON.parse(body);
      if (!Array.isArray(entries)) throw new Error('Expected JSON array');

      const ap = auditPath();
      ensureDir(ap);
      for (const e of entries) {
        appendFileSync(ap, JSON.stringify(e) + '\n', 'utf8');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: ap, count: entries.length }));
    } catch (e) {
      console.error('❌ [audit]', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // v2.0: 读取最新快照 GET /data
  if (req.url === '/data') {
    if (_latestScrape) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(_latestScrape));
    } else {
      try {
        const sp = scrapePath();
        if (existsSync(sp)) {
          _latestScrape = JSON.parse(readFileSync(sp, 'utf8'));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(_latestScrape));
          return;
        }
      } catch(e) { /* file missing or corrupt */ }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'No scrape data available' }));
    }
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
  console.log(`🌐 LM Translate Proxy v2.0 on http://127.0.0.1:${PORT}`);
  console.log('   GET  /translate?q=hello&from=en&to=zh');
  console.log('   POST /batch  {"texts":["a","b"],"from":"en","to":"zh"}');
  console.log('   POST /store  (scrape data)');
  console.log('   POST /audit  (audit logs)');
  console.log('   GET  /data   (latest snapshot)');
  console.log(`   📁 Data → ${TMP_BASE}\\<date>\\`);
});
