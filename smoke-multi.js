const WebSocket = require('ws');
const { mkdtempSync, rmSync, unlinkSync } = require('fs');
const { basename, join } = require('path');
const { tmpdir } = require('os');
const { HeadlessServer } = require('./src/server');

const EXPECTED_A = 'CLIDECK_MULTI_A';
const EXPECTED_B = 'CLIDECK_MULTI_B';
const PROOF_FILE = join(tmpdir(), `clideck-next-multi-proof-${process.pid}.txt`);
const PROMPT_A = `Reply with exactly ${EXPECTED_A} and nothing else.`;
const PROMPT_B = [
  `Use the Write tool, not Bash, to create ${PROOF_FILE}.`,
  'Write exactly CLIDECK_MULTI_TOOL_OK followed by a newline.',
  `After the write succeeds, reply with exactly ${EXPECTED_B} and nothing else.`,
].join('\n');
const EVENT_TYPES = new Set([
  'session.created',
  'session.closed',
  'status',
  'turn.user',
  'agent.update',
  'agent.final',
  'menu',
  'output',
]);

class Client {
  constructor(url, label) {
    this.socket = new WebSocket(url);
    this.label = label;
    this.messages = [];
    this.listeners = new Set();
    this.socket.on('message', (raw) => {
      const event = JSON.parse(raw.toString());
      this.messages.push(event);
      if (event.type !== 'output') console.log(`${this.label} ${JSON.stringify(event)}`);
      for (const listener of this.listeners) listener(event);
    });
  }

  connect() {
    return new Promise((resolve, reject) => {
      if (this.socket.readyState === WebSocket.OPEN) return resolve();
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
    });
  }

  send(message) {
    this.socket.send(JSON.stringify(message));
  }

  waitFor(predicate, timeoutMs, label) {
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(listener);
        reject(new Error(`timed out waiting for ${this.label} ${label}`));
      }, timeoutMs);
      const listener = (event) => {
        if (!predicate(event)) return;
        clearTimeout(timer);
        this.listeners.delete(listener);
        resolve(event);
      };
      this.listeners.add(listener);
    });
  }

  close() {
    this.socket.close();
  }
}

