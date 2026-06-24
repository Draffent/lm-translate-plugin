// LM Studio Translate v2.0 — 翻译 + 数据采集 + LLM 桥接
(function(){
'use strict';

var LOG = function(){ console.log('[lm-tr]', Array.prototype.slice.call(arguments).join(' ')); };
var _translating = false;
var _translated = false;
var _wsReady = false;
var _ws = null;
var _wsP = {};
var _wsSeq = 0;
var _diagLog = [];

// ===== v2.0 审计日志 =====
var _auditBuf = [];
var _auditSeq = 0;
var _auditTimer = null;
var _auditFlushInterval = 30000; // 30秒推送一次审计日志

function audit(event, detail) {
  var entry = {
    seq: ++_auditSeq,
    ts: new Date().toISOString(),
    event: event,
    detail: detail || {},
    page: location.hash || '/',
  };
  _auditBuf.push(entry);
  if (_auditBuf.length > 200) _auditBuf.shift();
  if (event === 'error' || event === 'scrape_fail') flushAudit();
}

function flushAudit() {
  if (!_auditBuf.length) return;
  var batch = _auditBuf.splice(0, _auditBuf.length);
  try {
    fetch(PROXY_URL + '/audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
    }).catch(function(){});
  } catch(e) { /* silent */ }
}

function diag(msg) {
  var ts = new Date().toLocaleTimeString();
  _diagLog.push('['+ts+'] '+msg);
  if (_diagLog.length > 50) _diagLog.shift();
  LOG(msg);
  updateDiagPanel();
}

// ===== 诊断面板 =====
var _diagAutoHideTimer = null;
var _diagKeepOpen = false;
var _diagManuallyClosed = false;
var _lastDiagPage = '';

function createDiagPanel() {
  if (document.getElementById('ts-diag')) return;
  var panel = document.createElement('div');
  panel.id = 'ts-diag';
  panel.style.cssText =
    'position:fixed;top:12px;right:12px;z-index:99999;'+
    'width:520px;max-height:600px;overflow-y:auto;'+
    'background:rgba(10,12,20,0.95);border:1px solid #333;border-radius:8px;'+
    'padding:8px 12px;font-family:monospace;font-size:11px;'+
    'color:#aaa;line-height:1.6;pointer-events:auto;'+
    'backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);'+
    'transition:opacity 0.4s ease, transform 0.35s cubic-bezier(0.16,1,0.3,1);';
  var closeBtn = document.createElement('span');
  closeBtn.textContent = '✕';
  closeBtn.style.cssText = 'float:right;cursor:pointer;color:#f87171;font-size:14px;font-weight:bold;';
  closeBtn.title = 'Close diagnostic panel (reopens on page change)';
  closeBtn.onclick = function(){
    _diagManuallyClosed = true;
    _diagKeepOpen = false;
    clearTimeout(_diagAutoHideTimer);
    panel.style.opacity = '0';
    panel.style.transform = 'translateY(-12px)';
    panel.style.pointerEvents = 'none';
  };
  panel.appendChild(closeBtn);

  // 鼠标悬停时暂停自动隐藏
  panel.onmouseenter = function(){ _diagKeepOpen = true; };
  panel.onmouseleave = function(){ _diagKeepOpen = false; scheduleDiagAutoHide(); };

  var header = document.createElement('div');
  header.id = 'ts-diag-header';
  header.style.cssText = 'color:#4a9eff;font-weight:bold;margin-bottom:4px;';
  header.textContent = '🔧 LM Translate v2.0';
  panel.appendChild(header);
  var content = document.createElement('div');
  content.id = 'ts-diag-content';
  panel.appendChild(content);
  document.body.appendChild(panel);
}

// ===== 诊断面板自动隐藏 =====
function scheduleDiagAutoHide(delay) {
  clearTimeout(_diagAutoHideTimer);
  var ms = delay || 2500;
  _diagAutoHideTimer = setTimeout(function(){
    if (_diagKeepOpen) return;
    var panel = document.getElementById('ts-diag');
    if (!panel) return;
    panel.style.opacity = '0';
    panel.style.transform = 'translateY(-12px)';
    panel.style.pointerEvents = 'none';
  }, ms);
}

function showDiagPanel() {
  if (_diagManuallyClosed) return;
  var panel = document.getElementById('ts-diag');
  if (!panel) return;
  panel.style.opacity = '1';
  panel.style.transform = 'translateY(0)';
  panel.style.pointerEvents = 'auto';
}

function updateDiagVisibility() {
  var onDiscover = isDiscoverPage();
  var currentPage = location.hash || '';

  // 页面切换时重置手动关闭状态
  if (currentPage !== _lastDiagPage) {
    _diagManuallyClosed = false;
    _lastDiagPage = currentPage;
  }

  if (onDiscover && !_diagManuallyClosed) {
    showDiagPanel();
    scheduleDiagAutoHide(3000);
  }
}

// ===== 代理连通性检查 (静默) =====
var _proxyOnline = false;

async function checkProxyHealth() {
  try {
    var resp = await fetch(PROXY_URL + '/health');
    var data = await resp.json();
    _proxyOnline = !!(data && data.status === 'ok');
  } catch(e) { _proxyOnline = false; }
  updateFabIndicator(_proxyOnline);
}

function updateFabIndicator(online) {
  var fab = document.getElementById('ts-fab');
  if (!fab) return;
  var icon = online ? '🌐' : '⚠️';
  var label = online ? '翻译此页' : '翻译此页(离线)';
  if (fab.innerHTML.indexOf(label) === -1) {
    fab.innerHTML = icon + ' ' + label;
  }
  fab.style.borderColor = online ? '#4a9eff' : '#f87171';
  fab.style.color = online ? '#4a9eff' : '#f87171';
}

function updateDiagPanel() {
  var content = document.getElementById('ts-diag-content');
  if (!content) return;
  var hasTsApi = !!(window.tsApi && typeof window.tsApi.fetchJSON === 'function');
  var tsStatus = hasTsApi ? '<span style="color:#4aFF9e">● tsApi Ready</span>' :
    '<span style="color:#f87171">● tsApi N/A</span>';
  var wsStatus = _wsReady ? '<span style="color:#4aFF9e">● WS Connected</span>' :
    (_ws && _ws.readyState === WebSocket.CONNECTING ? '<span style="color:#fbbf24">◐ WS Connecting...</span>' :
    '<span style="color:#888">● WS Idle</span>');
  var wsState = _ws ? ['CONNECTING','OPEN','CLOSING','CLOSED'][_ws.readyState] : 'null';

  // 检查可用API
  var apiList = [];
  for (var k in window) {
    try {
      if (k === 'tsApi' || k === 'electronAPI' || k === 'electronAPIBase') {
        var v = window[k];
        var methods = [];
        if (v && typeof v === 'object') {
          for (var mk in v) {
            try { methods.push(mk + ':' + typeof v[mk]); } catch(e) {}
          }
        }
        apiList.push(k + ': ' + (methods.length ? methods.join(', ') : (typeof v)));
      }
    } catch(e) {}
  }
  var lines = [
    tsStatus + ' | ' + wsStatus + ' (state:'+wsState+')',
    'Translating: '+(_translating?'yes':'no')+' | Translated: '+(_translated?'yes':'no'),
    'Pending: '+Object.keys(_wsP).length,
    'APIs: '+(apiList.length ? apiList.join(' | ') : '(none)'),
    '---'
  ];
  var recent = _diagLog.slice(-80);
  for (var i = 0; i < recent.length; i++) {
    lines.push(recent[i]);
  }
  content.innerHTML = lines.join('<br>');
}

// ===== WebSocket 桥接 =====
function wsConnect() {
  // tsApi 可用时跳过WebSocket
  if (window.tsApi && typeof window.tsApi.fetchJSON === 'function') return;
  if (_ws && _ws.readyState === WebSocket.OPEN) return;
  diag('🔌 Connecting to ws://127.0.0.1:18999...');
  try {
    _ws = new WebSocket('ws://127.0.0.1:18999');
    _ws.onopen = function() {
      _wsReady = true;
      diag('✅ Bridge connected!');
      updateIndicator();
    };
    _ws.onmessage = function(e) {
      try {
        var msg = JSON.parse(e.data);
        if (msg.type === 'pong') return;
        if (msg.type === 'connected') { diag('📡 Welcome: v'+msg.version); return; }
        if ((msg.type === 'result' || msg.type === 'batch_result') && msg.id && _wsP[msg.id]) {
          var p = _wsP[msg.id];
          clearTimeout(p.timer);
          delete _wsP[msg.id];
          if (msg.ok) {
            diag('📥 Resolved: '+msg.id);
            p.resolve(msg.type === 'batch_result' ? msg.translations : msg.data);
          } else {
            diag('❌ Rejected: '+msg.id+' - '+msg.error);
            p.reject(new Error(msg.error || 'unknown'));
          }
        }
      } catch(ex) {}
    };
    _ws.onclose = function(e) {
      _wsReady = false;
      diag('🔌 Disconnected (code:'+e.code+')');
      updateIndicator();
      for (var id in _wsP) {
        clearTimeout(_wsP[id].timer);
        _wsP[id].reject(new Error('WebSocket closed'));
        delete _wsP[id];
      }
      _ws = null;
      setTimeout(wsConnect, 5000);
    };
    _ws.onerror = function(e) {
      diag('⚠️ WebSocket error');
      // onclose will fire next
    };
  } catch(e) {
    _wsReady = false;
    _ws = null;
    diag('❌ WS exception: '+e.message);
    setTimeout(wsConnect, 10000);
  }
}

function wsSend(msg) {
  if (!_ws || _ws.readyState !== WebSocket.OPEN) return false;
  try { _ws.send(JSON.stringify(msg)); return true; } catch(e) { return false; }
}

// 通过WebSocket发送翻译请求
function wsTranslate(q, from, to) {
  return new Promise(function(resolve, reject) {
    var id = 'r' + (++_wsSeq) + '_' + Date.now();
    var timer = setTimeout(function() {
      delete _wsP[id];
      reject(new Error('timeout'));
    }, 30000);
    _wsP[id] = { resolve: resolve, reject: reject, timer: timer };
    if (!wsSend({ type: 'translate', id: id, q: q, from: from, to: to })) {
      clearTimeout(timer);
      delete _wsP[id];
      reject(new Error('not connected'));
    }
  });
}

function wsBatch(texts, from, to) {
  return new Promise(function(resolve, reject) {
    var id = 'b' + (++_wsSeq) + '_' + Date.now();
    var timer = setTimeout(function() {
      delete _wsP[id];
      reject(new Error('timeout'));
    }, 60000);
    _wsP[id] = { resolve: resolve, reject: reject, timer: timer };
    if (!wsSend({ type: 'batch', id: id, texts: texts, from: from, to: to })) {
      clearTimeout(timer);
      delete _wsP[id];
      reject(new Error('not connected'));
    }
  });
}

function updateIndicator() {
  var fab = document.getElementById('ts-fab');
  if (fab) {
    var dot = fab.querySelector('.ts-bridge-dot');
    if (!dot) {
      dot = document.createElement('span');
      dot.className = 'ts-bridge-dot';
      dot.style.cssText = 'display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;';
      fab.insertBefore(dot, fab.firstChild);
    }
    dot.style.background = _wsReady ? '#4aFF9e' : '#f87171';
    dot.style.boxShadow = _wsReady ? '0 0 6px #4aFF9e' : '0 0 6px #f87171';
  }
}

// ===== v2.0 采集引擎 + 调试接口 =====

// 从DOM提取纯文本（递归，跳过script/style）
function extractText(el, max) {
  if (!el || el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'NOSCRIPT') return '';
  if (max !== undefined && max <= 0) return '';
  var txt = '';
  for (var ci = 0; ci < el.childNodes.length; ci++) {
    var cn = el.childNodes[ci];
    if (cn.nodeType === 3) {
      txt += cn.textContent;
    } else if (cn.nodeType === 1 && cn.children.length === 0) {
      txt += (cn.textContent || '');
    } else if (cn.nodeType === 1) {
      txt += extractText(cn, max !== undefined ? max - txt.length : undefined);
    }
    if (max !== undefined && txt.length >= max) break;
  }
  return txt;
}

// 从卡片DOM提取模型数据
function extractModelCard(card, idx) {
  var data = { id: 'card-' + idx };
  var allText = (card.textContent || '').trim();

  // 模型名称: 通常是大文本的第一个h或strong
  var headings = card.querySelectorAll('h1,h2,h3,h4,h5,h6,strong,[class*="name"],[class*="title"]');
  if (headings.length > 0) {
    data.name = (headings[0].textContent || '').trim();
  }

  // 作者: 常见 pattern "by AuthorName" 或第二个 small 文本
  var smalls = card.querySelectorAll('span,small,p');
  for (var si = 0; si < smalls.length; si++) {
    var st = (smalls[si].textContent || '').trim();
    if (st.length > 3 && st.length < 60 && st !== data.name) {
      if (!data.author && (st.indexOf('by ') === 0 || /^[A-Z][a-z]+$/.test(st) || st.indexOf('/') > 0)) {
        data.author = st.replace(/^by /, '');
      }
    }
  }

  // 能力/标签
  var tags = [];
  var tagEls = card.querySelectorAll('[class*="tag"],[class*="badge"],[class*="pill"],span');
  for (var ti = 0; ti < tagEls.length; ti++) {
    var tt = (tagEls[ti].textContent || '').trim();
    if (tt.length >= 2 && tt.length <= 25 && tt !== data.name && tt !== data.author) {
      tags.push(tt);
    }
  }
  data.tags = tags.slice(0, 12);
  data.capabilities = [];

  // 描述
  var descEls = card.querySelectorAll('p,[class*="desc"],[class*="summary"]');
  for (var di = 0; di < descEls.length; di++) {
    var dt = (descEls[di].textContent || '').trim();
    if (dt.length > 30 && dt !== data.name) {
      data.description = dt.substring(0, 300);
      break;
    }
  }

  // 数字统计 (下载量、likes、size)
  var numPattern = /(\d+\.?\d*[KMB]?)\s*(download|like|star|pull|view)/i;
  var match = allText.match(numPattern);
  if (match) data.downloads = match[1] + ' ' + match[2];

  var sizeMatch = allText.match(/(\d+\.?\d*[KMB]?\s*(B|parameters?|params?))/i);
  if (sizeMatch) data.size = sizeMatch[1];

  // Fallback: 提取全部可见文本用作搜索
  data.rawText = allText.substring(0, 500);

  return data;
}

// 主采集函数
function scrapeDiscover() {
  var t0 = Date.now();
  var result = {
    version: '2.0',
    page: 'discover',
    url: location.hash || '/',
    timestamp: new Date().toISOString(),
    pageStats: { totalVisible: 0, scraped: 0, skipped: 0 },
    models: [],
  };

  // 策略1: 找 model card 容器
  var cards = document.querySelectorAll('[class*="card"],[class*="model"],[class*="item"],[class*="result"],[data-testid*="model"]');
  var cardSet = [];
  var seenText = new Set();

  for (var ci = 0; ci < cards.length; ci++) {
    var c = cards[ci];
    var ct = (c.textContent || '').trim();
    // 跳过非模型卡片（导航、侧边栏、按钮组）
    if (ct.length < 40) continue;
    if (ct.length > 5000) continue; // 太大的不是卡片
    var key = ct.substring(0, 60);
    if (seenText.has(key)) continue;
    seenText.add(key);

    // 检查是否包含典型模型特征
    var hasModelName = /[A-Z][a-z]+[\-\d]/.test(ct) || ct.indexOf('GGUF') > -1 ||
      ct.indexOf('model') > -1 || ct.indexOf('Model') > -1;
    if (hasModelName || cards.length < 30) {
      cardSet.push(c);
    }
  }

  // 策略2: 如果策略1找到太少，扫描所有 visible blocks
  if (cardSet.length < 3) {
    var allDivs = document.querySelectorAll('div,section,article,li');
    for (var di = 0; di < allDivs.length; di++) {
      var d = allDivs[di];
      var dt = (d.textContent || '').trim();
      if (dt.length < 60 || dt.length > 4000) continue;
      var dk = dt.substring(0, 60);
      if (seenText.has(dk)) continue;
      seenText.add(dk);
      if (/[A-Z][a-z]+[\-\d]/.test(dt) || dt.indexOf('GGUF') > -1) {
        cardSet.push(d);
      }
    }
  }

  result.pageStats.totalVisible = cardSet.length;
  var limit = Math.min(cardSet.length, 30);
  for (var mi = 0; mi < limit; mi++) {
    try {
      var model = extractModelCard(cardSet[mi], mi);
      if (model.name || model.author || (model.tags && model.tags.length > 0)) {
        result.models.push(model);
      } else {
        result.pageStats.skipped++;
      }
    } catch(e) {
      result.pageStats.skipped++;
    }
  }
  result.pageStats.scraped = result.models.length;
  result.scrapeMs = Date.now() - t0;

  audit('scrape_discover', { models: result.models.length, ms: result.scrapeMs });
  return result;
}

function scrapeRuntime() {
  var info = { gpu: 'unknown', backend: 'unknown', loadedModel: null, vramUsed: null };
  // 尝试从页面提取 GPU 信息 (LM Studio 可能在某处显示)
  var all = document.body.textContent || '';
  var gpuMatch = all.match(/(AMD|NVIDIA|Intel|Radeon|GeForce|RTX|RX)\s*[A-Za-z0-9\s]+?(GPU|Graphics|Ti|XT)/i);
  if (gpuMatch) info.gpu = gpuMatch[0].trim();

  var backendMatch = all.match(/(llama\.cpp|MLX|CUDA|ROCm|Vulkan|Metal|CPU)\s*(v?[\d.]+)?/i);
  if (backendMatch) info.backend = backendMatch[0].trim();

  // VRAM
  var vramMatch = all.match(/(\d+\.?\d*)\s*(GiB|GB|MiB|MB)\s*(free|used|VRAM)/i);
  if (vramMatch) info.vramUsed = vramMatch[0].trim();

  // Loaded model
  var modelMatch = all.match(/(currently loaded|active model|running)[:\s]*([A-Za-z0-9\-_\.]+)/i);
  if (modelMatch) info.loadedModel = modelMatch[2];

  return info;
}

window.__ts = {
  // v1.0 兼容
  state: function(){ return JSON.stringify({translating:_translating,translated:_translated,ws:_wsReady}); },
  test: async function(t){ try{var r=await wsTranslate(t||'hello','en','zh');return JSON.stringify(r);}catch(e){return'ERR:'+e.message;} },
  collect: function(){
    var items=[],seen=new Set(),scope=document.querySelector('main')||document.body;
    var els=scope.querySelectorAll('p,span,div,h1,h2,h3,h4,li');
    for(var i=0;i<els.length;i++){var el=els[i],t=(el.textContent||'').trim();
      if(t.length<30||t.length>1000||el.tagName==='BUTTON'||el.tagName==='INPUT')continue;
      var en=(t.match(/[a-zA-Z]/g)||[]).length;if(en<t.length*0.35)continue;
      var k=t.substring(0,50);if(seen.has(k))continue;seen.add(k);items.push(t.substring(0,100));
      if(items.length>=5)break;}return JSON.stringify(items);
  },
  debug: function(){ return JSON.stringify(scrapeDiscover()); },

  // v2.0 数据采集
  scrape: function(){
    var data = scrapeDiscover();
    if (data.models.length === 0) {
      audit('scrape_empty', { page: location.hash });
    }
    // 附加运行时信息
    data.runtime = scrapeRuntime();
    return data;
  },
  scrapeDiscover: scrapeDiscover,
  scrapeRuntime: scrapeRuntime,
  getAuditSummary: function(){
    return {
      buffered: _auditBuf.length,
      lastEntry: _auditBuf.length > 0 ? _auditBuf[_auditBuf.length - 1] : null,
      errors: _auditBuf.filter(function(e){ return e.event === 'error' || e.event === 'scrape_fail'; }).length,
    };
  },

  // 导出 (JSON string)
  export: function(){
    var data = window.__ts.scrape();
    return JSON.stringify(data, null, 2);
  },

  // 复制到剪贴板
  copyJSON: function(){
    var json = window.__ts.export();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(json).then(function(){
        audit('clipboard_copy', { size: json.length });
        showExportToast('✅ 已复制 ' + json.length + ' 字符');
      }).catch(function(){
        showExportToast('❌ 复制失败，请手动选择');
      });
    } else {
      // Fallback
      var ta = document.createElement('textarea');
      ta.value = json; ta.style.cssText = 'position:fixed;left:-9999px;';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); showExportToast('✅ 已复制'); } catch(e) { showExportToast('❌ 复制失败'); }
      document.body.removeChild(ta);
    }
  },
};

