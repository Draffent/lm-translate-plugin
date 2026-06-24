// CDP诊断脚本 — 连接LM Studio渲染进程，检查插件状态
const WebSocket = require('ws');

const PAGE_WS = 'ws://127.0.0.1:9222/devtools/page/FDA9B6C5A6925D9E2C90181F42F63917';
const ws = new WebSocket(PAGE_WS);

let msgId = 1;
const pending = new Map();

ws.on('open', () => {
  console.log('Connected to LM Studio renderer');

  // Enable Runtime
  send('Runtime.enable', {});

  // Check 1: Is the plugin script tag present?
  send('Runtime.evaluate', {
    expression: `document.querySelector('script[src*=\"lm-translate\"]') ? 'SCRIPT_TAG_FOUND' : 'NO_SCRIPT_TAG'`,
    returnByValue: true
  });

  // Check 2: Is __ts namespace available?
  send('Runtime.evaluate', {
    expression: `typeof window.__ts !== 'undefined' ? '__ts: ' + Object.keys(window.__ts).join(',') : 'NO___ts'`,
    returnByValue: true
  });

  // Check 3: Does fetch exist?
  send('Runtime.evaluate', {
    expression: `typeof fetch !== 'undefined' ? 'fetch EXISTS' : 'NO_fetch'`,
    returnByValue: true
  });

  // Check 4: Try to call fetch
  send('Runtime.evaluate', {
    expression: `
      (async () => {
        try {
          const r = await fetch('http://127.0.0.1:18990/health');
          const d = await r.json();
          return 'FETCH_OK: ' + JSON.stringify(d);
        } catch(e) {
          return 'FETCH_FAIL: ' + e.message;
        }
      })()
    `,
    returnByValue: true,
    awaitPromise: true,
  });

  // Check 5: Console errors
  send('Runtime.evaluate', {
    expression: `document.title + ' | hash: ' + location.hash`,
    returnByValue: true
  });

  // Check 6: Run __ts.scrape() directly
  send('Runtime.evaluate', {
    expression: `
      (() => {
        try {
          if (typeof window.__ts === 'undefined' || typeof window.__ts.scrape !== 'function') {
            return '__ts.scrape NOT AVAILABLE';
          }
          const data = window.__ts.scrape();
          return 'SCRAPE: ' + data.models.length + ' models, page=' + data.page;
        } catch(e) {
          return 'SCRAPE_ERR: ' + e.message;
        }
      })()
    `,
    returnByValue: true
  });
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  } else if (msg.method === 'Runtime.consoleAPICalled') {
    console.log('[CONSOLE]', msg.params?.args?.map(a => a.value).join(' '));
  } else if (msg.method) {
    // console.log(`[${msg.method}]`, JSON.stringify(msg.params).substring(0, 200));
  }
});

function send(method, params) {
  const id = msgId++;
  const payload = JSON.stringify({ id, method, params });
  ws.send(payload);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timeout: ${method}`));
    }, 5000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      if (msg.error) {
        console.log(`[ERROR] ${method}:`, JSON.stringify(msg.error));
        reject(new Error(msg.error.message));
      } else {
        const result = msg.result?.result?.value ?? msg.result;
        console.log(`[RESULT] ${method}:`, JSON.stringify(result).substring(0, 300));
        resolve(result);
      }
    });
  });
}

setTimeout(() => {
  console.log('\n=== DIAGNOSTIC COMPLETE ===');
  ws.close();
  process.exit(0);
}, 8000);
