// IMAGE BEACON — 用img标签发请求，绕过fetch/XHR限制
(function() {
'use strict';

// Beacon 1: Image (no CORS)
var img = new Image();
img.src = 'http://127.0.0.1:18990/health?beacon=img';

// Beacon 2: sendBeacon (fire and forget)
try {
  if (navigator.sendBeacon) {
    navigator.sendBeacon('http://127.0.0.1:18990/health?beacon=sb', '{}');
  }
} catch(e) {}

// Also try fetch
try {
  fetch('http://127.0.0.1:18990/health?beacon=fetch')
    .then(function(r){ return r.json(); })
    .then(function(d){ console.log('FETCH_OK:', d); })
    .catch(function(e){ console.log('FETCH_FAIL:', e.message); });
} catch(e) { console.log('FETCH_ERR:', e.message); }

// And XHR
try {
  var xhr = new XMLHttpRequest();
  xhr.open('GET', 'http://127.0.0.1:18990/health?beacon=xhr');
  xhr.send();
} catch(e) { console.log('XHR_ERR:', e.message); }

// Create visible indicator
try {
  var el = document.createElement('div');
  el.id = '__ts_beacon';
  el.style.cssText = 'position:fixed;top:0;left:0;z-index:999999;width:100%;background:red;color:#fff;font:12px monospace;padding:4px;text-align:center;';
  el.textContent = 'BEACON ACTIVE — ' + new Date().toISOString();
  document.body.appendChild(el);
} catch(e) {}
})();