// ===== 纯JS MD5 (UTF-8 safe) =====
function md5(s){
  var hc='0123456789abcdef';
  function rh(n){var j,s='';for(j=0;j<=3;j++)s+=hc.charAt((n>>(j*8+4))&0x0F)+hc.charAt((n>>(j*8))&0x0F);return s}
  function ad(x,y){var l=(x&0xFFFF)+(y&0xFFFF);var m=(x>>16)+(y>>16)+(l>>16);return(m<<16)|(l&0xFFFF)}
  function rl(n,c){return(n<<c)|(n>>>(32-c))}
  function cm(q,a,b,x,s,t){return ad(rl(ad(ad(a,q),ad(x,t)),s),b)}
  function ff(a,b,c,d,x,s,t){return cm((b&c)|((~b)&d),a,b,x,s,t)}
  function gg(a,b,c,d,x,s,t){return cm((b&d)|(c&(~d)),a,b,x,s,t)}
  function hh(a,b,c,d,x,s,t){return cm(b^c^d,a,b,x,s,t)}
  function ii(a,b,c,d,x,s,t){return cm(c^(b|(~d)),a,b,x,s,t)}
  function sb(x){
    // UTF-8 encode for correct non-ASCII hashing
    var bytes=[],i,c;
    for(i=0;i<x.length;i++){
      c=x.charCodeAt(i);
      if(c<0x80){bytes.push(c)}
      else if(c<0x800){bytes.push(0xC0|(c>>6));bytes.push(0x80|(c&0x3F))}
      else if(c<0xD800||c>=0xE000){bytes.push(0xE0|(c>>12));bytes.push(0x80|((c>>6)&0x3F));bytes.push(0x80|(c&0x3F))}
      else{i++;c=0x10000+((c&0x3FF)<<10)+(x.charCodeAt(i)&0x3FF);bytes.push(0xF0|(c>>18));bytes.push(0x80|((c>>12)&0x3F));bytes.push(0x80|((c>>6)&0x3F));bytes.push(0x80|(c&0x3F))}
    }
    var nblk=((bytes.length+8)>>6)+1,blks=new Array(nblk*16);for(i=0;i<nblk*16;i++)blks[i]=0;
    for(i=0;i<bytes.length;i++)blks[i>>2]|=bytes[i]<<((i%4)<<3);
    blks[i>>2]|=0x80<<((i%4)<<3);blks[nblk*16-2]=bytes.length*8;return blks;
  }
  var x=sb(s),a=1732584193,b=-271733879,c=-1732584194,d=271733878;
  for(var i=0;i<x.length;i+=16){
    var oa=a,ob=b,oc=c,od=d;
    a=ff(a,b,c,d,x[i+ 0],7 ,-680876936);d=ff(d,a,b,c,x[i+ 1],12,-389564586);c=ff(c,d,a,b,x[i+ 2],17, 606105819);b=ff(b,c,d,a,x[i+ 3],22,-1044525330);
    a=ff(a,b,c,d,x[i+ 4],7 ,-176418897);d=ff(d,a,b,c,x[i+ 5],12, 1200080426);c=ff(c,d,a,b,x[i+ 6],17,-1473231341);b=ff(b,c,d,a,x[i+ 7],22,-45705983);
    a=ff(a,b,c,d,x[i+ 8],7 , 1770035416);d=ff(d,a,b,c,x[i+ 9],12,-1958414417);c=ff(c,d,a,b,x[i+10],17,-42063);b=ff(b,c,d,a,x[i+11],22,-1990404162);
    a=ff(a,b,c,d,x[i+12],7 , 1804603682);d=ff(d,a,b,c,x[i+13],12,-40341101);c=ff(c,d,a,b,x[i+14],17,-1502002290);b=ff(b,c,d,a,x[i+15],22, 1236535329);
    a=gg(a,b,c,d,x[i+ 1],5 ,-165796510);d=gg(d,a,b,c,x[i+ 6],9 ,-1069501632);c=gg(c,d,a,b,x[i+11],14, 643717713);b=gg(b,c,d,a,x[i+ 0],20,-373897302);
    a=gg(a,b,c,d,x[i+ 5],5 ,-701558691);d=gg(d,a,b,c,x[i+10],9 , 38016083);c=gg(c,d,a,b,x[i+15],14,-660478335);b=gg(b,c,d,a,x[i+ 4],20,-405537848);
    a=gg(a,b,c,d,x[i+ 9],5 , 568446438);d=gg(d,a,b,c,x[i+14],9 ,-1019803690);c=gg(c,d,a,b,x[i+ 3],14,-187363961);b=gg(b,c,d,a,x[i+ 8],20, 1163531501);
    a=gg(a,b,c,d,x[i+13],5 ,-1444681467);d=gg(d,a,b,c,x[i+ 2],9 ,-51403784);c=gg(c,d,a,b,x[i+ 7],14, 1735328473);b=gg(b,c,d,a,x[i+12],20,-1926607734);
    a=hh(a,b,c,d,x[i+ 5],4 ,-378558);d=hh(d,a,b,c,x[i+ 8],11,-2022574463);c=hh(c,d,a,b,x[i+11],16, 1839030562);b=hh(b,c,d,a,x[i+14],23,-35309556);
    a=hh(a,b,c,d,x[i+ 1],4 ,-1530992060);d=hh(d,a,b,c,x[i+ 4],11, 1272893353);c=hh(c,d,a,b,x[i+ 7],16,-155497632);b=hh(b,c,d,a,x[i+10],23,-1094730640);
    a=hh(a,b,c,d,x[i+13],4 , 681279174);d=hh(d,a,b,c,x[i+ 0],11,-358537222);c=hh(c,d,a,b,x[i+ 3],16,-722521979);b=hh(b,c,d,a,x[i+ 6],23, 76029189);
    a=hh(a,b,c,d,x[i+ 9],4 ,-640364487);d=hh(d,a,b,c,x[i+12],11,-421815835);c=hh(c,d,a,b,x[i+15],16, 530742520);b=hh(b,c,d,a,x[i+ 2],23,-995338651);
    a=ii(a,b,c,d,x[i+ 0],6 ,-198630844);d=ii(d,a,b,c,x[i+ 7],10, 1126891415);c=ii(c,d,a,b,x[i+14],15,-1416354905);b=ii(b,c,d,a,x[i+ 5],21,-57434055);
    a=ii(a,b,c,d,x[i+12],6 , 1700485571);d=ii(d,a,b,c,x[i+ 3],10,-1894986606);c=ii(c,d,a,b,x[i+10],15,-1051523);b=ii(b,c,d,a,x[i+ 1],21,-2054922799);
    a=ii(a,b,c,d,x[i+ 8],6 , 1873313359);d=ii(d,a,b,c,x[i+15],10,-30611744);c=ii(c,d,a,b,x[i+ 6],15,-1560198380);b=ii(b,c,d,a,x[i+13],21, 1309151649);
    a=ii(a,b,c,d,x[i+ 4],6 ,-145523070);d=ii(d,a,b,c,x[i+11],10,-1120210379);c=ii(c,d,a,b,x[i+ 2],15, 718787259);b=ii(b,c,d,a,x[i+ 9],21,-343485551);
    a=ad(a,oa);b=ad(b,ob);c=ad(c,oc);d=ad(d,od);
  }
  return rh(a)+rh(b)+rh(c)+rh(d);
}

