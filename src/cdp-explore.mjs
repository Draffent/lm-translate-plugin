// CDP Explorer — Deep dive into lmsHostedEnv and window APIs
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
    if (r.exceptionDetails) return 'ERROR: ' + r.exceptionDetails.text;
    return r?.result?.result?.value;
  };

  ws.on('open', async () => {
    console.log('Connected\n');

    // ---- 1. lmsHostedEnv deep dive ----
    console.log('=== lmsHostedEnv ===');
    const lmsKeys = await exec(`Object.keys(window.lmsHostedEnv || {}).join(', ') || 'N/A'`);
    console.log('  keys:', lmsKeys);

    // Types of each key
    const lmsDetails = await exec(`(function(){
      var h = window.lmsHostedEnv;
      if (!h) return 'N/A';
      var r = {};
      Object.keys(h).forEach(function(k){
        r[k] = typeof h[k];
        if (typeof h[k] === 'function') r[k] += '(' + h[k].length + 'params)';
        if (h[k] && typeof h[k] === 'object') r[k] += ' -> ' + Object.keys(h[k]).join(',');
      });
      return JSON.stringify(r);
    })()`);
    console.log('  details:', lmsDetails);

    // Try getApiIpcTunnel with common namespaces
    if (lmsKeys && lmsKeys.includes('getApiIpcTunnel')) {
      console.log('\n  Trying IPC tunnels...');
      const namespaces = ['llm', 'files', 'httpServer', 'network', 'modelLoading', 'downloads', 'search'];
      for (const ns of namespaces) {
        const result = await exec(`(function(){
          try {
            var tunnel = window.lmsHostedEnv.getApiIpcTunnel('${ns}', null, function(d){}, function(){});
            return tunnel ? 'OK: ' + tunnel.constructor.name : 'null/undefined';
          } catch(e) { return 'ERR: ' + e.message; }
        })()`);
        console.log(`    ${ns}: ${result}`);
      }
    }
    console.log();

    // ---- 2. Check electronAPI more ----
    console.log('=== electronAPI ===');
    // Try calling getPathForFile with different args
    const path1 = await exec(`window.electronAPI.getPathForFile()`);
    console.log('  getPathForFile():', path1);

    // Check if electronAPI has any prototype methods
    const protoKeys = await exec(`Object.getOwnPropertyNames(Object.getPrototypeOf(window.electronAPI)).join(', ')`);
    console.log('  proto keys:', protoKeys);

    // Check if electronAPI works via call
    const pathWithArg = await exec(`(function(){
      try {
        var r = window.electronAPI.getPathForFile();
        return 'result: ' + JSON.stringify(r);
      } catch(e) { return 'error: ' + e.message; }
    })()`);
    console.log('  getPathForFile result:', pathWithArg);

    // Check electronAPIBase too
    const baseDet = await exec(`Object.getOwnPropertyNames(window.electronAPIBase).join(', ')`);
    console.log('  electronAPIBase keys:', baseDet);
    console.log();

    // ---- 3. Check navigator.webkitPersistentStorage ----
    console.log('=== Storage/DB APIs ===');
    console.log('  indexedDB:', await exec('typeof indexedDB'));
    console.log('  localStorage:', await exec('typeof localStorage'));
    console.log('  sessionStorage:', await exec('typeof sessionStorage'));
    console.log('  caches:', await exec('typeof caches'));
    console.log('  serviceWorker:', await exec('typeof navigator.serviceWorker'));
    console.log('  storage:', await exec('typeof navigator.storage'));
    console.log();

    // ---- 4. Check for unusual APIs ----
    console.log('=== Unusual APIs ===');
    console.log('  WebAssembly:', await exec('typeof WebAssembly'));
    console.log('  SharedWorker:', await exec('typeof SharedWorker'));
    console.log('  Worker:', await exec('typeof Worker'));
    console.log('  MessageChannel:', await exec('typeof MessageChannel'));
    console.log('  BroadcastChannel:', await exec('typeof BroadcastChannel'));
    console.log();

    // ---- 5. Check if we can access Electron main process APIs ----
    console.log('=== Electron IPC (via MessageChannel / custom) ===');
    // Check if window has __electron_native or similar
    const allObjKeys = await exec(`(function(){
      return Object.keys(window).filter(function(k){
        var v = window[k];
        return k.indexOf('__') === 0 && typeof v === 'object' && v !== null;
      }).join(', ') || '(none)';
    })()`);
    console.log('  __* objects:', allObjKeys);

    // Check function constructor for eval
    console.log('  Function:', await exec('typeof Function'));
    console.log('  eval:', await exec('typeof eval'));
    console.log();

    // ---- 6. window.postMessage and MessageChannel ----
    console.log('=== Communication Primitives ===');
    console.log('  postMessage:', await exec('typeof window.postMessage'));
    console.log('  addEventListener:', await exec('typeof window.addEventListener'));
    console.log();

    // ---- 7. Check electron main process direct access ----
    console.log('=== Direct IPC ===');
    // Check if ipcRenderer exists in any form
    const ipcCheck = await exec(`(function(){
      var checks = ['require','process','__electron','electron','nativeRequire','global'];
      var r = {};
      checks.forEach(function(k){ r[k] = typeof window[k]; });
      return JSON.stringify(r);
    })()`);
    console.log('  node access:', ipcCheck);

    // Check if we can use Function to create a node-like bridge
    const funcProto = await exec(`(function(){
      try {
        var f = new Function('return typeof require');
        return 'new Function works: ' + f();
      } catch(e) { return 'new Function failed: ' + e.message; }
    })()`);
    console.log('  new Function:', funcProto);
    console.log();

    // ---- 8. window.open test ----
    console.log('=== window.open ===');
    const winOpen = await exec(`(function(){
      try {
        var w = window.open('about:blank', '_blank', 'width=300,height=200');
        return w ? 'opened: ' + (w.closed ? 'closed' : 'open') : 'blocked (null)';
      } catch(e) { return 'error: ' + e.message; }
    })()`);
    console.log('  window.open:', winOpen);
    console.log();

    ws.close();
    process.exit(0);
  });
}

run();
