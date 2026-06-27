// LM Studio 翻译代理 v2.4 — localStorage + CDP 中继 (Electron 38 全沙箱适配)
import { createServer } from 'node:http';
import { get } from 'node:http';
import { createHash } from 'node:crypto';
import { writeFileSync, readFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';

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
const MAX_BODY_SIZE = 1024 * 1024; // 1MB

async function extractJSON(req) {
  if (req.method === 'POST') {
    const body = await new Promise((resolve, reject) => {
      let d = ''; let size = 0;
      req.on('data', c => { size += c.length; if (size > MAX_BODY_SIZE) { req.destroy(); reject(new Error('Request body too large (max 1MB)')); } d += c; });
      req.on('end', () => resolve(d));
      req.on('error', reject);
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

function getCorsOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return '*';
  try {
    const u = new URL(origin);
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.protocol === 'file:') return origin;
  } catch(e) {}
  return 'http://127.0.0.1';
}

const server = createServer(async (req, res) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url.substring(0, 120)}`);
  res.setHeader('Access-Control-Allow-Origin', getCorsOrigin(req));
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

  // iframe 桥接页面 (Electron 38 沙箱穿透: LM Studio → iframe → postMessage → proxy)
  if (req.url === '/bridge' || req.url === '/bridge.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{font:12px monospace;color:#4a9eff;background:#0a0c14;margin:0;padding:8px;}</style></head><body>
<div id="log">🔗 Bridge ready</div>
<script>
var proxyBase = 'http://127.0.0.1:18990';
var seq = 0, pending = {};
function log(msg) { var el = document.getElementById('log'); el.textContent += '\\n' + msg; el.scrollTop = el.scrollHeight; }

async function proxyFetch(path, opts) {
  var url = proxyBase + path;
  var resp = await fetch(url, opts);
  return resp.json();
}

window.addEventListener('message', async function(e) {
  // 接受来自 file:// (LM Studio) 和 http://127.0.0.1 的请求
  if (!e.data || !e.data.type) return;
  var msg = e.data;
  var id = msg.id || ('m' + (++seq));

  try {
    switch (msg.type) {
      case 'health':
        var h = await proxyFetch('/health');
        e.source.postMessage({ type: 'result', id: id, ok: true, data: h }, '*');
        break;

      case 'translate':
        var qs = '?q=' + encodeURIComponent(msg.q) + '&from=' + (msg.from||'en') + '&to=' + (msg.to||'zh');
        var tr = await proxyFetch('/translate' + qs);
        e.source.postMessage({ type: 'result', id: id, ok: tr.ok, data: tr.translations }, '*');
        break;

      case 'batch':
        var br = await proxyFetch('/batch', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({texts:msg.texts,from:msg.from||'en',to:msg.to||'zh'}) });
        e.source.postMessage({ type: 'batch_result', id: id, ok: br.ok, translations: br.translations }, '*');
        break;

      case 'store':
        var sr = await proxyFetch('/store', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(msg.data) });
        e.source.postMessage({ type: 'result', id: id, ok: sr.ok, path: sr.path, count: sr.count }, '*');
        break;

      case 'audit':
        var ar = await proxyFetch('/audit', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(msg.entries) });
        e.source.postMessage({ type: 'result', id: id, ok: ar.ok, path: ar.path, count: ar.count }, '*');
        break;

      case 'ping':
        e.source.postMessage({ type: 'pong', id: id }, '*');
        break;

      default:
        e.source.postMessage({ type: 'result', id: id, ok: false, error: 'Unknown type: ' + msg.type }, '*');
    }
  } catch(err) {
    e.source.postMessage({ type: 'result', id: id, ok: false, error: err.message }, '*');
  }
});
log('✅ Bridge v2.3 ready — proxy on ' + proxyBase);
</script></body></html>`);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found' }));
});

// ===== WebSocket 服务器 (Electron 38 renderer 沙箱下 HTTP fetch 被拦截，用 WS 替代) =====
const wss = new WebSocketServer({ server }); // 复用同一 HTTP server