// ===== 百度翻译 (preload bridge > WebSocket > direct) =====
// SECURITY NOTE: 凭证仅用于本地127.0.0.1代理，不暴露到公网。
// 浏览器端凭证仅用于生成sign（不直接发送），核心翻译通过代理完成。
// 如需提升安全性，可将浏览器端凭证移除，翻译全部走代理。
var BAIDU_ID = '20260203002552175';
var BAIDU_KEY = 'waizdDTnFIhLvLAkCtwh';

function buildBaiduUrl(text, from, to) {
  var salt = Date.now().toString();
  var sign = md5(BAIDU_ID + text + salt + BAIDU_KEY);
  return 'https://fanyi-api.baidu.com/api/trans/vip/translate?q=' +
    encodeURIComponent(text) + '&from=' + from + '&to=' + to +
    '&appid=' + BAIDU_ID + '&salt=' + salt + '&sign=' + sign;
}

// ===== 翻译后端 (优先本地代理) =====
var PROXY_URL = 'http://127.0.0.1:18990';

async function tsFetch(url) {
  // 1. 本地代理 (最可靠，无CORS问题)
  try {
    // 从URL提取q参数构造代理请求
    var proxyUrl = new URL(url);
    var q = proxyUrl.searchParams.get('q');
    if (q) {
      var resp = await fetch(PROXY_URL + '/translate?q=' + encodeURIComponent(q) +
        '&from=' + (proxyUrl.searchParams.get('from') || 'en') +
        '&to=' + (proxyUrl.searchParams.get('to') || 'zh'));
      var data = await resp.json();
      if (data && data.ok && data.translations) {
        // 转换为百度格式兼容
        return { trans_result: data.translations.map(function(t){ return {dst:t}; }) };
      }
    }
  } catch(e) { diag('proxy fail: '+e.message); }

  // 2. preload 注入的 tsApi (Electron net module)
  if (window.tsApi && typeof window.tsApi.fetchJSON === 'function') {
    try {
      diag('🔄 tsApi fetch...');
      var data = await window.tsApi.fetchJSON(url);
      diag('✅ tsApi returned: ' + (data ? 'data' : 'null'));
      if (data) return data;
      diag('⚠️ tsApi returned null/undefined');
    } catch(e) {
      diag('❌ tsApi error: ' + (e.message || JSON.stringify(e)));
    }
  }

  // 3. WebSocket 桥接回退
  if (_wsReady) {
    try {
      var r = await fetch(url);
      return await r.json();
    } catch(e) { diag('ws fetch fail: '+e.message); }
  }

  // 4. 直接 fetch (可能被CORS拦截)
  try {
    var r = await fetch(url);
    return await r.json();
  } catch(e) { diag('direct fetch fail: '+e.message); return null; }
}

