const WebSocket = require('ws');
const { mkdtempSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { HeadlessServer } = require('./src/server');

const EXPECTED = `CLIDECK_ASK_${Date.now()}`;

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

async function postAsk(httpUrl, body) {
  const response = await fetch(`${httpUrl}/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function run() {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-next-ask-'));
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

    socket.send(JSON.stringify({ type: 'session.create', name: 'Reviewer', cols: 120, rows: 40 }));
    const created = await waitFor(
      messages,
      listeners,
      (event) => event.type === 'session.created' && event.name === 'Reviewer',
      15_000,
      'named session creation',
    );
    await waitFor(
      messages,
      listeners,
      (event) => event.type === 'status'
        && event.sessionId === created.sessionId
        && event.state === 'idle',
      60_000,
      'initial idle',
    );

    const asked = await postAsk(address.httpUrl, {
      target: 'Reviewer',
      text: `Reply with exactly ${EXPECTED} and nothing else.`,
      timeoutMs: 180_000,
    });
    if (asked.status !== 200 || !asked.body.ok || !asked.body.answer.includes(EXPECTED)) {
      throw new Error(`ask did not return the target answer: ${JSON.stringify(asked)}`);
    }

    messages.length = 0;
    socket.send(JSON.stringify({
      type: 'prompt',
      sessionId: created.sessionId,
      text: 'Think carefully for a moment, then reply with exactly BUSY_TURN_DONE.',
    }));
    await waitFor(
      messages,
      listeners,
      (event) => event.type === 'status'
        && event.sessionId === created.sessionId
        && event.state === 'working',
      60_000,
      'busy turn working',
    );
    const started = Date.now();
    const busy = await postAsk(address.httpUrl, {
      target: created.sessionId,
      text: 'This request must be rejected while busy.',
    });
    if (busy.status !== 409 || busy.body.error !== 'busy' || Date.now() - started > 2000) {
      throw new Error(`busy ask was not rejected immediately: ${JSON.stringify(busy)}`);
    }
    await waitFor(
      messages,
      listeners,
      (event) => event.type === 'agent.final'
        && event.sessionId === created.sessionId
        && event.text.includes('BUSY_TURN_DONE'),
      180_000,
      'busy turn final',
    );

    socket.send(JSON.stringify({ type: 'session.close', sessionId: created.sessionId }));
    await waitFor(
      messages,
      listeners,
      (event) => event.type === 'session.closed' && event.sessionId === created.sessionId,
      10_000,
      'session close',
    );
  } finally {
    socket?.close();
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(`ask smoke failed: ${error.message}`);
  process.exitCode = 1;
});
