const WebSocket = require('ws');
const { mkdtempSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { HeadlessServer } = require('./src/server');

const EXPECTED = 'CLIDECK_SHELL_OK';

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
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-next-shell-'));
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
      for (const listener of listeners) listener(event);
    });
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });

    socket.send(JSON.stringify({ type: 'session.create', provider: 'shell', name: 'Shell' }));
    const created = await waitFor(
      messages,
      listeners,
      (event) => event.type === 'session.created' && event.provider === 'shell',
      10_000,
      'shell creation',
    );
    await waitFor(
      messages,
      listeners,
      (event) => event.type === 'status'
        && event.sessionId === created.sessionId
        && event.state === 'idle',
      10_000,
      'initial shell idle',
    );

    messages.length = 0;
    socket.send(JSON.stringify({
      type: 'input',
      sessionId: created.sessionId,
      data: `echo ${EXPECTED}\r`,
    }));
    await waitFor(
      messages,
      listeners,
      (event) => event.type === 'status'
        && event.sessionId === created.sessionId
        && event.state === 'working',
      5_000,
      'shell working',
    );
    await waitFor(
      messages,
      listeners,
      (event) => event.type === 'output'
        && event.sessionId === created.sessionId
        && event.data.includes(EXPECTED),
      5_000,
      'shell output marker',
    );
    await waitFor(
      messages,
      listeners,
      (event) => event.type === 'status'
        && event.sessionId === created.sessionId
        && event.state === 'idle',
      5_000,
      'shell idle decay',
    );
    if (messages.some((event) => event.type === 'agent.update'
      || event.type === 'agent.final' || event.type === 'menu')) {
      throw new Error('shell emitted semantic agent events');
    }

    socket.send(JSON.stringify({ type: 'session.close', sessionId: created.sessionId }));
    const closed = await waitFor(
      messages,
      listeners,
      (event) => event.type === 'session.closed' && event.sessionId === created.sessionId,
      10_000,
      'shell close',
    );
    if (closed.exitCode !== 0) throw new Error(`shell exited with code ${closed.exitCode}`);
  } finally {
    socket?.close();
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(`Shell smoke failed: ${error.message}`);
  process.exitCode = 1;
});