async function baiduBatch(texts, from, to) {
  if (!texts || !texts.length) return [];
  var combined = texts.join('\n|||\n');
  if (combined.length > 1800) {
    if (texts.length <= 1) {
      var s = texts[0];
      var m = Math.floor(s.length / 2);
      return await baiduBatch([s.substring(0, m), s.substring(m)], from, to);
    }
    var mid = Math.floor(texts.length / 2);
    var a = await baiduBatch(texts.slice(0, mid), from, to);
    var b = await baiduBatch(texts.slice(mid), from, to);
    if (!a || !b) return null;
    return a.concat(b);
  }

  // 优先本地代理 POST /batch
  try {
    diag('🔄 proxy batch ('+combined.length+' chars)...');
    var resp = await fetch(PROXY_URL + '/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts: texts, from: from, to: to }),
    });
    var data = await resp.json();
    if (data && data.ok && data.translations) {
      diag('✅ proxy batch: ' + data.translations.length + ' results');
      return data.translations;
    }
    diag('⚠️ proxy batch failed: ' + (data.error || 'unknown'));
  } catch(e) { diag('proxy batch err: ' + e.message); }

  // 回退: 拼接后通过 baidu 原始 API
  try {
    var url = buildBaiduUrl(combined, from, to);
    diag('🔗 API call ('+combined.length+' chars)...');
    var data = await tsFetch(url);
    if (!data || !data.trans_result) {
      var errMsg = data && data.error_code ? 'error_code='+data.error_code+' '+data.error_msg : 'no data';
      diag('❌ API error: ' + errMsg);
      return null;
    }
    diag('✅ API returned ' + data.trans_result.length + ' results');
    var allText = data.trans_result.map(function(r){ return r.dst; }).join('\n');
    return allText.split('\n|||\n').map(function(s){ return s.trim(); });
  } catch(e) {
    diag('❌ Exception: ' + (e.message || String(e)));
    return null;
  }
}

