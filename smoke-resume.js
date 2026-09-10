const WebSocket = require('ws');
const { existsSync, mkdtempSync, readFileSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { HeadlessServer } = require('./src/server');

const MARKER = `cobaltquartz${process.pid}`;

class Client {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.messages = [];
    this.listeners = new Set();
    this.socket.on('message', (raw) => {
      const event = JSON.parse(raw.toString());
      this.messages.push(event);
      if (event.type !== 'output') console.log(JSON.stringify(event));
      else if (process.env.SMOKE_RAW) process.stdout.write(event.data);
      for (const listener of this.listeners) listener(event);
    });
  }

  connect() {
    return new Promise((resolve, reject) => {
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
        reject(new Error(`timed out waiting for ${label}`));
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
}

async function startEngine(dataDir) {
  const server = new HeadlessServer({ port: 0, cwd: process.cwd(), dataDir });
  const address = await server.listen();
  const client = new Client(address.url);
  await client.connect();
  return { server, client };
}

async function run() {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-next-resume-'));
  let engine;
  try {
    engine = await startEngine(dataDir);
    engine.client.send({ type: 'session.create', provider: 'claude-code', cols: 120, rows: 40 });
    const created = await engine.client.waitFor(
      (event) => event.type === 'session.created' && event.live === true,
      15_000,
      'initial session.created',
    );
    await engine.client.waitFor(
      (event) => event.type === 'status'
        && event.sessionId === created.sessionId
        && event.state === 'idle',
      60_000,
      'initial idle',
    );

    engine.client.send({
      type: 'prompt',
      sessionId: created.sessionId,
      text: `Remember the marker word ${MARKER}. Reply with exactly MARKER_STORED and nothing else.`,
    });
    await engine.client.waitFor(
      (event) => event.type === 'agent.final'
        && event.sessionId === created.sessionId
        && event.text.includes('MARKER_STORED'),
      180_000,
      'marker storage final',
    );
    if (!engine.server.persistence.get(created.sessionId)?.resumeHandle) {
      throw new Error('Claude native resume handle was not persisted');
    }
    const originalEntry = engine.server.persistence.get(created.sessionId);
    if (process.env.SMOKE_RAW) {
      console.log(`\nresumeHandle=${originalEntry.resumeHandle}`);
      console.log(`transcriptPath=${originalEntry.transcriptPath}`);
    }
    const originalHistoryBytes = Buffer.byteLength(engine.server.persistence.historyTail(created.sessionId));

    await engine.server.close();
    if (process.env.SMOKE_RAW) {
      let alive = true;
      try {
        process.kill(created.pid, 0);
      } catch {
        alive = false;
      }
      console.log(`oldPidAliveAfterServerClose=${alive}`);
    }
    if (!originalEntry.transcriptPath || !existsSync(originalEntry.transcriptPath)) {
      throw new Error('Claude transcript was not persisted on clean exit');
    }
    if (!readFileSync(originalEntry.transcriptPath, 'utf8').includes(MARKER)) {
      throw new Error('Claude transcript does not contain the marker turn');
    }
    engine = null;
    engine = await startEngine(dataDir);
    await engine.client.waitFor(
      (event) => event.type === 'session.created'
        && event.sessionId === created.sessionId
        && event.live === false,
      10_000,
      'dormant replay',
    );

    engine.client.send({ type: 'session.resume', sessionId: created.sessionId });
    await engine.client.waitFor(
      (event) => event.type === 'session.created'
        && event.sessionId === created.sessionId
        && event.live === true,
      30_000,
      'resumed session.created',
    );
    await engine.client.waitFor(
      (event) => event.type === 'status'
        && event.sessionId === created.sessionId
        && event.state === 'idle',
      60_000,
      'resumed idle',
    );

    engine.client.send({
      type: 'prompt',
      sessionId: created.sessionId,
      text: 'What marker word did I ask you to remember? Reply with only that marker word.',
    });
    await engine.client.waitFor(
      (event) => event.type === 'agent.final'
        && event.sessionId === created.sessionId
        && event.text.toLowerCase().includes(MARKER),
      180_000,
      'resumed context final',
    );
    const resumedEntry = engine.server.persistence.get(created.sessionId);
    if (resumedEntry.createdAt !== originalEntry.createdAt) {
      throw new Error('resume replaced the registry entry');
    }
    if (Buffer.byteLength(engine.server.persistence.historyTail(created.sessionId)) <= originalHistoryBytes) {
      throw new Error('resume did not append to the existing terminal history');
    }
  } finally {
    await engine?.server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(`resume smoke failed: ${error.message}`);
  process.exitCode = 1;
});
