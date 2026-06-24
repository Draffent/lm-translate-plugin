// MINIMAL TEST — 验证fetch能否连接代理
(function() {
'use strict';
var P = 'http://127.0.0.1:18990';
var start = Date.now();
var log = [];

function addLog(msg) {
  log.push((Date.now()-start) + 'ms: ' + msg);
  // 写入DOM方便查看
  try {
    var el = document.getElementById('__ts_test_log');
    if (!el) {
      el = document.createElement('div');
      el.id = '__ts_test_log';
      el.style.cssText = 'position:fixed;top:0;left:0;z-index:999999;width:100%;background:#111;color:#0f0;font:11px monospace;padding:8px;max-height:200px;overflow:auto;';
      document.body.appendChild(el);
    }
    el.textContent = log.join('\n');
  } catch(e) {}
}

addLog('Test started');

// Test 1: fetch
addLog('Test 1: fetch to /health...');
fetch(P + '/health')
  .then(function(r) { return r.json(); })
  .then(function(d) {
    addLog('✅ fetch OK: ' + JSON.stringify(d));
    // Test 2: fetch POST /store
    addLog('Test 2: fetch POST /store...');
    return fetch(P + '/store', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({test: true, ts: new Date().toISOString()})
    });
  })
  .then(function(r) { return r.json(); })
  .then(function(d) {
    addLog('✅ POST /store OK: ' + JSON.stringify(d));
  })
  .catch(function(e) {
    addLog('❌ FAIL: ' + e.message);
    // Test fallback: XHR
    addLog('Test fallback: XHR...');
    var xhr = new XMLHttpRequest();
    xhr.open('GET', P + '/health');
    xhr.onload = function() { addLog('✅ XHR OK: ' + xhr.responseText.substring(0, 100)); };
    xhr.onerror = function() { addLog('❌ XHR FAILED'); };
    xhr.send();
  });
})();
