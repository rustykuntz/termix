#!/usr/bin/env node

const http = require('http');

const port = Number(process.argv[2]);
const sessionId = process.argv[3];
const route = process.argv[4];
const guidePath = process.argv[5];
if (!port || !sessionId || !route) process.exit(0);

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  const request = http.request({
    hostname: '127.0.0.1',
    port,
    path: `/hooks/${sessionId}/${route}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(input),
    },
    timeout: 2000,
  });
  request.on('error', () => {});
  request.end(input || '{}');
  let output = {};
  if (route === 'session-start' && guidePath) {
    try {
      const guide = require('fs').readFileSync(guidePath, 'utf8');
      output = {
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: guide,
        },
      };
    } catch {}
  }
  process.stdout.write(JSON.stringify(output));
});
process.stdin.resume();
