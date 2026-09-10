const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveBuildVersion } = require('../src/build-version');

test('build version includes the commit identity', () => {
  const version = resolveBuildVersion('1.2.3', (command, args, options) => {
    assert.equal(command, 'git');
    assert.deepEqual(args, ['log', '-1', '--format=%h%n%cs']);
    assert.equal(options.timeout, 200);
    return '40fd198\n2026-07-31\n';
  });
  assert.equal(version, '1.2.3+40fd198 (2026-07-31)');
});

test('build version falls back when git is absent or times out', () => {
  for (const code of ['ENOENT', 'ETIMEDOUT']) {
    const version = resolveBuildVersion('1.2.3', () => {
      const error = new Error(code);
      error.code = code;
      throw error;
    });
    assert.equal(version, '1.2.3');
  }
});