wss.on('connection', (ws, req) => {
  const clientIp = req.socket?.remoteAddress || 'unknown';
  console.log(`🔌 WS client connected from ${clientIp}`);

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch(e) { return; }

    const send = (obj) => {
      try { ws.send(JSON.stringify(obj)); } catch(e) {}
    };

    try {
      switch (msg.type) {
        case 'ping':
          send({ type: 'pong' });
          break;

        case 'translate': {
          const { q, from = 'en', to = 'zh', id } = msg;
          if (!q) { send({ type: 'result', id, ok: false, error: 'Missing q' }); break; }
          const results = await baiduTranslate(q, from, to);
          send({ type: 'result', id, ok: true, data: results });
          break;
        }

        case 'batch': {
          const { texts, from = 'en', to = 'zh', id } = msg;
          if (!texts || !texts.length) { send({ type: 'batch_result', id, ok: false, error: 'Missing texts' }); break; }
          const combined = texts.join('\n|||\n');
          const results = await baiduTranslate(combined, from, to);
          const split = results.join('\n').split('\n|||\n').map(s => s.trim());
          send({ type: 'batch_result', id, ok: true, translations: split });
          break;
        }

        case 'store': {
          const { data, id } = msg;
          if (!data) { send({ type: 'result', id, ok: false, error: 'Missing data' }); break; }
          _latestScrape = data; _scrapeCount++; _scrapeLastTime = new Date().toISOString(); _scrapeLastError = null;
          const sp = scrapePath(); ensureDir(sp);
          writeFileSync(sp, JSON.stringify(data, null, 2), 'utf8');
          console.log(`📊 [ws:store] ${data.models?.length || 0} models → ${sp}`);
          send({ type: 'result', id, ok: true, path: sp, count: data.models?.length || 0 });
          break;
        }

        case 'audit': {
          const { entries, id } = msg;
          if (!entries || !Array.isArray(entries)) { send({ type: 'result', id, ok: false, error: 'Missing entries array' }); break; }
          const ap = auditPath(); ensureDir(ap);
          for (const e of entries) appendFileSync(ap, JSON.stringify(e) + '\n', 'utf8');
          send({ type: 'result', id, ok: true, path: ap, count: entries.length });
          break;
        }

        case 'health':
          send({
            type: 'result', id: msg.id, ok: true,
            data: {
              status: 'ok', service: 'LM Translate Proxy v2.3 (WS)',
              uptime: process.uptime(),
              scrape: { count: _scrapeCount, lastTime: _scrapeLastTime, lastError: _scrapeLastError,
                latestSize: _latestScrape ? JSON.stringify(_latestScrape).length : 0 }
            }
          });
          break;

        default:
          send({ type: 'result', id: msg.id, ok: false, error: `Unknown type: ${msg.type}` });
      }
    } catch (e) {
      console.error(`❌ [ws] ${msg.type}:`, e.message);
      send({ type: 'result', id: msg.id, ok: false, error: e.message });
    }
  });

  ws.on('close', () => {
    console.log(`🔌 WS client disconnected`);
  });
});

// ===== CDP localStorage 中继 (Electron 38 沙箱穿透 — v2.4) =====
const CDP_PORT = 9222;
let cdpWs = null;
let cdpMsgId = 0;
let cdpConnected = false;
let cdpPollInterval = null;

function cdpSend(method, params) {
  return new Promise((resolve, reject) => {
    if (!cdpWs || cdpWs.readyState !== WebSocket.OPEN) { reject(new Error('CDP not connected')); return; }
    const id = ++cdpMsgId;
    const timer = setTimeout(() => { reject(new Error('CDP timeout')); }, 10000);
    const handler = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id === id) {
          clearTimeout(timer);
          cdpWs.removeListener('message', handler);
          reject._handled = true;
          resolve(msg.result);
        }
      } catch(e) {}
    };
    handler._handler = true;
    cdpWs.on('message', handler);
    cdpWs.send(JSON.stringify({ id, method, params }));
  });
}

async function cdpEvaluate(expression) {
  for (let retry = 0; retry < 3; retry++) {
    try {
      const result = await cdpSend('Runtime.evaluate', {
        expression, returnByValue: true, awaitPromise: false
      });
      return result?.result?.value;
    } catch(e) {
      if (retry === 2) throw e;
      await new Promise(r => setTimeout(r, 500));
    }
  }
}

