// LM Studio 翻译代理 v2.1 — 支持 GET 接口（tsApi 通道）+ POST（fetch 通道）
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { writeFileSync, readFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 18990;
const BAIDU_APP_ID = '20260203002552175';
const BAIDU_SECRET = 'waizdDTnFIhLvLAkCtwh';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TMP_BASE = process.env.LM_SCRAPE_DIR || 'E:\\临时文件\\claude 临时文件';
const today = () => new Date().toISOString().slice(0, 10);
const scrapePath = () => join(TMP_BASE, today(), 'lm-studio-scrape.json');
const auditPath = () => join(TMP_BASE, today(), 'lm-studio-audit.jsonl');

function ensureDir(p) { const d = dirname(p); if (!existsSync(d)) mkdirSync(d, { recursive: true }); }

let _latestScrape = null;
let _scrapeCount = 0;
let _scrapeLastError = null;
let _scrapeLastTime = null;

// 从 URL 或 body 提取 JSON 数据
async function extractJSON(req) {
  if (req.method === 'POST') {
    const body = await new Promise((resolve) => {
      let d = ''; req.on('data', c => d += c); req.on('end', () => resolve(d));
    });
    return JSON.parse(body);
  }
  // GET: 从 ?json= 或 ?b64= 参数提取
  const url = new URL(req.url, 'http://localhost');
  const b64 = url.searchParams.get('b64');
  if (b64) {
    return JSON.parse(Buffer.from(decodeURIComponent(b64), 'base64').toString('utf8'));
  }
  const j = url.searchParams.get('json');
  if (!j) throw new Error('Missing json or b64 parameter');
  return JSON.parse(decodeURIComponent(j));
}

function md5(s) { return createHash('md5').update(s, 'utf8').digest('hex'); }

function buildBaiduUrl(text, from, to) {
  const salt = Date.now().toString();
  const sign = md5(BAIDU_APP_ID + text + salt + BAIDU_SECRET);
  return `https://fanyi-api.baidu.com/api/trans/vip/translate?q=${encodeURIComponent(text)}&from=${from}&to=${to}&appid=${BAIDU_APP_ID}&salt=${salt}&sign=${sign}`;
}

async function baiduTranslate(text, from = 'en', to = 'zh') {
  const url = buildBaiduUrl(text, from, to);
  const resp = await fetch(url);
  const data = await resp.json();
  if (data.error_code) throw new Error(`Baidu API ${data.error_code}: ${data.error_msg}`);
  return data.trans_result?.map(r => r.dst) || [];
}

const server = createServer(async (req, res) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url.substring(0, 120)}`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // 健康检查
  if (req.url === '/' || req.url === '/health' || req.url.startsWith('/health?')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok', service: 'LM Translate Proxy v2.1', uptime: process.uptime(),
      scrape: { count: _scrapeCount, lastTime: _scrapeLastTime, lastError: _scrapeLastError,
        latestSize: _latestScrape ? JSON.stringify(_latestScrape).length : 0 }
    }));
    return;
  }

  // 存储采集数据 (GET ?json= 或 POST body)
  if (req.url.startsWith('/store')) {
    try {
      const data = await extractJSON(req);
      _latestScrape = data; _scrapeCount++; _scrapeLastTime = new Date().toISOString(); _scrapeLastError = null;
      const sp = scrapePath(); ensureDir(sp);
      writeFileSync(sp, JSON.stringify(data, null, 2), 'utf8');
      console.log(`📊 [store] ${data.models?.length || 0} models → ${sp}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: sp, count: data.models?.length || 0 }));
    } catch (e) {
      _scrapeLastError = e.message;
      console.error('❌ [store]', e.message);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // 存储审计日志 (GET ?json= 或 POST body)
  if (req.url.startsWith('/audit')) {
    try {
      const entries = await extractJSON(req);
      if (!Array.isArray(entries)) throw new Error('Expected JSON array');
      const ap = auditPath(); ensureDir(ap);
      for (const e of entries) appendFileSync(ap, JSON.stringify(e) + '\n', 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: ap, count: entries.length }));
    } catch (e) {
      console.error('❌ [audit]', e.message);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // 读取最新快照
  if (req.url === '/data') {
    if (_latestScrape) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(_latestScrape));
    } else {
      try {
        const sp = scrapePath();
        if (existsSync(sp)) { _latestScrape = JSON.parse(readFileSync(sp, 'utf8')); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(_latestScrape)); return; }
      } catch(e) { console.error('[data] read error:', e.message); }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'No scrape data available' }));
    }
    return;
  }

  // 单个翻译
  if (req.url.startsWith('/translate')) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const q = url.searchParams.get('q'); if (!q) throw new Error('Missing q');
      const result = await baiduTranslate(q, url.searchParams.get('from') || 'en', url.searchParams.get('to') || 'zh');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, translations: result }));
    } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }

  // 批量翻译
  if (req.url.startsWith('/batch')) {
    try {
      const data = await extractJSON(req);
      const { texts, from = 'en', to = 'zh' } = data;
      if (!texts || !texts.length) throw new Error('Missing texts');
      const combined = texts.join('\n|||\n');
      const results = await baiduTranslate(combined, from, to);
      const split = results.join('\n').split('\n|||\n').map(s => s.trim());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, translations: split }));
    } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`🌐 LM Translate Proxy v2.1 on http://127.0.0.1:${PORT}`);
  console.log(`   GET/POST /store  /audit  /batch  /translate  /data  /health`);
  console.log(`   📁 Data → ${TMP_BASE}\\<date>\\`);
});
