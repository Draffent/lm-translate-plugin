// CDP Test Harness v7 — focus on electronAPI + proxy log check
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
  return data.find(t => t.type === 'page').webSocketDebuggerUrl;
}

async function run() {
  const wsUrl = await getPageWS();
  console.log('Target:', wsUrl, '\n');

  let msgId = 0;
  let ws;
  let pending = {};

  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++msgId;
      pending[id] = { resolve, reject };
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (pending[id]) { delete pending[id]; reject(new Error('timeout')); } }, 30000);
    });
  }

  async function exec(expr, awaitP = false) {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: awaitP });
    if (r.exceptionDetails) return { error: r.exceptionDetails.text };
    return r?.result?.result?.value;
  }

  async function execAsyncFn(label, fnBody, timeoutMs = 10000) {
    const varName = '__cdpA_' + Date.now() + '_' + Math.floor(Math.random() * 99999);
    const code = `(function(){var p=(${fnBody})();if(p&&typeof p.then==='function'){p.then(function(v){window['${varName}']=(typeof v==='string'?v:JSON.stringify(v));},function(e){window['${varName}']='ERR:'+(e.message||e);});}else{window['${varName}']='(sync)';}})()`;
    process.stdout.write(`  ${label} ... `);
    await send('Runtime.evaluate', { expression: code, awaitPromise: false });
    await sleep(timeoutMs);
    const r = await send('Runtime.evaluate', {
      expression: `window['${varName}']||'(not set)'`,
      returnByValue: true,
    });
    const val = r?.result?.result?.value;
    console.log(val ? (typeof val === 'string' ? val.substring(0, 400) : String(val).substring(0, 400)) : '(empty)');
    return val;
  }

  ws = new WebSocket(wsUrl);
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    const p = pending[msg.id];
    if (p) { delete pending[msg.id]; p.resolve(msg); }
  });

  ws.on('open', async () => {
    console.log('Connected\n');

    // ===== PHASE 1: electronAPI deep dive =====
    console.log('=== PHASE 1: electronAPI investigation ===');
    console.log('  typeof electronAPI:', await exec('typeof window.electronAPI'));

    // Get ALL keys (methods and properties)
    const keys = await exec(`(function(){
      if(!window.electronAPI) return 'N/A';
      return Object.getOwnPropertyNames(window.electronAPI).join(', ');
    })()`);
    console.log('  electronAPI methods:', keys);

    // Check each key's type
    const methodTypes = await exec(`(function(){
      if(!window.electronAPI) return 'N/A';
      var r = {};
      var ks = Object.getOwnPropertyNames(window.electronAPI);
      ks.forEach(function(k){
        var v = window.electronAPI[k];
        r[k] = typeof v;
        if(typeof v === 'function') r[k] += '(' + v.length + 'params)';
      });
      return JSON.stringify(r);
    })()`);
    console.log('  method types:', methodTypes);

    // Also check electronAPIBase
    const baseKeys = await exec(`(function(){
      if(!window.electronAPIBase) return 'N/A';
      return Object.getOwnPropertyNames(window.electronAPIBase).join(', ');
    })()`);
    console.log('  electronAPIBase keys:', baseKeys);
    console.log();

    // ===== PHASE 2: electronAPI methods that can make HTTP requests =====
    console.log('=== PHASE 2: Testing electronAPI HTTP methods ===');

    // Try platforms.shell.openExternal or similar
    console.log('  Checking for HTTP-capable methods...');

    // Test: Does electronAPI have a fetch-like method?
    const fetchMethod = await exec(`(function(){
      if(!window.electronAPI) return 'none';
      var ks = Object.getOwnPropertyNames(window.electronAPI);
      var httpRelated = ks.filter(function(k){
        var kl = k.toLowerCase();
        return kl.indexOf('fetch')>=0||kl.indexOf('http')>=0||kl.indexOf('request')>=0||kl.indexOf('xhr')>=0||kl.indexOf('ajax')>=0||kl.indexOf('get')>=0||kl.indexOf('post')>=0||kl.indexOf('load')>=0||kl.indexOf('open')>=0;
      });
      return httpRelated.length ? httpRelated.join(', ') : '(none found)';
    })()`);
    console.log('  HTTP-related methods:', fetchMethod);
    console.log();

    // Test: electronAPI.shell (openExternal)
    const shellTest = await exec(`(function(){
      if(!window.electronAPI) return 'N/A';
      var ks = Object.getOwnPropertyNames(window.electronAPI);
      return ks.filter(function(k){ return k.indexOf('shell')>=0||k.indexOf('open')>=0; }).join(', ') || '(none)';
    })()`);
    console.log('  shell/open methods:', shellTest);
    console.log();

    // ===== PHASE 3: sendBeacon in depth =====
    console.log('=== PHASE 3: sendBeacon tests ===');
    // Test store with b64 data
    await execAsyncFn('sendBeacon /store json', `function(){
      return new Promise(function(resolve){
        var data = JSON.stringify({test:true,source:'sendBeacon',t:Date.now(),models:[{name:'test-model'}]});
        var url = 'http://127.0.0.1:18990/store?json=' + encodeURIComponent(data);
        var ok = navigator.sendBeacon(url);
        resolve('sendBeacon returned: ' + ok);
      });
    }`);

    await execAsyncFn('sendBeacon /health', `function(){
      return new Promise(function(resolve){
        var ok = navigator.sendBeacon('http://127.0.0.1:18990/health?via=beacon2&t='+Date.now());
        resolve('sendBeacon returned: ' + ok);
      });
    }`);
    console.log();

    // ===== PHASE 4: electronAPI testing =====
    console.log('=== PHASE 4: Try electronAPI methods ===');

    // Try calling each electronAPI method to see what happens
    // Let's first enumerate which ones return promises (async)
    const asyncMethods = await exec(`(function(){
      if(!window.electronAPI) return 'N/A';
      var r = {};
      var ks = Object.getOwnPropertyNames(window.electronAPI);
      ks.forEach(function(k){
        var v = window.electronAPI[k];
        if(typeof v === 'function') {
          r[k] = v.length + 'params';
        }
      });
      return JSON.stringify(r);
    })()`);
    console.log('  all methods:', asyncMethods);
    console.log();

    // Try to find a fetch-like method and call it
    // First, check if there's a "platforms" or "net" sub-object
    const nestedObjs = await exec(`(function(){
      if(!window.electronAPI) return 'N/A';
      var r = {};
      var ks = Object.getOwnPropertyNames(window.electronAPI);
      ks.forEach(function(k){
        var v = window.electronAPI[k];
        if(v && typeof v === 'object' && !Array.isArray(v)) {
          r[k] = Object.getOwnPropertyNames(v);
        }
      });
      return JSON.stringify(r);
    })()`);
    console.log('  nested objects in electronAPI:', nestedObjs);
    console.log();

    // ===== PHASE 5: Check proxy logs =====
    console.log('=== PHASE 5: Check proxy log for incoming requests ===');
    // Proxy logs are in /tmp/proxy-logs.txt
    // Let's verify by reading from proxy's /health endpoint
    try {
      const proxyCheck = await new Promise((resolve) => {
        http.get('http://127.0.0.1:18990/health', (res) => {
          let d = '';
          res.on('data', c => d += c);
          res.on('end', () => resolve(d));
        });
      });
      console.log('  Proxy health:', proxyCheck.substring(0, 200));
    } catch(e) {
      console.log('  Proxy health check error:', e.message);
    }
    console.log();

    console.log('========== DONE ==========');
    ws.close();
    process.exit(0);
  });
}

run();
