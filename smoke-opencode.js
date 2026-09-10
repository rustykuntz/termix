const WebSocket = require('ws');
const { mkdtempSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { HeadlessServer } = require('./src/server');

const EXPECTED = 'CLIDECK_OPENCODE_READY';

function waitFor(messages, listeners, predicate, timeoutMs, label) {
  const existing = messages.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      listeners.delete(listener);
      reject(new Error(`timed out waiting for ${label}`));
    }, timeoutMs);
    const listener = (event) => {
      if (!predicate(event)) return;
      clearTimeout(timer);
      listeners.delete(listener);
      resolve(event);
    };
    listeners.add(listener);
  });
}

async function run() {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-next-opencode-smoke-'));
  const server = new HeadlessServer({ port: 0, cwd: process.cwd(), dataDir });
  let socket;
  try {
    const address = await server.listen();
    socket = new WebSocket(address.url);
    const messages = [];
    const listeners = new Set();
    socket.on('message', (raw) => {
      const event = JSON.parse(raw.toString());
      messages.push(event);
      if (event.type !== 'output') console.log(JSON.stringify(event));
      else if (process.env.SMOKE_RAW) process.stdout.write(event.data);
      for (const listener of listeners) listener(event);
    });
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });

    socket.send(JSON.stringify({ type: 'session.create', provider: 'opencode', name: 'OpenCode' }));
    const created = await waitFor(
      messages,
      listeners,
      (event) => event.type === 'session.created' && event.provider === 'opencode',
      15_000,
      'OpenCode session creation',
    );
    await waitFor(
      messages,
      listeners,
      (event) => event.type === 'status'
        && event.sessionId === created.sessionId
        && event.state === 'idle',
      60_000,
      'OpenCode initial idle',
    );

    socket.send(JSON.stringify({
      type: 'prompt',
      sessionId: created.sessionId,
      text: `Reply with exactly ${EXPECTED} and nothing else.`,
    }));
    await waitFor(
      messages,
      listeners,
      (event) => event.type === 'status'
        && event.sessionId === created.sessionId
        && event.state === 'working',
      60_000,
      'OpenCode working',
    );
    await waitFor(
      messages,
      listeners,
      (event) => event.type === 'agent.final'
        && event.sessionId === created.sessionId
        && event.text === EXPECTED,
      180_000,
      'OpenCode final',
    );

    socket.send(JSON.stringify({ type: 'session.close', sessionId: created.sessionId }));
    await waitFor(
      messages,
      listeners,
      (event) => event.type === 'session.closed' && event.sessionId === created.sessionId,
      30_000,
      'OpenCode close',
    );
  } finally {
    socket?.close();
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(`OpenCode smoke failed: ${error.message}`);
  process.exitCode = 1;
});
