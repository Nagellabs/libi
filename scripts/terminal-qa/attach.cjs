#!/usr/bin/env node
// QA/automation helper: attach to a live libi terminal session as a second
// viewer over the terminal ws protocol, optionally send input, dump output.
// Usage: node scripts/terminal-qa/attach.cjs <sessionId> [inputString] [waitMs]
// (Use $'...\r' shell quoting to send a real carriage return.)
const WebSocket = require('ws');
const [sessionId, input, waitMs] = process.argv.slice(2);
(async () => {
  const { port } = await (await fetch('http://127.0.0.1:3469/api/terminal/ws-info')).json();
  const ws = new WebSocket('ws://127.0.0.1:' + port + '/?session=' + sessionId);
  let out = '';
  ws.on('message', (d, isBin) => { if (isBin) out += Buffer.from(d).toString(); });
  ws.on('open', () => { if (input) setTimeout(() => ws.send(JSON.stringify({ type: 'input', data: input })), 300); });
  setTimeout(() => {
    const clean = out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
    console.log(clean);
    process.exit(0);
  }, Number(waitMs ?? 2500));
})();
