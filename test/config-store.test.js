const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, writeFileSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const WebSocket = require('ws');
const { ENGINE_BUILD_VERSION } = require('../src/build-version');
const { ConfigStore, DEFAULT_CONFIG, isValidConfigPatch } = require('../src/config-store');
const { HeadlessServer } = require('../src/server');

function fakeSocket(messages) {
  let closed = false;
  return {
    readyState: WebSocket.OPEN,
    get closed() {
      return closed;
    },
    send(raw) {
      messages.push(JSON.parse(raw));
    },
    close() {
      closed = true;
    },
  };
}

test('config persists, reloads, and preserves unknown keys across merged updates', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-next-config-'));
  try {
    const store = new ConfigStore({ dataDir });
    assert.deepEqual(store.get(), DEFAULT_CONFIG);
    store.update({
      prompts: [{ id: 'review', name: 'Review', text: 'Review this change.' }],
      defaultCwd: '/tmp/project',
      futureSetting: { enabled: true },
      providerArgs: { 'claude-code': '--dangerously-skip-permissions' },
    });

    const reloaded = new ConfigStore({ dataDir });
    assert.deepEqual(reloaded.get(), {
      prompts: [{ id: 'review', name: 'Review', text: 'Review this change.' }],
      defaultCwd: '/tmp/project',
      commands: [],
      projects: [],
      providerArgs: { 'claude-code': '--dangerously-skip-permissions' },
      futureSetting: { enabled: true },
    });
    assert.deepEqual(reloaded.update({ defaultCwd: '/tmp/next' }), {
      prompts: [{ id: 'review', name: 'Review', text: 'Review this change.' }],
      defaultCwd: '/tmp/next',
      commands: [],
      projects: [],
      providerArgs: { 'claude-code': '--dangerously-skip-permissions' },
      futureSetting: { enabled: true },
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('starter prompts are seeded only for a fresh config', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-next-config-starters-'));
  try {
    const fresh = new ConfigStore({ dataDir });
    assert.deepEqual(fresh.get().prompts.map(({ id, name }) => ({ id, name })), [
      { id: 'starter-prompt-update-documentation', name: 'Update documentation' },
      { id: 'starter-prompt-investigate-codebase', name: 'Investigate codebase' },
      { id: 'starter-prompt-reviewer-findings', name: 'Reviewer findings' },
    ]);
    fresh.update({ prompts: [] });
    assert.deepEqual(new ConfigStore({ dataDir }).get().prompts, []);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('built-in provider arguments are bounded strings keyed by provider id', () => {
  assert.equal(isValidConfigPatch({
    providerArgs: { 'claude-code': '--dangerously-skip-permissions' },
  }), true);
  assert.equal(isValidConfigPatch({ providerArgs: [] }), false);
  assert.equal(isValidConfigPatch({ providerArgs: { '../claude': '--flag' } }), false);
  assert.equal(isValidConfigPatch({ providerArgs: { 'claude-code': '--flag\nnext' } }), false);
  assert.equal(isValidConfigPatch({ providerArgs: { 'claude-code': 'x'.repeat(4097) } }), false);
});

test('malformed config files recover to minimal defaults', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-next-config-malformed-'));
  try {
    writeFileSync(join(dataDir, 'config.json'), '{broken');
    assert.deepEqual(new ConfigStore({ dataDir }).get(), {
      prompts: [], defaultCwd: '', commands: [], projects: [], providerArgs: {},
    });
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ prompts: 'not-an-array' }));
    assert.deepEqual(new ConfigStore({ dataDir }).get(), {
      prompts: [], defaultCwd: '', commands: [], projects: [], providerArgs: {},
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('config.get is requester-only and config.update broadcasts the full document', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-next-config-controls-'));
  const server = new HeadlessServer({ port: 0, dataDir, autoSaveMs: 0 });
  const requesterMessages = [];
  const peerMessages = [];
  const requester = fakeSocket(requesterMessages);
  const peer = fakeSocket(peerMessages);
  server.clients.add(requester);
  server.clients.add(peer);
  try {
    await server.listen();
    server.handleControl(requester, Buffer.from(JSON.stringify({ type: 'config.get' })));
    assert.deepEqual(requesterMessages, [{
      type: 'config', config: { ...DEFAULT_CONFIG, version: ENGINE_BUILD_VERSION },
    }]);
    assert.deepEqual(peerMessages, []);

    server.handleControl(requester, Buffer.from(JSON.stringify({
      type: 'config.update',
      config: {
        defaultCwd: '/tmp/work',
        providerArgs: { 'claude-code': '--dangerously-skip-permissions --model "sonnet fast"' },
        extensionKey: ['preserved'],
      },
    })));
    const event = {
      type: 'config',
      config: {
        prompts: DEFAULT_CONFIG.prompts,
        defaultCwd: '/tmp/work',
        commands: [],
        projects: [],
        providerArgs: { 'claude-code': '--dangerously-skip-permissions --model "sonnet fast"' },
        extensionKey: ['preserved'],
        version: ENGINE_BUILD_VERSION,
      },
    };
    assert.deepEqual(requesterMessages.at(-1), event);
    assert.deepEqual(peerMessages, [event]);
    assert.deepEqual(server.providerLaunchOptions('claude-code').extraArgs, [
      '--dangerously-skip-permissions', '--model', 'sonnet fast',
    ]);
    assert.equal(server.configStore.get().version, undefined);
  } finally {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('invalid custom session regex returns a config error without closing the socket', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-next-config-invalid-regex-'));
  const server = new HeadlessServer({ port: 0, dataDir, autoSaveMs: 0 });
  const messages = [];
  const requester = fakeSocket(messages);
  try {
    await server.listen();
    server.handleControl(requester, Buffer.from(JSON.stringify({
      type: 'config.update',
      config: {
        commands: [{
          id: 'draft-agent',
          label: 'Draft agent',
          icon: '',
          command: 'draft-agent',
          enabled: true,
          env: {},
          isAgent: true,
          canResume: true,
          resumeCommand: 'draft-agent --resume {{sessionId}}',
          sessionIdPattern: '[',
        }],
      },
    })));
    assert.deepEqual(messages, [{
      type: 'config.update.result',
      success: false,
      code: 'invalid_config',
      error: 'Invalid config update.',
    }]);
    assert.equal(requester.closed, false);

    server.handleControl(requester, Buffer.from(JSON.stringify({ type: 'config.get' })));
    assert.equal(messages.at(-1).type, 'config');
    assert.equal(requester.closed, false);
  } finally {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
