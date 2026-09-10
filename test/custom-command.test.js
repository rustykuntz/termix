const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const WebSocket = require('ws');
const { augmentedPath, checkCommandAvailability } = require('../src/availability');
const { ConfigStore, isValidConfigPatch } = require('../src/config-store');
const {
  createCustomCommandProvider,
  parseCommand,
} = require('../src/custom-command');
const { HeadlessServer } = require('../src/server');
const { AgentSession } = require('../src/session');

const BASH_COMMAND = {
  id: 'custom-bash',
  label: 'Custom Bash',
  icon: 'terminal',
  command: '/bin/bash --noprofile --norc',
  enabled: true,
  env: { CUSTOM_VALUE: 'quoted value' },
  isAgent: false,
  canResume: false,
  resumeCommand: '',
  sessionIdPattern: '',
};

function waitFor(messages, predicate, timeoutMs = 5000) {
  const found = messages.find(predicate);
  if (found) return Promise.resolve(found);
  return new Promise((resolve, reject) => {
    const interval = setInterval(() => {
      const event = messages.find(predicate);
      if (!event) return;
      clearInterval(interval);
      clearTimeout(timeout);
      resolve(event);
    }, 5);
    const timeout = setTimeout(() => {
      clearInterval(interval);
      reject(new Error('timed out waiting for custom command event'));
    }, timeoutMs);
  });
}

