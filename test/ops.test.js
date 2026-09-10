const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { SessionPersistence } = require('../src/persistence');
const { ServerLock } = require('../src/server-lock');
const { HeadlessServer, installShutdownHandlers, main } = require('../src/server');
const { alreadyRunningLine, nonLoopbackWarning, startupBanner } = require('../src/startup');
const { TranscriptStore } = require('../src/transcript-store');

test('startup refuses non-loopback hosts before creating engine state', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'clideck-next-localhost-only-'));
  const dataDir = join(parent, 'state');
  try {
    await assert.rejects(
      main(['--host', '0.0.0.0', '--port', '0', '--data-dir', dataDir]),
      /localhost-only.*0\.0\.0\.0/,
    );
    assert.equal(existsSync(dataDir), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('server lock acquires, updates, and cleans up only its owned lock', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-next-lock-owned-'));
  const lock = new ServerLock({
    dataDir,
    pid: 111,
    now: () => 'started-now',
    isPidAlive: () => false,
  });
  try {
    assert.deepEqual(lock.acquire({
      host: '127.0.0.1', port: 4100, url: 'http://127.0.0.1:4100',
    }), {
      ok: true,
      lock: {
        pid: 111,
        host: '127.0.0.1',
        port: 4100,
        url: 'http://127.0.0.1:4100',
        startedAt: 'started-now',
      },
    });
    assert.equal(lock.update({
      host: '127.0.0.1', port: 43123, url: 'http://127.0.0.1:43123',
    }), true);
    assert.equal(JSON.parse(readFileSync(lock.path, 'utf8')).port, 43123);
    assert.equal(lock.release(), true);
    assert.equal(existsSync(lock.path), false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('server lock rejects a live owner and steals a stale lock', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-next-lock-contention-'));
  const path = join(dataDir, 'server.lock');
  const existing = {
    pid: 222,
    host: '127.0.0.1',
    port: 4100,
    url: 'http://127.0.0.1:4100',
    startedAt: 'before',
  };
  try {
    writeFileSync(path, JSON.stringify(existing));
    const rejected = new ServerLock({
      dataDir,
      pid: 333,
      isPidAlive: (pid) => pid === 222,
    });
    assert.deepEqual(rejected.acquire({
      host: '127.0.0.1', port: 4200, url: 'http://127.0.0.1:4200',
    }), { ok: false, lock: existing });

    const stale = new ServerLock({
      dataDir,
      pid: 444,
      now: () => 'after',
      isPidAlive: () => false,
    });
    assert.equal(stale.acquire({
      host: 'localhost', port: 4300, url: 'http://localhost:4300',
    }).ok, true);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
      pid: 444,
      host: 'localhost',
      port: 4300,
      url: 'http://localhost:4300',
      startedAt: 'after',
    });
    stale.release();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('startup banner preserves plain logs and renders the legacy terminal screen', () => {
  const values = { version: '1.2.3', url: 'http://127.0.0.1:4100' };
  const plain = startupBanner({ ...values, isTTY: false });
  assert.equal(plain, 'CliDeck v1.2.3 listening at http://127.0.0.1:4100');
  assert.equal(plain.includes('\x1b]8;;'), false);

  const tty = startupBanner({ ...values, isTTY: true, platform: 'darwin' });
  assert.match(tty, /\u2588\u2588\u2588\u2588\u2588\u2588╗/);
  assert.match(tty, /v1\.2\.3/);
  assert.match(tty, /▸ Ready at/);
  assert.match(tty, /Cmd\+click to open/);
  assert.match(tty, /Stop with .*Ctrl\+C/);
  assert.match(tty, /Restart anytime with .*clideck/);
  assert.match(tty, /\x1b\]8;;http:\/\/127\.0\.0\.1:4100\x07/);
  assert.match(tty, /\x1b\]8;;\x07/);
  assert.equal(
    alreadyRunningLine(values.url, false),
    'CliDeck is already running at http://127.0.0.1:4100',
  );
  assert.match(nonLoopbackWarning('0.0.0.0'), /SECURITY WARNING.*without authentication/);
});

test('SIGTERM shutdown flushes registry and synchronous transcripts before exit', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-next-signal-shutdown-'));
  const lock = new ServerLock({ dataDir, isPidAlive: () => false });
  lock.acquire({ host: '127.0.0.1', port: 0, url: 'http://127.0.0.1:0' });
  const server = new HeadlessServer({
    port: 0,
    dataDir,
    autoSaveMs: 0,
    persistenceDebounceMs: 10_000,
    serverLock: lock,
  });
  const id = 'signal-session';
  const runtime = new EventEmitter();
  const exited = new Promise((resolve) => {
    runtime.exit = resolve;
  });
  try {
    await server.listen();
    server.persistence.register({
      id,
      provider: { id: 'shell' },
      name: 'Before',
      cwd: dataDir,
      cols: 100,
      rows: 30,
    });
    server.persistence.update(id, { name: 'Flushed by signal' });
    server.transcriptStore.append(id, 'user', 'persist this turn');
    installShutdownHandlers(server, runtime);
    assert.equal(runtime.listenerCount('SIGINT'), 1);
    assert.equal(runtime.listenerCount('SIGTERM'), 1);
    runtime.emit('SIGTERM');
    assert.equal(await exited, 0);

    assert.equal(existsSync(lock.path), false);
    const restored = new SessionPersistence({ dataDir });
    assert.equal(restored.get(id).name, 'Flushed by signal');
    restored.close();
    const transcripts = new TranscriptStore({ dataDir, validIds: [id] });
    assert.deepEqual(transcripts.getTurns(id, 1), [{ role: 'user', text: 'persist this turn' }]);
  } finally {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
