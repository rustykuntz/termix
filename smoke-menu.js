const WebSocket = require('ws');
const { mkdtempSync, rmSync, unlinkSync } = require('fs');
const { basename, join } = require('path');
const { tmpdir } = require('os');
const { HeadlessServer } = require('./src/server');

const EXPECTED = 'CLIDECK_MENU_READY';
const PROOF_FILE = join(tmpdir(), `clideck-next-menu-proof-${process.pid}.txt`);
const PROMPT = [
  `Use the Write tool, not Bash, to create ${PROOF_FILE}.`,
  'Write exactly CLIDECK_MENU_TOOL_OK followed by a newline.',
  `After the write succeeds, reply with exactly ${EXPECTED} and nothing else.`,
].join('\n');

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
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-next-menu-'));
  const server = new HeadlessServer({ port: 0, cwd: process.cwd(), dataDir });
  let socket;
  try {
    const address = await server.listen();
    socket = new WebSocket(address.url);
    const messages = [];
    const listeners = new Set();

    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });

    socket.on('message', (raw) => {
      const event = JSON.parse(raw.toString());
      messages.push(event);
      console.log(JSON.stringify(event));
      for (const listener of listeners) listener(event);
    });

    socket.send(JSON.stringify({ type: 'session.create', cols: 120, rows: 40 }));
    const created = await waitFor(
      messages,
      listeners,
      (event) => event.type === 'session.created',
      15_000,
      'session.created',
    );
    await waitFor(
      messages,
      listeners,
      (event) => event.type === 'status'
        && event.sessionId === created.sessionId
        && event.state === 'idle',
      60_000,
      'initial idle status',
    );

    socket.send(JSON.stringify({ type: 'prompt', sessionId: created.sessionId, text: PROMPT }));
    const menu = await waitFor(
      messages,
      listeners,
      (event) => event.type === 'menu'
        && event.sessionId === created.sessionId
        && event.choices.length > 0,
      90_000,
      'approval menu',
    );
    if (!menu.choices.some((choice) => choice.selected)) {
      throw new Error('approval menu has no selected choice');
    }
    if (!menu.context || !menu.context.includes(basename(PROOF_FILE))) {
      throw new Error('approval menu context does not identify the requested write');
    }

    socket.send(JSON.stringify({ type: 'input', sessionId: created.sessionId, data: '\r' }));
    await waitFor(
      messages,
      listeners,
      (event) => event.type === 'menu'
        && event.sessionId === created.sessionId
        && event.choices.length === 0,
      30_000,
      'menu clear',
    );
    await waitFor(
      messages,
      listeners,
      (event) => event.type === 'agent.final'
        && event.sessionId === created.sessionId
        && event.text.includes(EXPECTED),
      180_000,
      'agent.final after approval',
    );

    socket.send(JSON.stringify({ type: 'session.close', sessionId: created.sessionId }));
    await waitFor(
      messages,
      listeners,
      (event) => event.type === 'session.closed' && event.sessionId === created.sessionId,
      10_000,
      'session.closed',
    );
  } finally {
    socket?.close();
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
    try {
      unlinkSync(PROOF_FILE);
    } catch {}
  }
}

run().catch((error) => {
  console.error(`menu smoke failed: ${error.message}`);
  process.exitCode = 1;
});