// ===== 中→英 搜索词典 =====
var dictEntries = [
  ['通义千问','qwen'],['大语言模型','large language model'],['图像生成','image generation'],
  ['代码生成','code generation'],['视觉模型','vision model'],['推理模型','reasoning model'],
  ['量化模型','quantized model'],['嵌入模型','embedding model'],['端侧模型','on-device model'],
  ['指令微调','instruct'],['指令模型','instruct model'],['基座模型','base model'],
  ['对话模型','chat model'],['开源模型','open source model'],['中文模型','chinese model'],
  ['轻量模型','lightweight model'],['角色扮演','roleplay'],['文本生成','text generation'],
  ['增强生成','RAG'],['长文本','long context'],['高效推理','efficient inference'],
  ['函数调用','function calling'],['工具调用','tool calling'],['合并模型','merge model'],
  ['多模态','multimodal'],['重排序','reranker'],['预训练','pretrained'],
  ['月之暗面','moonshot'],['零一万物','yi'],['蒸馏','distilled'],
  ['百川','baichuan'],['智谱','chatglm'],['书生','internlm'],['幻方','deepseek'],
  ['千问','qwen'],['文心','ernie'],['大模型','large model'],['小模型','small model'],
  ['对话','chat'],['中文','chinese'],['代码','code'],['搜索','search'],
  ['图像','image'],['语音','speech'],['模型','model'],['推理','reasoning'],
  ['翻译','translation'],['数学','math'],['编程','coding'],['写作','writing'],
  ['微调','fine-tuned']
].sort(function(a,b){ return b[0].length - a[0].length; });

function translateQuery(text) {
  if (!text || !/[一-鿿]/.test(text)) return text;
  var r = text;
  for (var i = 0; i < dictEntries.length; i++) {
    if (r.indexOf(dictEntries[i][0]) !== -1)
      r = r.replace(dictEntries[i][0], dictEntries[i][1]);
  }
  return r.replace(/\s+/g,' ').trim();
}

// ===== DOM 工具 =====
function findSearchInput() {
  var inp = document.querySelector('input[placeholder*="搜索模型"]');
  if (inp) return inp;
  var all = document.querySelectorAll('input[type="text"]:not([disabled])');
  for (var i=0;i<all.length;i++){if(all[i].getBoundingClientRect().width>300)return all[i];}
  return null;
}

function findSidebarContainer() {
  var chatBtn = document.querySelector('button[aria-label="Chat"]');
  if (chatBtn) return chatBtn.parentElement;
  var divs = document.querySelectorAll('div');
  for (var i=0;i<divs.length;i++){
    var s=getComputedStyle(divs[i]);
    if(s.flexDirection==='column'){var btns=divs[i].querySelectorAll('button');if(btns.length>=3&&btns.length<=6&&btns[0].getBoundingClientRect().width===28)return divs[i];}
  }
  return null;
}

// ===== 收集页面英文文本 =====
function isLayoutContainer(el) {
  var s = getComputedStyle(el);
  if (s.display === 'flex' || s.display === 'grid' || s.display === 'inline-flex' || s.display === 'inline-grid') return true;
  if (el.children.length > 3 && el.textContent.length > 200) return true;
  return false;
}

