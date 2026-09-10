const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { SessionPersistence } = require('../src/persistence');
const { HeadlessServer } = require('../src/server');

function fakeSession(id = 'saved-session') {
  return {
    id,
    provider: { id: 'shell' },
    name: 'Before save',
    cwd: '/tmp/saved-project',
    cols: 100,
    rows: 30,
  };
}

function waitFor(events, predicate, timeoutMs = 1000) {
  const existing = events.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const interval = setInterval(() => {
      const event = events.find(predicate);
      if (!event) return;
      clearInterval(interval);
      clearTimeout(timeout);
      resolve(event);
    }, 5);
    const timeout = setTimeout(() => {
      clearInterval(interval);
      reject(new Error('timed out waiting for saved signal'));
    }, timeoutMs);
  });
}

test('auto-save cadence flushes state and broadcasts a saved signal', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-next-auto-save-'));
  const server = new HeadlessServer({
    port: 0,
    dataDir,
    persistenceDebounceMs: 10_000,
    autoSaveMs: 20,
    now: () => 'auto-save-time',
  });
  const events = [];
  server.broadcast = (event) => events.push(event);
  try {
    await server.listen();
    const session = fakeSession();
    server.persistence.register(session);
    server.persistence.update(session.id, { name: 'After cadence' });
    assert.deepEqual(await waitFor(events, (event) => event.type === 'sessions.saved'), {
      type: 'sessions.saved',
      success: true,
      reason: 'auto',
      savedAt: 'auto-save-time',
      count: 1,
    });
    const stored = JSON.parse(readFileSync(server.persistence.registryPath, 'utf8'));
    assert.equal(stored[0].name, 'After cadence');
  } finally {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('graceful shutdown flushes pending state and broadcasts its final save', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-next-shutdown-save-'));
  const server = new HeadlessServer({
    port: 0,
    dataDir,
    persistenceDebounceMs: 10_000,
    autoSaveMs: 0,
    now: () => 'shutdown-save-time',
  });
  const events = [];
  server.broadcast = (event) => events.push(event);
  try {
    await server.listen();
    const session = fakeSession();
    server.persistence.register(session);
    server.persistence.update(session.id, { name: 'Saved on shutdown' });
    await server.close();
    assert.deepEqual(events.at(-1), {
      type: 'sessions.saved',
      success: true,
      reason: 'shutdown',
      savedAt: 'shutdown-save-time',
      count: 1,
    });

    const restored = new SessionPersistence({ dataDir });
    assert.equal(restored.get(session.id).name, 'Saved on shutdown');
    restored.close();
  } finally {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
