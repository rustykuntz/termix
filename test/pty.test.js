const test = require('node:test');
const assert = require('node:assert/strict');
const nativePty = require('node-pty');
const { spawn } = require('../src/pty');

test('provider PTY environment excludes inherited Claude nesting state', () => {
  const blocked = {
    CLAUDECODE: '1',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_EXECPATH: '/bin/claude',
    CLAUDE_CODE_SESSION_ID: 'parent-session',
    CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    CLAUDE_EFFORT: 'high',
  };
  const previous = Object.fromEntries(
    [...Object.keys(blocked), 'CLIDECK_PTY_TEST_KEEP'].map((key) => [key, process.env[key]]),
  );
  const originalSpawn = nativePty.spawn;
  let captured;

  try {
    Object.assign(process.env, blocked, { CLIDECK_PTY_TEST_KEEP: 'kept' });
    nativePty.spawn = (file, args, options) => {
      captured = { file, args, options };
      return {};
    };
    spawn('claude', [], { env: { ...process.env } });

    assert.equal(captured.options.env.CLIDECK_PTY_TEST_KEEP, 'kept');
    for (const key of Object.keys(blocked)) {
      assert.equal(Object.hasOwn(captured.options.env, key), false);
      assert.equal(process.env[key], blocked[key]);
    }
  } finally {
    nativePty.spawn = originalSpawn;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