function collectTexts() {
  var items = [];
  var seen = new Set();

  // Main content area
  var scope = document.querySelector('main') || document.querySelector('#root') || document.body;
  if (scope.tagName === 'SPAN' || (scope.children && scope.children.length < 3)) {
    scope = document.body;
  }

  var tags = ['p','span','div','h1','h2','h3','h4','li','td','th','a','dd','dt','figcaption','label','summary'];

  var uiParents = 'nav,header,footer,aside,code,pre,[role="navigation"],[role="banner"],[role="menubar"],[role="tablist"],[role="search"],[role="combobox"],.ts-inline-tr,.ts-wrap,#ts-search-btn,#ts-page-btn,#ts-fab';

  var stats = { total: 0, skippedUI: 0, skippedLayout: 0, skippedSize: 0, skippedNear: 0, skippedText: 0, kept: 0 };

  for (var ti = 0; ti < tags.length; ti++) {
    var els = scope.querySelectorAll(tags[ti]);
    for (var ei = 0; ei < els.length; ei++) {
      var el = els[ei];
      stats.total++;

      // 1) Skip form controls
      var tn = el.tagName;
      if (tn === 'BUTTON' || tn === 'INPUT' || tn === 'TEXTAREA' || tn === 'SELECT' || tn === 'SVG' || tn === 'PATH') continue;

      // 2) Skip UI chrome by ancestor
      if (el.closest(uiParents)) { stats.skippedUI++; continue; }

      // 3) Skip already translated
      if (el.querySelector('.ts-inline-tr') || el.classList.contains('ts-inline-tr')) continue;

      // 4) Position-based filtering
      var rect = el.getBoundingClientRect();
      if (rect.width < 60 || rect.height < 14) { stats.skippedSize++; continue; }
      if (rect.x < 180) { stats.skippedUI++; continue; }
      if (rect.y < 55) { stats.skippedUI++; continue; }
      if (rect.y > window.innerHeight - 40) { stats.skippedUI++; continue; }

      // 5) Skip layout wrappers
      if (isLayoutContainer(el)) { stats.skippedLayout++; continue; }

      // 6) Skip if visually near a control
      var nearCtrl = el.closest('button,input,textarea,select,[role="button"]');
      if (nearCtrl && isNearControl(el, nearCtrl)) { stats.skippedNear++; continue; }

      var fullText = (el.textContent || '').trim();
      if (fullText.length < 16 || fullText.length > 3000) { stats.skippedText++; continue; }
      var enChars = (fullText.match(/[a-zA-Z]/g) || []).length;
      if (enChars < fullText.length * 0.28) { stats.skippedText++; continue; }

      var key = fullText.substring(0, 80);
      if (seen.has(key)) continue;
      seen.add(key);

      stats.kept++;
      items.push({ el: el, text: fullText });
    }
  }

  if (items.length === 0) {
    diag('⚠️ collectTexts: 0 items. scope=' + (scope.tagName || scope.id || scope.className || 'body') + ' total=' + stats.total + ' ui=' + stats.skippedUI + ' layout=' + stats.skippedLayout + ' near=' + stats.skippedNear + ' size=' + stats.skippedSize + ' text=' + stats.skippedText);
  } else {
    diag('📝 collectTexts: ' + items.length + ' kept/' + stats.total + ' scanned. ui=' + stats.skippedUI + ' layout=' + stats.skippedLayout + ' near=' + stats.skippedNear + ' size=' + stats.skippedSize + ' text=' + stats.skippedText + ' scope=' + (scope.tagName || scope.id || scope.className || 'body'));
  }
  return items;
}

// Check if element is visually near a control element
function isNearControl(el, ctrl) {
  if (!ctrl) return false;
  try {
    var r1 = el.getBoundingClientRect();
    var r2 = ctrl.getBoundingClientRect();
    var dx = Math.max(0, r1.left - r2.right, r2.left - r1.right);
    var dy = Math.max(0, r1.top - r2.bottom, r2.top - r1.bottom);
    return (dx < 50 && dy < 50);
  } catch(e) { return false; }
}

// ===== 内联翻译 =====
async function doInlineTranslate(btn) {
  if (_translating) return;
  _translating = true;

  try {
    removeTranslations();
    var items = collectTexts();
    LOG('Found', items.length, 'text segments');

    if (!items.length) {
      if (btn) { btn.innerHTML = '📭 无英文'; btn.style.pointerEvents = 'auto'; }
      _translating = false;
      return;
    }

    if (btn) {
      btn.innerHTML = '⏳ 翻译中… 0/' + items.length;
      btn.style.pointerEvents = 'none';
    }

    var texts = items.map(function(i){return i.text;});
    var translations = await baiduBatch(texts, 'en', 'zh');

    if (!translations) {
      diag('❌ Translation FAILED — check above for API error');
      if (btn) {
        btn.innerHTML = '❌ 失败，重试';
        btn.style.pointerEvents = 'auto';
      }
      _translating = false;
      return;
    }

    LOG('Got', translations.length, 'translations, inserting...');
    var inserted = 0;
    for (var i = 0; i < Math.min(translations.length, items.length); i++) {
      var zh = translations[i];
      var el = items[i].el;
      if (!zh || !el || !el.isConnected) continue;
      // 防止重复翻译
      if (el.querySelector('.ts-inline-tr')) continue;

      // ★ 安全方式：追加翻译为子节点，不移动/包裹原元素
      // 这样不会破坏 React 虚拟 DOM
      var trSpan = document.createElement('span');
      trSpan.className = 'ts-inline-tr';
      trSpan.style.cssText =
        'display:block;padding:4px 0 0 0;'+
        'font-size:0.88em;line-height:1.5;'+
        'color:#93c5fd;font-family:system-ui,-apple-system,sans-serif;';
      trSpan.innerHTML = '<span style="color:#4a9eff;font-size:0.8em;margin-right:4px;">🇨🇳</span>' +
        zh.replace(/</g,'&lt;').replace(/>/g,'&gt;');

      // 纯追加 — 不移动任何现有元素
      el.appendChild(trSpan);
      inserted++;
    }

    _translated = true;
    LOG('Wrapped', inserted, 'inline translations');

    if (btn) {
      btn.innerHTML = '🔄 还原';
      btn.style.pointerEvents = 'auto';
      btn.style.background = 'rgba(74,255,158,0.2)';
      btn.style.color = '#4aFF9e';
      btn.style.borderColor = '#4aFF9e';
    }
  } catch(e) {
    diag('❌ doInlineTranslate ERROR: ' + (e.message || String(e)));
    if (btn) { btn.innerHTML = '❌ ' + (e.message || '错误').substring(0, 20); btn.style.pointerEvents = 'auto'; }
  }
  _translating = false;
  updateFabState();
  updatePageBtn();
}

// ===== 还原翻译 =====
function removeTranslations() {
  var all = document.querySelectorAll('.ts-inline-tr');
  for (var j = all.length - 1; j >= 0; j--) {
    all[j].remove();
  }
  _translated = false;
}

// ===== 搜索框翻译按钮 =====
function injectSearchBtn() {
  if (document.getElementById('ts-search-btn')) return;
  var inp = findSearchInput();
  if (!inp) return;
  var parent = inp.parentElement;
  if (!parent || parent.querySelector('#ts-search-btn')) return;
  if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';

  var btn = document.createElement('button');
  btn.id = 'ts-search-btn';
  btn.innerHTML = '🌐 翻译';
  btn.title = '中文搜索词→英文';
  btn.style.cssText = 'position:absolute;right:70px;top:50%;transform:translateY(-50%);z-index:100;'+
    'cursor:pointer;padding:4px 12px;border-radius:6px;border:2px solid #4a9eff;'+
    'background:rgba(74,158,255,0.15);color:#4a9eff;font-size:13px;font-weight:bold;'+
    'white-space:nowrap;pointer-events:auto;transition:all 0.2s';

  btn.onmouseenter = function(){btn.style.background='rgba(74,158,255,0.3)';btn.style.boxShadow='0 0 8px rgba(74,158,255,0.3)';};
  btn.onmouseleave = function(){btn.style.background='rgba(74,158,255,0.15)';btn.style.boxShadow='none';};
  btn.onclick = function(e){
    e.preventDefault();e.stopPropagation();
    var val = inp.value.trim();
    if(!val||!/[一-鿿]/.test(val))return;
    var t = translateQuery(val);
    if(t&&t!==val){
      var ns = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
      ns.call(inp,t);inp.dispatchEvent(new Event('input',{bubbles:true}));
      inp.dispatchEvent(new Event('change',{bubbles:true}));
      btn.innerHTML='✅';btn.style.color='#4aFF9e';btn.style.borderColor='#4aFF9e';
      setTimeout(function(){btn.innerHTML='🌐 翻译';btn.style.color='#4a9eff';btn.style.borderColor='#4a9eff';},1500);
    }
  };
  parent.appendChild(btn);
}

