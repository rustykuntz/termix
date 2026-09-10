const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { parseArgs } = require('../src/server');
const { createServer } = require('node:net');

const cli = resolve(__dirname, '../bin/clideck.js');

test('launcher validates options and honors explicit port before environment', () => {
  assert.deepEqual(parseArgs([], { CLIDECK_PORT: '4200' }), { port: 4200 });
  assert.deepEqual(parseArgs([], { PORT: '4567' }), { port: 4567 });
  assert.deepEqual(parseArgs([], { PORT: '4567', CLIDECK_PORT: '4200' }), { port: 4200 });
  assert.deepEqual(parseArgs(['--port=4321'], { PORT: '4567' }), { port: 4321 });
  assert.deepEqual(parseArgs(['--port', '0'], { CLIDECK_PORT: 'bad' }), { port: 0 });
  for (const value of ['-1', '65536', '1.5', 'NaN']) {
    assert.throws(() => parseArgs([], { CLIDECK_PORT: value }), /Port must/);
  }
  assert.throws(() => parseArgs(['--data-dir']), /requires a value/);
  assert.throws(() => parseArgs(['--port', '--host', 'localhost']), /requires a value/);
  assert.throws(() => parseArgs(['--unknown', 'x']), /Unknown option/);
});

test('installed command reports package version', () => {
  const result = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), require('../package.json').version);
});

test('bare clideck honors PORT and automatically imports legacy sessions without changing v1', { timeout: 15000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'clideck-launcher-'));
  const legacy = join(home, '.clideck');
  mkdirSync(legacy);
  const oldState = JSON.stringify([{ id: 'legacy-session', name: 'Reviewer', cwd: home, presetId: 'codex', sessionToken: 'keep-me' }]);
  writeFileSync(join(legacy, 'sessions.json'), oldState);
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const customPort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const child = spawn(process.execPath, [cli], {
    env: { ...process.env, HOME: home, USERPROFILE: home, CLIDECK_PORT: '', PORT: String(customPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  let output = '';
  let errors = '';
  child.stderr.on('data', (chunk) => { errors += chunk; });
  try {
    const url = await new Promise((resolveUrl, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`Launcher exited ${code}: ${errors}`)));
      child.stdout.on('data', (chunk) => {
        output += chunk;
        const match = output.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) resolveUrl(match[1]);
      });
    });
    assert.equal(url, `http://127.0.0.1:${customPort}`);
    assert.equal((await fetch(url)).status, 200);
    const migrated = JSON.parse(readFileSync(join(home, '.clideck-next', 'sessions.json'), 'utf8'));
    assert.equal(migrated[0].resumeHandle, 'keep-me');
    assert.equal(migrated[0].provider, 'codex');
    assert.equal(readFileSync(join(legacy, 'sessions.json'), 'utf8'), oldState);
    assert.equal(existsSync(join(home, '.clideck-next', 'server.lock')), true);
    child.kill('SIGTERM');
    const [code] = await exited;
    assert.equal(code, 0, errors);
    assert.equal(existsSync(join(home, '.clideck-next', 'server.lock')), false);
    assert.equal(readFileSync(join(legacy, 'sessions.json'), 'utf8'), oldState);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
    rmSync(home, { recursive: true, force: true });
  }
});
