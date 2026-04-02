#!/usr/bin/env node

const http = require('http');

const port = parseInt(process.argv[2], 10);
const route = process.argv[3];
if (!port || !route) process.exit(0);

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { stdin += chunk; });
process.stdin.on('end', () => {
  let hook = {};
  try { hook = stdin ? JSON.parse(stdin) : {}; } catch {}
  const body = JSON.stringify({
    session_id: hook.session_id || '',
    last_assistant_message: hook.last_assistant_message || '',
    payload: stdin.trim() || undefined,
  });
  const req = http.request({
    hostname: 'localhost',
    port,
    path: `/hook/codex/${route}`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    timeout: 2000,
  });
  req.on('error', () => {});
  req.end(body);
});
process.stdin.resume();