// ===== 翻译整页按钮 =====
function injectPageBtn() {
  if (document.getElementById('ts-page-btn')) return;
  var inp = findSearchInput();
  if (!inp) return;
  var parent = inp.parentElement;
  if (!parent || parent.querySelector('#ts-page-btn')) return;
  if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';

  var btn = document.createElement('button');
  btn.id = 'ts-page-btn';
  btn.innerHTML = '🌐 翻译整页';
  btn.title = '英文描述→中文（显示在原文下方）';
  btn.style.cssText = 'position:absolute;right:160px;top:50%;transform:translateY(-50%);z-index:100;'+
    'cursor:pointer;padding:4px 12px;border-radius:6px;border:2px solid #4a9eff;'+
    'background:rgba(74,158,255,0.15);color:#4a9eff;font-size:13px;font-weight:bold;'+
    'white-space:nowrap;pointer-events:auto;transition:all 0.2s';

  btn.onmouseenter = function(){btn.style.background='rgba(74,158,255,0.3)';btn.style.boxShadow='0 0 8px rgba(74,158,255,0.3)';};
  btn.onmouseleave = function(){btn.style.background='rgba(74,158,255,0.15)';btn.style.boxShadow='none';};
  btn.onclick = function(e){
    e.preventDefault();e.stopPropagation();
    if (_translating) return;
    if (_translated) { removeTranslations(); updateFabState(); updatePageBtn(); }
    else { doInlineTranslate(btn); }
  };
  parent.appendChild(btn);
}

function updatePageBtn() {
  var btn = document.getElementById('ts-page-btn');
  if (!btn) return;
  if (_translated) {
    btn.innerHTML = '🔄 还原';
    btn.style.color='#4aFF9e';btn.style.borderColor='#4aFF9e';
    btn.style.background='rgba(74,255,158,0.15)';
  } else {
    btn.innerHTML = '🌐 翻译整页';
    btn.style.color='#4a9eff';btn.style.borderColor='#4a9eff';
    btn.style.background='rgba(74,158,255,0.15)';
  }
}

// ===== 页面检测 =====
function isDiscoverPage() {
  return location.hash.includes('discover') ||
         location.hash.includes('search') ||
         !!findSearchInput();
}

// ===== v2.0 DataBridge — 自动采集 + 推送到代理 =====
var _lastScrapeHash = '';
var _scrapeTimer = null;
var _scrapeDebounceMs = 1500;

function postToProxy(data) {
  return fetch(PROXY_URL + '/store', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }).then(function(r){ return r.json(); })
    .then(function(resp){
      if (resp.ok) {
        diag('📊 Synced ' + (data.models ? data.models.length : 0) + ' models → proxy');
        audit('sync_success', { models: data.models ? data.models.length : 0, path: resp.path });
      }
      return resp;
    })
    .catch(function(e){
      diag('⚠️ Sync failed: ' + e.message);
      audit('sync_fail', { error: e.message });
    });
}

function autoScrapeIfNeeded() {
  if (!isDiscoverPage()) return;
  var currentHash = location.hash || '/';
  // 同页面不重复采集
  if (currentHash === _lastScrapeHash) return;
  _lastScrapeHash = currentHash;

  clearTimeout(_scrapeTimer);
  _scrapeTimer = setTimeout(function(){
    diag('🔍 Auto-scraping...');
    audit('auto_scrape_start', {});
    try {
      var data = window.__ts.scrape();
      if (data.models && data.models.length > 0) {
        postToProxy(data);
      } else {
        diag('⚠️ Scrape returned 0 models');
        audit('scrape_empty', {});
      }
    } catch(e) {
      diag('❌ Scrape error: ' + e.message);
      audit('scrape_fail', { error: e.message });
    }
  }, _scrapeDebounceMs);
}

