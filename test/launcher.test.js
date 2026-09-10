const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { parseArgs } = require('../src/server');

const cli = resolve(__dirname, '../bin/clideck.js');

test('launcher validates options and honors explicit port before environment', () => {
  assert.deepEqual(parseArgs([], { CLIDECK_PORT: '4200' }), { port: 4200 });
  assert.deepEqual(parseArgs(['--port', '0'], { CLIDECK_PORT: 'bad' }), { port: 0 });
  for (const value of ['-1', '65536', '1.5', 'NaN', '']) {
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

test('bare clideck starts v2 separately from legacy state and releases its lock', { timeout: 15000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'clideck-launcher-'));
  const legacy = join(home, '.clideck');
  mkdirSync(legacy);
  const oldState = '[{"id":"legacy-session","sessionToken":"keep-me"}]';
  writeFileSync(join(legacy, 'sessions.json'), oldState);
  const child = spawn(process.execPath, [cli], {
    env: { ...process.env, HOME: home, USERPROFILE: home, CLIDECK_PORT: '0' },
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
    assert.equal((await fetch(url)).status, 200);
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
