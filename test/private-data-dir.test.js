const test = require('node:test');
const assert = require('node:assert/strict');
const {
  chmodSync,
  mkdtempSync,
  rmSync,
  statSync,
} = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { ConfigStore } = require('../src/config-store');
const { SessionPersistence } = require('../src/persistence');
const { ServerLock } = require('../src/server-lock');
const { TranscriptStore } = require('../src/transcript-store');

test('state stores create private data directories and repair existing modes', () => {
  const parent = mkdtempSync(join(tmpdir(), 'clideck-next-private-state-'));
  const factories = [
    (dataDir) => new ConfigStore({ dataDir }),
    (dataDir) => new SessionPersistence({ dataDir }).close(),
    (dataDir) => new TranscriptStore({ dataDir }),
    (dataDir) => new ServerLock({ dataDir }),
  ];
  try {
    factories.forEach((create, index) => {
      const dataDir = join(parent, `state-${index}`);
      create(dataDir);
      assert.equal(statSync(dataDir).mode & 0o777, 0o700);

      chmodSync(dataDir, 0o755);
      create(dataDir);
      assert.equal(statSync(dataDir).mode & 0o777, 0o700);
    });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