function isEvent(type, sessionId, extra = () => true) {
  return (event) => event.type === type && event.sessionId === sessionId && extra(event);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertAttribution(messages, sessionA, sessionB) {
  const known = new Set([sessionA, sessionB]);
  for (const event of messages) {
    if (EVENT_TYPES.has(event.type) && !known.has(event.sessionId)) {
      throw new Error(`${event.type} has unknown sessionId ${event.sessionId}`);
    }
    if (event.type === 'agent.final' && event.text.includes(EXPECTED_A) && event.sessionId !== sessionA) {
      throw new Error('session A final was attributed to session B');
    }
    if (event.type === 'agent.final' && event.text.includes(EXPECTED_B) && event.sessionId !== sessionB) {
      throw new Error('session B final was attributed to session A');
    }
  }
}

async function run() {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-next-multi-'));
  const server = new HeadlessServer({ port: 0, cwd: process.cwd(), dataDir });
  let first;
  let second;
  try {
    const address = await server.listen();
    first = new Client(address.url, 'client-1');
    await first.connect();

    first.send({ type: 'session.create', cols: 120, rows: 40 });
    const createdA = await first.waitFor(
      (event) => event.type === 'session.created',
      15_000,
      'session A creation',
    );
    first.send({ type: 'session.create', cols: 120, rows: 40 });
    const createdB = await first.waitFor(
      (event) => event.type === 'session.created' && event.sessionId !== createdA.sessionId,
      15_000,
      'session B creation',
    );
    const sessionA = createdA.sessionId;
    const sessionB = createdB.sessionId;

    await Promise.all([
      first.waitFor(isEvent('status', sessionA, (event) => event.state === 'idle'), 60_000, 'session A idle'),
      first.waitFor(isEvent('status', sessionB, (event) => event.state === 'idle'), 60_000, 'session B idle'),
    ]);

    first.send({ type: 'prompt', sessionId: sessionA, text: PROMPT_A });
    first.send({ type: 'prompt', sessionId: sessionB, text: PROMPT_B });
    await Promise.all([
      first.waitFor(isEvent('status', sessionA, (event) => event.state === 'working'), 60_000, 'session A working'),
      first.waitFor(isEvent('status', sessionB, (event) => event.state === 'working'), 60_000, 'session B working'),
    ]);

    await first.waitFor(
      isEvent('agent.final', sessionA, (event) => event.text === EXPECTED_A),
      180_000,
      'session A final',
    );
    await first.waitFor(
      isEvent('agent.update', sessionB, (event) => event.text.includes(basename(PROOF_FILE))),
      120_000,
      'session B update',
    );
    const menuB = await first.waitFor(
      isEvent('menu', sessionB, (event) => event.choices.length > 0),
      120_000,
      'session B menu',
    );
    if (!menuB.context.includes(basename(PROOF_FILE))) {
      throw new Error('session B menu context is not attributable');
    }

    second = new Client(address.url, 'client-2');
    await second.connect();
    await Promise.all([
      second.waitFor(isEvent('session.created', sessionA), 10_000, 'session A replay'),
      second.waitFor(isEvent('status', sessionA, (event) => event.state === 'idle'), 10_000, 'session A status replay'),
      second.waitFor(isEvent('agent.update', sessionA, (event) => event.text === EXPECTED_A), 10_000, 'session A update replay'),
      second.waitFor(isEvent('session.created', sessionB), 10_000, 'session B replay'),
      second.waitFor(isEvent('status', sessionB, (event) => event.state === 'idle'), 10_000, 'session B status replay'),
      second.waitFor(isEvent('agent.update', sessionB, (event) => event.text.includes(basename(PROOF_FILE))), 10_000, 'session B update replay'),
      second.waitFor(isEvent('menu', sessionB, (event) => event.context?.includes(basename(PROOF_FILE))), 10_000, 'session B menu replay'),
    ]);

    second.send({ type: 'input', sessionId: sessionB, data: '\r' });
    await second.waitFor(
      isEvent('menu', sessionB, (event) => event.choices.length === 0),
      30_000,
      'session B menu clear',
    );
    await second.waitFor(
      isEvent('agent.final', sessionB, (event) => event.text === EXPECTED_B),
      180_000,
      'session B final',
    );

    const finalsA = first.messages.filter(isEvent('agent.final', sessionA));
    const finalsB = first.messages.filter(isEvent('agent.final', sessionB));
    if (finalsA.length !== 1 || finalsB.length !== 1) {
      throw new Error(`expected one final per session, got A=${finalsA.length} B=${finalsB.length}`);
    }

    first.send({ type: 'session.close', sessionId: sessionA });
    await first.waitFor(isEvent('session.closed', sessionA), 10_000, 'session A close');
    if (first.messages.some(isEvent('session.closed', sessionB))) {
      throw new Error('closing session A also closed session B');
    }

    first.send({ type: 'prompt', sessionId: sessionA, text: 'STALE_CONTROL' });
    await wait(100);
    if (first.socket.readyState !== WebSocket.OPEN) {
      throw new Error('stale session control closed the shared client socket');
    }
    first.send({ type: 'session.close', sessionId: sessionB });
    await second.waitFor(isEvent('session.closed', sessionB), 10_000, 'session B close');

    assertAttribution(first.messages, sessionA, sessionB);
    assertAttribution(second.messages, sessionA, sessionB);
  } finally {
    first?.close();
    second?.close();
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
    try {
      unlinkSync(PROOF_FILE);
    } catch {}
  }
}

run().catch((error) => {
  console.error(`multi smoke failed: ${error.message}`);
  process.exitCode = 1;
});
