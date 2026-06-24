// CDP诊断脚本v2 — 连接browser级别WebSocket
const WebSocket = require('ws');

const BROWSER_WS = 'ws://127.0.0.1:9222/devtools/browser/c5461a71-54eb-4ac2-ba0f-4dbf2c5c3b70';
const ws = new WebSocket(BROWSER_WS);

let msgId = 1;
const pending = new Map();
let results = [];

ws.on('open', () => {
  console.log('Connected to browser');

  // First get targets
  send('Target.getTargets', {}).then(async (result) => {
    console.log('Targets:', JSON.stringify(result).substring(0, 500));
    const targets = result?.result?.targetInfos || [];

    if (targets.length === 0) {
      console.log('No targets. Creating new target...');
      await send('Target.createTarget', { url: 'about:blank' });
      const t2 = await send('Target.getTargets', {});
      console.log('Targets after create:', JSON.stringify(t2).substring(0, 500));
    }

    // Attach to first page target
    const pageTarget = targets.find(t => t.type === 'page');
    if (pageTarget) {
      console.log('Attaching to:', pageTarget.targetId);
      const session = await send('Target.attachToTarget', {
        targetId: pageTarget.targetId,
        flatten: true
      });
      const sessionId = session?.result?.sessionId;
      console.log('Session:', sessionId);

      if (sessionId) {
        // Evaluate via session
        await send('Runtime.evaluate', {
          expression: `'TITLE:' + document.title + ' | SCRIPT:' + (!!document.querySelector('script[src*=\"lm-translate\"]')) + ' | __ts:' + (typeof window.__ts)`,
          returnByValue: true
        }, sessionId);
      }
    }
  });
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) {
      console.log(`[${p.label}] ERROR:`, JSON.stringify(msg.error));
      p.reject(new Error(msg.error.message));
    } else {
      const val = msg.result?.result?.value ?? msg.result;
      console.log(`[${p.label}]:`, typeof val === 'object' ? JSON.stringify(val).substring(0, 400) : val);
      p.resolve(msg);
    }
  } else if (msg.method) {
    if (msg.method === 'Target.attachedToTarget') {
      console.log('Attached to target:', msg.params?.targetInfo?.url);
    }
  }
});

function send(method, params, sessionId) {
  const id = msgId++;
  const payload = { id, method };
  if (params) payload.params = params;
  if (sessionId) payload.sessionId = sessionId;
  ws.send(JSON.stringify(payload));

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timeout: ${method}`));
    }, 5000);
    pending.set(id, { resolve, reject, timer, label: method });
  });
}

setTimeout(() => {
  console.log('\n=== DIAGNOSTIC COMPLETE ===');
  console.log('Results:', results.join('\n'));
  ws.close();
  process.exit(0);
}, 10000);
