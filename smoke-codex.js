const WebSocket = require('ws');
const { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('fs');
const { homedir, tmpdir } = require('os');
const { join } = require('path');
const { HeadlessServer } = require('./src/server');

const EXPECTED = 'CLIDECK_CODEX_READY';
const MODEL = process.env.SMOKE_CODEX_MODEL || 'gpt-6-astra';

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
  const codexHome = mkdtempSync(join(tmpdir(), 'clideck-next-codex-'));
  const authSource = join(homedir(), '.codex', 'auth.json');
  if (existsSync(authSource)) {
    mkdirSync(codexHome, { recursive: true });
    copyFileSync(authSource, join(codexHome, 'auth.json'));
  }
  // Trust only this smoke's workspace in its temporary native home. This avoids
  // racing startup's transient input prompt against the workspace trust menu.
  writeFileSync(join(codexHome, 'config.toml'),
    `model = ${JSON.stringify(MODEL)}\n[projects.${JSON.stringify(process.cwd())}]\ntrust_level = "trusted"\n`);
  const server = new HeadlessServer({
    port: 0,
    cwd: process.cwd(),
    dataDir: join(codexHome, 'clideck-next-data'),
    providerOptions: { codex: { bypassHookTrust: true, codexHome } },
  });
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
      if (event.type !== 'output') console.log(JSON.stringify(event));
      else if (process.env.SMOKE_RAW) process.stdout.write(event.data);
      for (const listener of listeners) listener(event);
    });

    socket.send(JSON.stringify({ type: 'session.create', provider: 'codex', cols: 120, rows: 40 }));
    const created = await waitFor(
      messages,
      listeners,
      (event) => event.type === 'session.created' && event.provider === 'codex',
      15_000,
      'Codex session.created',
    );
    await waitFor(
      messages,
      listeners,
      (event) => event.type === 'status' && event.sessionId === created.sessionId && event.state === 'idle',
      60_000,
      'Codex initial idle',
    );

    await waitFor(messages, listeners,
      (event) => event.type === 'status' && event.sessionId === created.sessionId
        && event.model === MODEL,
      60_000, 'Codex startup model');

    socket.send(JSON.stringify({
      type: 'prompt',
      sessionId: created.sessionId,
      text: `Reply with exactly ${EXPECTED} and nothing else.`,
    }));
    await waitFor(
      messages,
      listeners,
      (event) => event.type === 'status' && event.sessionId === created.sessionId && event.state === 'working',
      60_000,
      'Codex working',
    );
    await waitFor(
      messages,
      listeners,
      (event) => event.type === 'agent.final' && event.sessionId === created.sessionId && event.text === EXPECTED,
      180_000,
      'Codex agent.final',
    );
    if (!server.persistence.get(created.sessionId)?.resumeHandle) {
      throw new Error('Codex native session id was not persisted');
    }
    if (messages.some((event) => event.type === 'agent.update' && event.text !== EXPECTED)) {
      throw new Error('Codex terminal chrome leaked into agent.update');
    }

    const session = server.sessions.get(created.sessionId);
    await waitFor(messages, listeners,
      (event) => event.type === 'status' && event.contextUsage,
      10_000, 'initial context usage');
    // Let the previous prompt's optional Enter retry finish before typing a
    // native command that the smoke submits separately.
    await new Promise(resolve => setTimeout(resolve, session.submitRetryMs));
    const previousHandle = server.persistence.get(created.sessionId).resumeHandle;
    messages.length = 0;
    socket.send(JSON.stringify({ type: 'input', sessionId: created.sessionId, data: '/clear' }));
    const commandDeadline = Date.now() + 5_000;
    while (!session.provider.screen.hasInputCommand(session.screen.lines(), '/clear')) {
      if (Date.now() > commandDeadline) throw new Error('Codex clear command did not render');
      await new Promise(resolve => setTimeout(resolve, 50));
      session.flushScreen();
    }
    socket.send(JSON.stringify({ type: 'input', sessionId: created.sessionId, data: '\r' }));
    await waitFor(messages, listeners,
      (event) => event.type === 'status' && event.contextUsage === null,
      5_000, 'clear hides old context before another prompt');
    await new Promise(resolve => setTimeout(resolve, 500));
    if (session.contextUsage !== null) throw new Error('Old context returned after clear');
    messages.length = 0;
    socket.send(JSON.stringify({
      type: 'prompt', sessionId: created.sessionId,
      text: 'Reply with exactly CLIDECK_AFTER_CLEAR and nothing else.',
    }));
    await waitFor(messages, listeners,
      (event) => event.type === 'agent.final' && event.text === 'CLIDECK_AFTER_CLEAR',
      180_000, 'first reply after clear');
    await waitFor(messages, listeners,
      (event) => event.type === 'status' && event.contextUsage && session.contextUsage
        && server.persistence.get(created.sessionId).resumeHandle !== previousHandle,
      10_000, 'fresh context on first reply after clear');
    if (!session.contextTranscriptPathActive.includes(server.persistence.get(created.sessionId).resumeHandle)) {
      throw new Error('Context monitor did not switch to the cleared conversation');
    }

    // The same CliDeck row now gets a new PTY. Startup must not inherit work.
    messages.length = 0;
    socket.send(JSON.stringify({ type: 'session.restart', sessionId: created.sessionId }));
    await waitFor(messages, listeners,
      (event) => event.type === 'session.created' && event.restarted === true,
      30_000, 'Codex restarted snapshot');
    await waitFor(messages, listeners,
      (event) => event.type === 'status' && event.state === 'idle',
      60_000, 'Codex resumed idle');
    await waitFor(messages, listeners,
      (event) => event.type === 'status' && event.sessionId === created.sessionId
        && event.model === MODEL,
      60_000, 'Codex resumed model');
    if (messages.some((event) => event.type === 'status' && event.state === 'working')) {
      throw new Error('Codex resume incorrectly entered working');
    }

    socket.send(JSON.stringify({ type: 'session.close', sessionId: created.sessionId }));
    await waitFor(
      messages,
      listeners,
      (event) => event.type === 'session.closed' && event.sessionId === created.sessionId,
      30_000,
      'Codex session.closed',
    );
  } finally {
    socket?.close();
    await server.close();
    rmSync(codexHome, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(`Codex smoke failed: ${error.message}`);
  process.exitCode = 1;
});