async function cdpConnect() {
  if (cdpWs && cdpWs.readyState === WebSocket.OPEN) return true;

  try {
    const pages = await httpGet(`http://127.0.0.1:${CDP_PORT}/json`);
    const page = pages.find(p => p.type === 'page');
    if (!page) { console.log('  CDP: no page found'); return false; }

    if (cdpWs) { try { cdpWs.close(); } catch(e) {} }

    cdpWs = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws timeout')), 5000);
      cdpWs.on('open', () => { clearTimeout(timer); resolve(); });
      cdpWs.on('error', (e) => { clearTimeout(timer); reject(e); });
    });

    await cdpSend('Runtime.enable');
    cdpConnected = true;
    console.log(`  🔗 CDP relay connected to LM Studio renderer`);

    cdpWs.on('close', () => {
      cdpConnected = false;
      console.log('  CDP: disconnected, reconnecting in 3s...');
      if (cdpPollInterval) { clearInterval(cdpPollInterval); cdpPollInterval = null; }
      setTimeout(startCdpRelay, 3000);
    });
    cdpWs.on('error', () => {}); // close will fire

    return true;
  } catch(e) {
    console.log(`  CDP: connect failed: ${e.message}`);
    return false;
  }
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function cdpPollCommands() {
  if (!cdpConnected || !cdpWs || cdpWs.readyState !== WebSocket.OPEN) return;
  try {
    const raw = await cdpEvaluate('(function(){ try { var v = localStorage.getItem("__ts_cmd_queue"); return v; } catch(e) { return null; } })()');
    if (!raw || raw === '[]') return;
    const cmds = JSON.parse(raw);
    if (!Array.isArray(cmds) || cmds.length === 0) return;

    console.log(`  📡 CDP: processing ${cmds.length} commands`);

    for (const cmd of cmds) {
      const respKey = `__ts_resp_${cmd.id}`;
      try {
        let result;
        switch (cmd.type) {
          case 'health':
            result = { status: 'ok', service: 'LM Translate Proxy v2.4 (CDP)', uptime: process.uptime() };
            break;
          case 'translate':
            result = await baiduTranslate(cmd.q || '', cmd.from || 'en', cmd.to || 'zh');
            break;
          case 'batch': {
            const combined = (cmd.texts || []).join('\n|||\n');
            const translations = await baiduTranslate(combined, cmd.from || 'en', cmd.to || 'zh');
            result = translations.join('\n').split('\n|||\n').map(s => s.trim());
            break;
          }
          case 'store': {
            const data = cmd.data || {};
            _latestScrape = data; _scrapeCount++; _scrapeLastTime = new Date().toISOString(); _scrapeLastError = null;
            const sp = scrapePath(); ensureDir(sp);
            writeFileSync(sp, JSON.stringify(data, null, 2), 'utf8');
            result = { ok: true, path: sp, count: data.models?.length || 0 };
            break;
          }
          case 'audit': {
            const entries = cmd.entries || [];
            if (entries.length > 0) {
              const ap = auditPath(); ensureDir(ap);
              for (const e of entries) appendFileSync(ap, JSON.stringify(e) + '\n', 'utf8');
            }
            result = { ok: true, count: entries.length };
            break;
          }
          default:
            result = { _error: 'Unknown type: ' + cmd.type };
        }
        const respStr = JSON.stringify(JSON.stringify(result));
        await cdpEvaluate(`localStorage.setItem("${respKey}", ${respStr})`);
      } catch(e) {
        console.error(`  CDP cmd error [${cmd.type}/${cmd.id}]:`, e.message);
        try {
          await cdpEvaluate(`localStorage.setItem("${respKey}", ${JSON.stringify(JSON.stringify({_error: e.message}))})`);
        } catch(e2) {}
      }
    }
    await cdpEvaluate(`localStorage.setItem("__ts_cmd_queue", "[]")`);
    console.log(`  ✅ CDP: ${cmds.length} commands processed`);
  } catch(e) {
    // Silently retry
  }
}

async function startCdpRelay() {
  console.log(`  🔍 CDP relay: connecting to LM Studio on port ${CDP_PORT}...`);
  const ok = await cdpConnect();
  if (ok) {
    if (cdpPollInterval) clearInterval(cdpPollInterval);
    cdpPollInterval = setInterval(cdpPollCommands, 400);
    console.log('  ✅ CDP relay active (400ms poll)');
  } else {
    console.log('  ⚠️ CDP not available, retrying in 5s...');
    setTimeout(startCdpRelay, 5000);
  }
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`🌐 LM Translate Proxy v2.4 on http://127.0.0.1:${PORT} (HTTP+WS+CDP)`);
  console.log(`   GET/POST /store /audit /batch /translate /data /health`);
  console.log(`   WS: translate | batch | store | audit | health | ping`);
  console.log(`   CDP: localStorage polling via port ${CDP_PORT}`);
  console.log(`   📁 Data → ${TMP_BASE}\\<date>\\`);
  // 延迟启动 CDP 中继 (等 LM Studio 启动)
  setTimeout(startCdpRelay, 3000);
});
