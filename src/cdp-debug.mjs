// Minimal CDP test — just evaluates and shows raw response
import WebSocket from 'ws';
import http from 'node:http';

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

async function main() {
  const wsUrl = await getPageWS();
  console.log('Connecting to:', wsUrl);

  const ws = new WebSocket(wsUrl);
  let msgId = 0;
  let pending = {};

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    console.log('RAW response:', JSON.stringify(msg, null, 2).substring(0, 500));
    const p = pending[msg.id];
    if (p) { delete pending[msg.id]; p.resolve(msg); }
  });

  ws.on('open', async () => {
    console.log('Connected\n');

    // Test 1: Simple eval
    const id = ++msgId;
    pending[id] = { resolve: () => {}, reject: () => {} };
    ws.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression: '1+1', returnByValue: true, awaitPromise: false }
    }));
    // Wait for response
    await new Promise(r => setTimeout(r, 2000));

    // Test 2: Check what response structure looks like
    const id2 = ++msgId;
    pending[id2] = { resolve: () => {}, reject: () => {} };
    ws.send(JSON.stringify({
      id: id2,
      method: 'Runtime.evaluate',
      params: { expression: 'location.protocol', returnByValue: true, awaitPromise: false }
    }));
    await new Promise(r => setTimeout(r, 2000));

    ws.close();
    process.exit(0);
  });
}

main();
