// CDP IPC Tunnel Explorer v4 — step by step, simpler approach
import WebSocket from 'ws';
import http from 'node:http';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getLMStudioPageWS() {
  const data = await new Promise((resolve) => {
    http.get('http://127.0.0.1:9222/json', (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    });
  });
  const page = data.find(t => t.type === 'page' && t.url && t.url.includes('index.html'));
  if (!page) throw new Error('No LM Studio page');
  return { wsUrl: page.webSocketDebuggerUrl, pageUrl: page.url, targetId: page.id };
}

async function run() {
  const { wsUrl, targetId } = await getLMStudioPageWS();
  console.log('Target:', targetId);
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
    setTimeout(() => { if (pending[id]) { delete pending[id]; reject(new Error('timeout:' + method)); } }, 15000);
  });

  const exec = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r.exceptionDetails) return { err: r.exceptionDetails.text || r.exceptionDetails.exception?.description };
    return r?.result?.result?.value;
  };

  // Simplified async: inject function, wait, read result from window var
  async function injectAndCheck(fnBody, varName, waitMs) {
    varName = varName || '__iv_' + Date.now();
    // Inject
    await send('Runtime.evaluate', {
      expression: `(function(){ var p = (${fnBody})(); if(p && typeof p.then === 'function') { p.then(function(v){ window['${varName}'] = (typeof v==='string'?v:JSON.stringify(v)); }).catch(function(e){ window['${varName}'] = 'ERR:'+(e.message||String(e)); }); } else { window['${varName}'] = '(sync)'; } })()`,
      returnByValue: false,
    });
    // Wait
    await sleep(waitMs || 5000);
    // Read
    const r = await send('Runtime.evaluate', {
      expression: `(function(){ var v = window['${varName}']; delete window['${varName}']; return v || '(not set)'; })()`,
      returnByValue: true,
    });
    return r?.result?.result?.value;
  }

  ws.on('open', async () => {
    console.log('Connected\n');

    // ===== 0: Check pre-reqs =====
    console.log('=== Pre-check ===');
    console.log('  lmsHostedEnv:', await exec('typeof window.lmsHostedEnv'));
    console.log('  hash:', await exec('location.hash'));

    const fnType = await exec(`(function(){
      var fn = window.lmsHostedEnv && window.lmsHostedEnv.getApiIpcTunnel;
      return fn ? 'getApiIpcTunnel type: ' + typeof fn : 'N/A';
    })()`);
    console.log('  ', fnType);
    console.log();

    // ===== 1: Create tunnel and call it =====
    console.log('=== 1. httpServer IPC test ===');
    const r1 = await injectAndCheck(`function(){
      return new Promise(function(resolve){
        try {
          var sendFn = window.lmsHostedEnv.getApiIpcTunnel('httpServer', null,
            function(msg) { window.__ipc_r1 = 'GOT:' + JSON.stringify(msg).substring(0,200); resolve(window.__ipc_r1); },
            function() { resolve('closed'); }
          );
          if (typeof sendFn !== 'function') { resolve('not a fn: ' + typeof sendFn); return; }
          sendFn({ method: 'listServers', params: {} });
          setTimeout(function(){ resolve('TIMEOUT:' + (window.__ipc_r1 || 'none')); }, 6000);
        } catch(e) { resolve('ERR:' + e.message); }
      });
    }`, '__ipcR1', 8000);
    console.log('  httpServer:', r1);
    console.log();

    // ===== 2: llm IPC =====
    console.log('=== 2. llm IPC test ===');
    const r2 = await injectAndCheck(`function(){
      return new Promise(function(resolve){
        try {
          var sendFn = window.lmsHostedEnv.getApiIpcTunnel('llm', null,
            function(msg) { window.__ipc_r2 = 'GOT:' + JSON.stringify(msg).substring(0,200); resolve(window.__ipc_r2); },
            function() { resolve('closed'); }
          );
          if (typeof sendFn !== 'function') { resolve('not fn: ' + typeof sendFn); return; }
          sendFn({ method: 'listModels', params: {} });
          setTimeout(function(){ resolve('TIMEOUT:' + (window.__ipc_r2 || 'none')); }, 6000);
        } catch(e) { resolve('ERR:' + e.message); }
      });
    }`, '__ipcR2', 8000);
    console.log('  llm:', r2);
    console.log();

    // ===== 3: downloads IPC (might have HTTP fetch capability) =====
    console.log('=== 3. downloads IPC ===');
    const r3 = await injectAndCheck(`function(){
      return new Promise(function(resolve){
        try {
          var sendFn = window.lmsHostedEnv.getApiIpcTunnel('downloads', null,
            function(msg) { window.__ipc_r3 = 'GOT:' + JSON.stringify(msg).substring(0,200); resolve(window.__ipc_r3); },
            function() { resolve('closed'); }
          );
          if (typeof sendFn !== 'function') { resolve('not fn: ' + typeof sendFn); return; }
          sendFn({ action: 'fetch', url: 'http://127.0.0.1:18990/health', method: 'GET' });
          setTimeout(function(){ resolve('TIMEOUT:' + (window.__ipc_r3 || 'none')); }, 6000);
        } catch(e) { resolve('ERR:' + e.message); }
      });
    }`, '__ipcR3', 8000);
    console.log('  downloads:', r3);
    console.log();

    // ===== 4: Worker HTTP request =====
    console.log('=== 4. Web Worker HTTP ===');
    const r4 = await injectAndCheck(`function(){
      return new Promise(function(resolve){
        try {
          var code = 'onmessage=function(e){' +
            'try{fetch("http://127.0.0.1:18990/health").then(function(r){return r.json()}).then(function(d){postMessage("OK:"+JSON.stringify(d))}).catch(function(e){postMessage("HTTP_FAIL:"+e.message)})}' +
            'catch(e){postMessage("EXCEPTION:"+e.message)}};';
          var blob = new Blob([code], {type:'application/javascript'});
          var url = URL.createObjectURL(blob);
          var w = new Worker(url);
          w.onmessage = function(e) { window._wkR = e.data; resolve('Worker:' + e.data); };
          w.onerror = function(e) { resolve('WorkerErr:' + e.message); };
          w.postMessage('go');
          setTimeout(function() { resolve('WTIMEOUT:' + (window._wkR || 'none')); w.terminate(); }, 6000);
        } catch(e) { resolve('EXC:' + e.message); }
      });
    }`, '__ipcR4', 8000);
    console.log('  Worker:', r4);
    console.log();

    // ===== 5: window.open + fetch from popup =====
    console.log('=== 5. window.open + fetch ===');
    // Clean up old popup first
    const r5 = await injectAndCheck(`function(){
      return new Promise(function(resolve){
        try {
          // Close existing popup
          if (window.__popup && !window.__popup.closed) window.__popup.close();
          var popup = window.open('about:blank', 'lms-proxy', 'width=400,height=300,left=100,top=100');
          if (!popup || popup.closed) { resolve('popup blocked'); return; }
          window.__popup = popup;
          // Wait for popup to load
          popup.onload = function() {
            // Try writing a script that does fetch
            try {
              popup.document.write('<html><body><scr' + 'ipt>');
              popup.document.write('fetch("http://127.0.0.1:18990/health").then(function(r){return r.json()}).then(function(d){document.title="OK:"+JSON.stringify(d)}).catch(function(e){document.title="FAIL:"+e.message});');
              popup.document.write('</scr' + 'ipt></body></html>');
              popup.document.close();
              setTimeout(function() {
                resolve('popup title: ' + popup.document.title);
              }, 4000);
            } catch(e) { resolve('popup write error: ' + e.message); }
          };
          setTimeout(function() { resolve('popup timeout, title: ' + (popup.document ? popup.document.title : 'no doc')); }, 6000);
        } catch(e) { resolve('EXC:' + e.message); }
      });
    }`, '__ipcR5', 8000);
    console.log('  popup:', r5);
    console.log();

    console.log('========== DONE ==========');
    ws.close();
    process.exit(0);
  });
}

run();