// ===== v2.0 导出 Toast =====
var _exportToastTimer = null;
function showExportToast(msg) {
  var toast = document.getElementById('ts-export-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'ts-export-toast';
    toast.style.cssText =
      'position:fixed;bottom:80px;right:24px;z-index:99999;'+
      'padding:8px 18px;border-radius:8px;font-size:13px;font-weight:bold;'+
      'background:rgba(74,158,255,0.2);color:#4a9eff;border:1px solid #4a9eff;'+
      'pointer-events:none;transition:all 0.3s ease;opacity:0;';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.opacity = '1';
  clearTimeout(_exportToastTimer);
  _exportToastTimer = setTimeout(function(){ toast.style.opacity = '0'; }, 2000);
}

// ===== v2.0 导出按钮 =====
function injectExportBtn() {
  if (document.getElementById('ts-export-btn')) return;
  var wrapper = document.getElementById('ts-fab-wrapper');
  if (!wrapper) return;

  var btn = document.createElement('button');
  btn.id = 'ts-export-btn';
  btn.innerHTML = '📋';
  btn.title = '复制模型数据 JSON';
  btn.style.cssText =
    'cursor:pointer;width:44px;height:44px;border-radius:50%;'+
    'border:2px solid #4a9eff;background:rgba(26,29,36,0.95);color:#4a9eff;'+
    'font-size:18px;display:flex;align-items:center;justify-content:center;'+
    'pointer-events:auto;transition:all 0.25s;margin-top:8px;'+
    'backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);'+
    'box-shadow:0 4px 20px rgba(0,0,0,0.5);';

  btn.onmouseenter = function(){
    btn.style.background='rgba(74,158,255,0.2)';
    btn.style.boxShadow='0 6px 28px rgba(74,158,255,0.3)';
  };
  btn.onmouseleave = function(){
    btn.style.background='rgba(26,29,36,0.95)';
    btn.style.boxShadow='0 4px 20px rgba(0,0,0,0.5)';
  };
  btn.onclick = function(e){
    e.preventDefault();e.stopPropagation();
    window.__ts.copyJSON();
  };

  wrapper.appendChild(btn);
}

function updateExportBtnVisibility() {
  var btn = document.getElementById('ts-export-btn');
  if (!btn) return;
  btn.style.display = isDiscoverPage() ? 'flex' : 'none';
}

// ===== FAB 浮动按钮 =====
function createFab() {
  if (document.getElementById('ts-fab')) return document.getElementById('ts-fab');

  var wrapper = document.createElement('div');
  wrapper.id = 'ts-fab-wrapper';
  wrapper.style.cssText =
    'position:fixed;bottom:24px;right:24px;z-index:99998;'+
    'pointer-events:none;'+
    'transition:transform 0.4s cubic-bezier(0.16,1,0.3,1), opacity 0.35s ease;';

  var fab = document.createElement('button');
  fab.id = 'ts-fab';
  fab.innerHTML = '🌐 翻译此页';
  fab.title = '翻译当前页面所有英文内容';
  fab.style.cssText =
    'cursor:pointer;padding:10px 20px;border-radius:24px;'+
    'border:2px solid #4a9eff;background:rgba(26,29,36,0.95);color:#4a9eff;'+
    'font-size:14px;font-weight:bold;white-space:nowrap;'+
    'pointer-events:auto;transition:all 0.25s;'+
    'backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);'+
    'box-shadow:0 4px 20px rgba(0,0,0,0.5);';

  fab.onmouseenter = function(){
    fab.style.background='rgba(74,158,255,0.2)';
    fab.style.boxShadow='0 6px 28px rgba(74,158,255,0.3)';
    fab.style.transform='translateY(-2px)';
  };
  fab.onmouseleave = function(){
    updateFabState();
    fab.style.transform='translateY(0)';
  };
  fab.onclick = function(e){
    e.preventDefault();e.stopPropagation();
    if (_translating) return;
    if (_translated) { removeTranslations(); updateFabState(); updatePageBtn(); }
    else { doInlineTranslate(fab); }
  };

  wrapper.appendChild(fab);
  document.body.appendChild(wrapper);

  // 初始隐藏
  updateFabVisibility();
  return fab;
}

// ===== FAB 可见性控制 =====
function updateFabVisibility() {
  var wrapper = document.getElementById('ts-fab-wrapper');
  if (!wrapper) return;
  var onDiscover = isDiscoverPage();
  if (onDiscover) {
    wrapper.style.opacity = '1';
    wrapper.style.transform = 'translateY(0)';
    wrapper.style.pointerEvents = 'auto';
  } else {
    wrapper.style.opacity = '0';
    wrapper.style.transform = 'translateY(100px)';
    wrapper.style.pointerEvents = 'none';
  }
}

function updateFabState() {
  var fab = document.getElementById('ts-fab');
  if (!fab) return;
  if (_translated) {
    fab.innerHTML = '🔄 还原英文';
    fab.style.background = 'rgba(74,255,158,0.15)';
    fab.style.color = '#4aFF9e';
    fab.style.borderColor = '#4aFF9e';
    fab.style.boxShadow = '0 4px 20px rgba(0,0,0,0.5)';
  } else {
    fab.innerHTML = '🌐 翻译此页';
    fab.style.background = 'rgba(26,29,36,0.95)';
    fab.style.color = '#4a9eff';
    fab.style.borderColor = '#4a9eff';
    fab.style.boxShadow = '0 4px 20px rgba(0,0,0,0.5)';
  }
}

function injectFab() { createFab(); updateFabState(); updateFabVisibility(); }

// ===== 侧边栏第5按钮 =====
function injectSidebarBtn() {
  var correctParent = findSidebarContainer();
  if (!correctParent) return;
  var existing = document.getElementById('ts-sidebar-btn');
  if (existing) {
    if (existing.parentElement === correctParent) return;
    existing.remove();
  }

  var btn = document.createElement('button');
  btn.id = 'ts-sidebar-btn';
  btn.innerHTML = '🌐';
  btn.title = '模型搜索 + 翻译';
  btn.setAttribute('aria-label','翻译搜索');
  btn.style.cssText = 'width:28px;height:28px;min-width:28px;min-height:28px;'+
    'cursor:pointer;border:none;background:transparent;color:#9ca3af;'+
    'display:flex;align-items:center;justify-content:center;'+
    'border-radius:6px;font-size:16px;padding:0;margin:0;'+
    'pointer-events:auto;transition:all 0.15s;';

  btn.onmouseenter = function(){btn.style.color='#4a9eff';btn.style.background='rgba(74,158,255,0.1)';};
  btn.onmouseleave = function(){updateSidebarActive();};
  btn.onclick = function(e){
    e.preventDefault();e.stopPropagation();
    history.pushState(null,'','#/discover');
    window.dispatchEvent(new PopStateEvent('popstate'));
    btn.style.color='#4aFF9e';
    setTimeout(updateSidebarActive,1500);
  };
  correctParent.appendChild(btn);
}

function updateSidebarActive() {
  var btn = document.getElementById('ts-sidebar-btn');
  if (!btn) return;
  if (location.hash.indexOf('discover') !== -1) {
    btn.style.color='#4a9eff';btn.style.background='rgba(74,158,255,0.1)';
  } else {
    btn.style.color='#9ca3af';btn.style.background='transparent';
  }
}

// ===== 路由变化清理 =====
function onRouteChange() {
  removeTranslations();
  _lastScrapeHash = ''; // v2.0: 重置采集状态，允许新页面自动采集
  updateFabState();
  updateFabVisibility();
  updateExportBtnVisibility();
  updateDiagVisibility();
  updatePageBtn();
  updateSidebarActive();
  setTimeout(function(){ injectSearchBtn(); injectPageBtn(); injectSidebarBtn(); injectFab(); injectExportBtn(); }, 800);
}

// ===== 注入所有 =====
function injectAll() {
  injectSearchBtn();
  injectPageBtn();
  injectSidebarBtn();
  injectFab();
  updateSidebarActive();
}

// ===== 启动 =====
var _bootAttempts = 0;
function waitForReady() {
  _bootAttempts++;
  if (document.querySelector('button[aria-label="Chat"]')) {
    diag('App ready (attempt '+_bootAttempts+')');
    createDiagPanel();

    // 验证 tsApi 双向通信
    if (window.tsApi && typeof window.tsApi.ping === 'function') {
      try {
        var pr = window.tsApi.ping();
        if (pr && typeof pr.then === 'function') {
          pr.then(function(v){ diag('🟢 tsApi ping: ' + v); })
            .catch(function(e){ diag('🔴 tsApi ping FAILED: ' + e.message); });
        } else {
          diag('🟢 tsApi ping: ' + pr);
        }
      } catch(e) {
        diag('🔴 tsApi ping FAILED: ' + e.message);
      }
    } else if (window.tsApi) {
      diag('🟡 tsApi exists but no ping method (old preload)');
    }

    // 先连接WebSocket桥接
    wsConnect();
    injectAll();

    // 检查代理连通性，无论成功与否2秒后自动隐藏面板
    checkProxyHealth();
    scheduleDiagAutoHide(2000);

    // v2.0 审计定时推送
    _auditTimer = setInterval(function(){ flushAudit(); }, _auditFlushInterval);

    // 自修复轮询
    setInterval(function(){
      checkProxyHealth();
      if (!_wsReady) wsConnect();
      injectSearchBtn();
      injectPageBtn();
      injectSidebarBtn();
      injectFab();
      injectExportBtn();
      autoScrapeIfNeeded();
      updateFabVisibility();
      updateExportBtnVisibility();
      updateDiagVisibility();
      updateSidebarActive();
      updatePageBtn();
      updateFabState();
      updateIndicator();
    }, 3000);

    window.addEventListener('popstate', onRouteChange);
    window.addEventListener('hashchange', onRouteChange);

    diag('v2.0 ready ✅');
    audit('boot', { version: '2.0' });
    return;
  }
  if (_bootAttempts < 120) setTimeout(waitForReady, 500);
}

waitForReady();

})();
