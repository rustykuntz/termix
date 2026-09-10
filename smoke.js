const WebSocket = require('ws');
const { mkdtempSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { HeadlessServer } = require('./src/server');

const EXPECTED = 'CLIDECK_NEXT_READY';

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
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-next-smoke-'));
  const server = new HeadlessServer({ port: 0, cwd: process.cwd(), dataDir });
  let socket;
  try {
    const address = await server.listen();
    socket = new WebSocket(address.url);
    const messages = [];
    const listeners = new Set();
    let sawRealMenu = false;
    let prematureMenuClear = false;

    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });

    socket.on('message', (raw) => {
      const event = JSON.parse(raw.toString());
      messages.push(event);
      if (event.type === 'menu') {
        if (event.choices.length) sawRealMenu = true;
        else if (!sawRealMenu) prematureMenuClear = true;
      }
      console.log(JSON.stringify(event));
      for (const listener of listeners) listener(event);
    });

    socket.send(JSON.stringify({ type: 'session.create', cols: 120, rows: 40 }));
    const created = await waitFor(
      messages,
      listeners,
      (event) => event.type === 'session.created' && event.provider === 'claude-code',
      15_000,
      'session.created',
    );
    await waitFor(
      messages,
      listeners,
      (event) => event.type === 'status' && event.sessionId === created.sessionId && event.state === 'idle',
      60_000,
      'initial idle status',
    );

    socket.send(JSON.stringify({
      type: 'prompt',
      sessionId: created.sessionId,
      text: `Reply with exactly ${EXPECTED} and nothing else.`,
    }));
    await waitFor(
      messages,
      listeners,
      (event) => event.type === 'agent.final' && event.text.includes(EXPECTED),
      180_000,
      'agent.final',
    );
    if (!server.persistence.get(created.sessionId)?.resumeHandle) {
      throw new Error('Claude native session id was not persisted');
    }
    if (prematureMenuClear) throw new Error('menu clear emitted before a real menu');

    socket.send(JSON.stringify({ type: 'session.close', sessionId: created.sessionId }));
    await waitFor(
      messages,
      listeners,
      (event) => event.type === 'session.closed',
      10_000,
      'session.closed',
    );
  } finally {
    socket?.close();
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(`smoke failed: ${error.message}`);
  process.exitCode = 1;
});