test('custom command model round-trips and validates environment keys', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-next-command-config-'));
  try {
    const store = new ConfigStore({ dataDir });
    store.update({ commands: [BASH_COMMAND] });
    assert.deepEqual(new ConfigStore({ dataDir }).get().commands, [BASH_COMMAND]);
    assert.equal(isValidConfigPatch({
      commands: [{ ...BASH_COMMAND, env: { 'BAD-KEY': 'value' } }],
    }), false);
    assert.equal(isValidConfigPatch({
      commands: [{ ...BASH_COMMAND, sessionIdPattern: '(' }],
    }), false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('custom launch parsing, resume substitution, and token capture are isolated', () => {
  assert.deepEqual(parseCommand('tool --name "two words" \'three words\''), [
    'tool', '--name', 'two words', 'three words',
  ]);
  const provider = createCustomCommandProvider({
    ...BASH_COMMAND,
    command: 'agent --fresh "two words"',
    canResume: true,
    resumeCommand: 'agent --resume "{{sessionId}}"',
    sessionIdPattern: 'Session: ([a-z0-9-]+)',
  });
  assert.deepEqual(provider.createLaunch({ command: provider.command }), {
    command: 'agent',
    args: ['--fresh', 'two words'],
    env: BASH_COMMAND.env,
  });
  assert.deepEqual(provider.createLaunch({ command: provider.command, resumeHandle: 'native-42' }), {
    command: 'agent',
    args: ['--resume', 'native-42'],
    env: BASH_COMMAND.env,
  });

  const session = new AgentSession({ provider, port: 4100 });
  const captured = [];
  session.on('resume-metadata', (metadata) => captured.push(metadata));
  session.handleOutput('\x1b[32mSess');
  session.handleOutput('ion: native-42\x1b[0m');
  session.handleOutput(' Session: ignored-99');
  assert.deepEqual(captured, [{ handle: 'native-42' }]);
  session.handleExit(0, null);
});

test('availability control replies only to its requester and includes built-ins', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-next-command-availability-'));
  const calls = [];
  const server = new HeadlessServer({
    port: 0,
    dataDir,
    autoSaveMs: 0,
    availabilityService: async (command, options) => {
      calls.push({ command, options });
      return { available: true, path: `/found/${parseCommand(command)[0]}`, version: '1.0' };
    },
  });
  const requester = { readyState: WebSocket.OPEN, messages: [], send(raw) { this.messages.push(JSON.parse(raw)); } };
  const peer = { readyState: WebSocket.OPEN, messages: [], send(raw) { this.messages.push(JSON.parse(raw)); } };
  server.clients.add(requester);
  server.clients.add(peer);
  try {
    await server.listen();
    server.configStore.update({ commands: [BASH_COMMAND] });
    server.handleControl(requester, Buffer.from(JSON.stringify({ type: 'checkAvailability' })));
    const result = await waitFor(requester.messages, (event) => event.type === 'availability.result');
    assert.equal(result.success, true);
    assert.deepEqual(result.providers.map((provider) => provider.id), [
      'claude-code', 'antigravity', 'codex', 'gemini', 'opencode', 'pi', 'shell',
    ]);
    assert.deepEqual(result.commands, [{
      id: BASH_COMMAND.id,
      label: BASH_COMMAND.label,
      enabled: true,
      available: true,
      path: '/found//bin/bash',
      version: '1.0',
    }]);
    assert.deepEqual(peer.messages, []);
    assert.equal(calls.length, result.providers.length + result.commands.length);
    assert.match(augmentedPath('/usr/bin', '/tmp/home'), /\/tmp\/home\/\.local\/bin/);
  } finally {
    server.clients.clear();
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('availability detection uses augmented PATH and tolerates a failed version probe', async () => {
  const calls = [];
  const execFile = (command, args, options, callback) => {
    calls.push({ command, args, path: options.env.PATH });
    if (command === 'which') callback(null, '/tmp/home/.local/bin/demo\n', '');
    else callback(Object.assign(new Error('no version flag'), { code: 1 }), '', '');
  };
  assert.deepEqual(await checkCommandAvailability('demo --flag', {
    home: '/tmp/home',
    env: { PATH: '/usr/bin' },
    platform: 'darwin',
    execFile,
  }), {
    available: true,
    path: '/tmp/home/.local/bin/demo',
    version: '',
  });
  assert.deepEqual(calls.map(({ command, args }) => ({ command, args })), [
    { command: 'which', args: ['demo'] },
    { command: '/tmp/home/.local/bin/demo', args: ['--version'] },
  ]);
  assert.match(calls[0].path, /\/tmp\/home\/\.local\/bin/);
});

test('custom bash session writes output and restart/resume fall back fresh without a token', async () => {
  const root = mkdtempSync(join(tmpdir(), 'clideck-next-command-smoke-'));
  const dataDir = join(root, 'data');
  const cwd = join(root, 'project');
  mkdirSync(cwd, { recursive: true });
  const server = new HeadlessServer({ port: 0, cwd, dataDir, autoSaveMs: 0 });
  let socket;
  try {
    server.configStore.update({ commands: [BASH_COMMAND] });
    const address = await server.listen();
    socket = new WebSocket(address.url);
    const messages = [];
    socket.on('message', (raw) => messages.push(JSON.parse(raw)));
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });

    socket.send(JSON.stringify({
      type: 'session.create',
      commandId: BASH_COMMAND.id,
      name: 'Bash',
      cwd,
    }));
    const created = await waitFor(messages, (event) => (
      event.type === 'session.created' && event.commandId === BASH_COMMAND.id
    ));
    assert.equal(created.provider, 'custom-command');
    assert.equal(created.label, BASH_COMMAND.label);
    socket.send(JSON.stringify({
      type: 'input', sessionId: created.sessionId, data: 'printf "CUSTOM:%s\\n" "$CUSTOM_VALUE"\r',
    }));
    await waitFor(messages, (event) => event.type === 'output'
      && event.sessionId === created.sessionId && event.data.includes('CUSTOM:quoted value'));

    socket.send(JSON.stringify({ type: 'session.restart', sessionId: created.sessionId }));
    const restarted = await waitFor(messages, (event) => event.type === 'session.created'
      && event.sessionId === created.sessionId && event.restarted === true);
    assert.equal(restarted.resumed, false);
    assert.equal(restarted.commandId, BASH_COMMAND.id);

    socket.send(JSON.stringify({ type: 'input', sessionId: created.sessionId, data: 'exit\r' }));
    await waitFor(messages, (event) => event.type === 'session.created'
      && event.sessionId === created.sessionId && event.live === false);
    messages.length = 0;
    socket.send(JSON.stringify({ type: 'session.resume', sessionId: created.sessionId }));
    const resumed = await waitFor(messages, (event) => event.type === 'session.created'
      && event.sessionId === created.sessionId);
    assert.equal(resumed.commandId, BASH_COMMAND.id);
    assert.equal(resumed.label, BASH_COMMAND.label);
    assert.equal(resumed.live, true);
  } finally {
    socket?.close();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
