const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const WebSocket = require('ws');
const { hasValidControlFields } = require('../src/control');
const { isAllowedWebSocketOrigin, isLoopbackAddress, isLoopbackHost } = require('../src/security');
const { HeadlessServer } = require('../src/server');

function openSocket(url, options) {
  const socket = new WebSocket(url, options);
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function closed(socket) {
  return new Promise((resolve) => {
    socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

function connectionError(url, origin) {
  const socket = new WebSocket(url, { headers: { Origin: origin } });
  return new Promise((resolve, reject) => {
    socket.once('open', () => {
      socket.close();
      reject(new Error('hostile origin connected'));
    });
    socket.once('error', resolve);
  });
}

test('browser WebSockets require the engine origin while non-browser clients remain allowed', () => {
  assert.equal(isAllowedWebSocketOrigin(undefined, '127.0.0.1:4100', '127.0.0.1'), true);
  assert.equal(
    isAllowedWebSocketOrigin('http://127.0.0.1:4100', '127.0.0.1:4100', '127.0.0.1'),
    true,
  );
  assert.equal(
    isAllowedWebSocketOrigin('https://hostile.example', '127.0.0.1:4100', '127.0.0.1'),
    false,
  );
  assert.equal(
    isAllowedWebSocketOrigin('http://hostile.example:4100', 'hostile.example:4100', '127.0.0.1'),
    false,
  );
  assert.equal(isAllowedWebSocketOrigin('not a URL', '127.0.0.1:4100', '127.0.0.1'), false);
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('0.0.0.0'), false);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('192.168.1.10'), false);
  assert.equal(hasValidControlFields({
    type: 'input',
    sessionId: 'session',
    data: '\0',
  }), true);
  assert.equal(hasValidControlFields({
    type: 'session.restart',
    sessionId: 'session',
    theme: 'light',
    cols: 120,
    rows: 40,
  }), true);
  assert.equal(hasValidControlFields({
    type: 'session.restart',
    sessionId: 'session',
    theme: 'sepia',
  }), false);
  assert.equal(hasValidControlFields({
    type: 'session.mute',
    sessionId: 'session',
    muted: true,
  }), true);
  assert.equal(hasValidControlFields({
    type: 'session.mute',
    sessionId: 'session',
    muted: 'yes',
  }), false);
  assert.equal(hasValidControlFields({
    type: 'prompt.answer',
    promptId: 'prompt-id',
    value: '{"marks":[]}',
  }), true);
  assert.equal(hasValidControlFields({
    type: 'prompt.answer',
    promptId: '',
    value: 'answer',
  }), false);
  assert.equal(hasValidControlFields({
    type: 'session.setProject', sessionId: 'session', projectId: null,
  }), true);
  assert.equal(hasValidControlFields({
    type: 'session.setProject', sessionId: 'session', projectId: 'main',
  }), true);
  assert.equal(hasValidControlFields({ type: 'project.delete', id: 'main' }), true);
  assert.equal(hasValidControlFields({
    type: 'project.open',
    cwd: '/tmp/project',
  }), true);
  assert.equal(hasValidControlFields({
    type: 'dirs.list',
    path: '/tmp/project',
    showHidden: false,
  }), true);
  assert.equal(hasValidControlFields({
    type: 'dirs.mkdir',
    parent: '/tmp/project',
    name: '',
  }), true);
  assert.equal(hasValidControlFields({ type: 'config.get' }), true);
  assert.equal(hasValidControlFields({ type: 'checkAvailability' }), true);
  assert.equal(hasValidControlFields({
    type: 'session.create',
    commandId: 'custom-bash',
  }), true);
  assert.equal(hasValidControlFields({
    type: 'config.update',
    config: { prompts: [], defaultCwd: '/tmp/project', future: true },
  }), true);
  assert.equal(hasValidControlFields({
    type: 'config.update',
    config: { prompts: 'invalid' },
  }), false);
  assert.equal(hasValidControlFields({
    type: 'config.update',
    config: { defaultCwd: 'x'.repeat(4097) },
  }), false);
  assert.equal(hasValidControlFields({
    type: 'config.update',
    config: { future: 'x'.repeat(256 * 1024) },
  }), false);
});

test('hostile browser origins cannot upgrade to WebSocket', async (context) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-next-origin-'));
  const server = new HeadlessServer({ port: 0, dataDir });
  context.after(async () => {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const address = await server.listen();

  const error = await connectionError(address.url, 'https://hostile.example');
  assert.match(error.message, /Unexpected server response: 401/);
  const ownOrigin = await openSocket(address.url, { headers: { Origin: address.httpUrl } });
  ownOrigin.close();
});

test('ask rejects hostile browser origins and allows originless CLI requests', async (context) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-next-ask-origin-'));
  const server = new HeadlessServer({ port: 0, dataDir });
  server.persistence.register({
    id: 'known-session',
    name: 'Reviewer',
    provider: { id: 'claude-code' },
    cwd: '/tmp/project',
    cols: 120,
    rows: 40,
  });
  context.after(async () => {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const address = await server.listen();

  const hostile = await fetch(`${address.httpUrl}/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://hostile.example' },
    body: JSON.stringify({ target: 'missing', text: 'hello' }),
  });
  assert.equal(hostile.status, 403);
  assert.equal((await hostile.json()).error, 'origin_forbidden');

  const cli = await fetch(`${address.httpUrl}/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target: 'missing', text: 'hello' }),
  });
  assert.equal(cli.status, 404);
  assert.deepEqual(await cli.json(), {
    ok: false,
    error: 'unknown_target',
    targets: [{
      id: 'known-session',
      name: 'Reviewer',
      provider: 'claude-code',
      projectId: null,
      address: '@project/Reviewer',
      supportsAsk: true,
      live: false,
    }],
  });
});

test('malformed controls close only their client and leave the engine available', async (context) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-next-security-'));
  const server = new HeadlessServer({ port: 0, dataDir });
  context.after(async () => {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const address = await server.listen();

  const createClient = await openSocket(address.url);
  const createClosed = closed(createClient);
  createClient.send(JSON.stringify({ type: 'session.create', cwd: {} }));
  assert.deepEqual(await createClosed, { code: 1003, reason: 'invalid control fields' });

  const resizeClient = await openSocket(address.url);
  const resizeClosed = closed(resizeClient);
  resizeClient.send(JSON.stringify({
    type: 'resize',
    sessionId: 'missing-session',
    cols: {},
    rows: -1,
  }));
  assert.deepEqual(await resizeClosed, { code: 1003, reason: 'invalid control fields' });

  const renameClient = await openSocket(address.url);
  const renameClosed = closed(renameClient);
  renameClient.send(JSON.stringify({
    type: 'session.rename',
    sessionId: 'missing-session',
    name: {},
  }));
  assert.deepEqual(await renameClosed, { code: 1003, reason: 'invalid control fields' });

  server.sessions.set('throwing-session', {
    closed: false,
    resize() {
      throw new Error('resize failed');
    },
    close() {
      this.closed = true;
    },
    waitForClose() {
      return Promise.resolve();
    },
  });
  const runtimeClient = await openSocket(address.url);
  const runtimeClosed = closed(runtimeClient);
  runtimeClient.send(JSON.stringify({
    type: 'resize',
    sessionId: 'throwing-session',
    cols: 100,
    rows: 30,
  }));
  assert.deepEqual(await runtimeClosed, { code: 1011, reason: 'control failed' });

  const healthyClient = await openSocket(address.url);
  assert.equal(healthyClient.readyState, WebSocket.OPEN);
  healthyClient.close();
  assert.equal((await fetch(`${address.httpUrl}/`)).status, 200);
});
