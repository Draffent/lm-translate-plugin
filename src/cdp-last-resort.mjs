// Final tests: popup with CSP bypass, file:// script loading, etc.
import WebSocket from 'ws';
import http from 'node:http';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getPageWS() {
  const data = await new Promise((resolve) => {
    http.get('http://127.0.0.1:9222/json', (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    });
  });
  const page = data.find(t => t.type === 'page' && t.url && t.url.includes('index.html'));
  if (!page) throw new Error('No LM Studio page');
  console.log('Page:', page.title, '\n');
  return page.webSocketDebuggerUrl;
}

async function run() {
  const wsUrl = await getPageWS();
  const ws = new WebSocket(wsUrl);
  let msgId = 0;
  let pending = {};

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    const p = pending[msg.id];
    if (p) { delete pending[msg.id]; p.resolve(msg); }
  });

  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++msgId;
    pending[id] = { resolve, reject };
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending[id]) { delete pending[id]; reject(new Error('timeout')); } }, 15000);
  });

  const exec = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r.exceptionDetails) return { err: r.exceptionDetails.text };
    return r?.result?.result?.value;
  };

  async function injectAndCheck(fnBody, varName, waitMs) {
    varName = varName || '__iv_' + Date.now();
    await send('Runtime.evaluate', {
      expression: `(function(){var p=(${fnBody})();if(p&&typeof p.then==='function'){p.then(function(v){window['${varName}']=(typeof v==='string'?v:JSON.stringify(v));}).catch(function(e){window['${varName}']='ERR:'+(e.message||String(e));});}else{window['${varName}']='(sync)';}})()`,
      returnByValue: false,
    });
    await sleep(waitMs || 5000);
    const r = await send('Runtime.evaluate', {
      expression: `window['${varName}']||'(not set)'`,
      returnByValue: true
    });
    return r?.result?.result?.value;
  }

  ws.on('open', async () => {
    // === Test 1: <script> loading from rendered directory ===
    console.log('=== Test 1: <script> from file:// ===');
    // First, check if there are any existing <script> tags loading local files
    const scriptSrcs = await exec(`(function(){
      var ss = document.querySelectorAll('script[src]');
      return Array.from(ss).map(function(s){return s.getAttribute('src')||s.src}).join(', ');
    })()`);
    console.log('  existing scripts:', scriptSrcs);

    // Test loading a script with file://
    await injectAndCheck(`function(){
      return new Promise(function(resolve){
        try {
          window._testCB2 = function(v){ resolve('callback:'+JSON.stringify(v)); };
          var s = document.createElement('script');
          s.src = 'lm-translate.js';
          s.onload = function(){ resolve('script loaded ok'); };
          s.onerror = function(){ resolve('script error'); };
          document.head.appendChild(s);
          setTimeout(function(){ resolve('timeout'); }, 3000);
        } catch(e) { resolve('exc:' + e.message); }
      });
    }`, '__t1', 4000);
    console.log('  local script load:', await exec('window.__t1'));
    console.log();

    // === Test 2: Fetch a file: URL ===
    console.log('=== Test 2: fetch file:// URL ===');
    await injectAndCheck(`function(){
      return new Promise(function(resolve){
        try {
          fetch('lm-translate.js').then(function(r){return r.text()}).then(function(t){resolve('OK:'+t.substring(0,50))}).catch(function(e){resolve('FAIL:'+e.message)});
        } catch(e) { resolve('exc:'+e.message); }
      });
    }`, '__t2', 4000);
    console.log('  file fetch:', await exec('window.__t2'));
    console.log();

    // === Test 3: XHR file:// ===
    console.log('=== Test 3: XHR file:// ===');
    await injectAndCheck(`function(){
      return new Promise(function(resolve){
        try {
          var x=new XMLHttpRequest();
          x.open('GET', 'lm-translate.js');
          x.onload=function(){resolve('XHR OK:'+x.status+' len:'+(x.responseText||'').length);};
          x.onerror=function(){resolve('XHR ERR');};
          x.send();
        } catch(e) { resolve('exc:'+e.message); }
      });
    }`, '__t3', 4000);
    console.log('  file XHR:', await exec('window.__t3'));
    console.log();

    // === Test 4: BroadcaseChannel between main and popup ===
    console.log('=== Test 4: Popup with relaxed CSP ===');
    await injectAndCheck(`function(){
      return new Promise(function(resolve){
        try {
          var bc = new BroadcastChannel('lms-test');
          bc.onmessage = function(e) { window.__bcMsg = e.data; };

          var popup = window.open('', 'lms-bridge', 'width=400,height=300');
          if (!popup || popup.closed) { resolve('popup blocked'); return; }

          // Write HTML with relaxed CSP
          popup.document.write('<!DOCTYPE html><html><head>');
          popup.document.write('<meta http-equiv="Content-Security-Policy" content="default-src * 127.0.0.1:18990; connect-src * 127.0.0.1:18990; script-src * 127.0.0.1:18990  \\'unsafe-inline\\';">');
          popup.document.write('</head><body><scr' + 'ipt>');
          popup.document.write('var bc2 = new BroadcastChannel("lms-test");');
          popup.document.write('fetch("http://127.0.0.1:18990/health").then(function(r){return r.json()}).then(function(d){ bc2.postMessage("POPUP_OK:"+JSON.stringify(d)); }).catch(function(e){ bc2.postMessage("POPUP_FAIL:"+e.message); });');
          popup.document.write('</scr' + 'ipt></body></html>');
          popup.document.close();

          setTimeout(function(){
            resolve('popup result: ' + (window.__bcMsg || 'none'));
          }, 5000);
        } catch(e) { resolve('exc:' + e.message); }
      });
    }`, '__t4', 8000);
    console.log('  popup result:', await exec('window.__t4'));
    console.log();

    // === Test 5: electronAPI.getPathForFile with a File object ===
    console.log('=== Test 5: getPathForFile usage ===');
    await injectAndCheck(`function(){
      return new Promise(function(resolve){
        try {
          // Get the path for a script tag src
          var scripts = document.querySelectorAll('script[src]');
          for (var i = 0; i < scripts.length; i++) {
            var src = scripts[i].getAttribute('src') || '';
            if (src.indexOf('lm-translate') >= 0 || src.indexOf('main') >= 0) {
              resolve('Found script: ' + src);
              return;
            }
          }
          resolve('no matching script found');
        } catch(e) { resolve('exc:' + e.message); }
      });
    }`, '__t5', 3000);
    console.log('  script src:', await exec('window.__t5'));
    console.log();

    // === Test 6: Can we create an iframe with src pointing to proxy? ===
    console.log('=== Test 6: iframe with srcdoc ===');
    await injectAndCheck(`function(){
      return new Promise(function(resolve){
        try {
          // Close old popup
          if (window.__popup && !window.__popup.closed) window.__popup.close();

          var f = document.createElement('iframe');
          f.style.display = 'none';
          f.srcdoc = '<html><head><meta http-equiv="Content-Security-Policy" content="default-src *; connect-src *; script-src * 127.0.0.1:18990 \\'unsafe-inline\\';"></head><body><scr' + 'ipt>fetch("http://127.0.0.1:18990/health").then(function(r){return r.json()}).then(function(d){parent.document.title="IFRAME_OK:"+JSON.stringify(d)}).catch(function(e){parent.document.title="IFRAME_FAIL:"+e.message});</scr' + 'ipt></body></html>';
          document.body.appendChild(f);
          setTimeout(function() {
            resolve('iframe title: ' + document.title);
            f.remove();
          }, 5000);
        } catch(e) { resolve('exc:' + e.message); }
      });
    }`, '__t6', 7000);
    console.log('  iframe:', await exec('window.__t6'));
    console.log();

    // === Test 7: Can we IPC tunnel to make the main process fetch? ===
    console.log('=== Test 7: IPC httpServer with proper JSON-RPC ===');
    // The tunnel might use JSON-RPC 2.0 format
    await injectAndCheck(`function(){
      return new Promise(function(resolve){
        try {
          var sendFn = window.lmsHostedEnv.getApiIpcTunnel('httpServer', null,
            function(msg) { window.__ipc7 = 'GOT:' + JSON.stringify(msg).substring(0, 300); resolve(window.__ipc7); },
            function() { resolve('closed'); }
          );
          if (typeof sendFn !== 'function') { resolve('not a function'); return; }
          // Try JSON-RPC format
          sendFn({ jsonrpc: '2.0', method: 'fetch', params: { url: 'http://127.0.0.1:18990/health' }, id: 1 });
          setTimeout(function() { resolve('TIMEOUT: ' + (window.__ipc7 || 'none')); }, 5000);
        } catch(e) { resolve('exc:' + e.message); }
      });
    }`, '__t7', 7000);
    console.log('  IPC fetch:', await exec('window.__t7'));
    console.log();

    // === Test 8: IPC downloads with proper format ===
    console.log('=== Test 8: IPC downloads proper format ===');
    await injectAndCheck(`function(){
      return new Promise(function(resolve){
        try {
          var sendFn = window.lmsHostedEnv.getApiIpcTunnel('downloads', null,
            function(msg) { window.__ipc8 = 'GOT:' + JSON.stringify(msg).substring(0,300); resolve(window.__ipc8); },
            function() { resolve('closed'); }
          );
          if (typeof sendFn !== 'function') { resolve('not a fn'); return; }
          sendFn({ url: 'http://127.0.0.1:18990/health', method: 'GET', type: 'download' });
          setTimeout(function(){ resolve('TIMEOUT:' + (window.__ipc8 || 'none')); }, 5000);
        } catch(e) { resolve('exc:' + e.message); }
      });
    }`, '__t8', 7000);
    console.log('  downloads:', await exec('window.__t8'));
    console.log();

    ws.close();
    process.exit(0);
  });
}

run();
