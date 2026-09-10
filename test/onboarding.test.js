const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { ConfigStore, isValidConfigPatch } = require('../src/config-store');
const { HeadlessServer, main } = require('../src/server');
const { MAX_SEEN_TIPS } = require('../src/onboarding');

function temp(t) {
  const root = mkdtempSync(join(tmpdir(), 'clideck-onboarding-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('new data directories persist a pending walkthrough before any browser connects', async (t) => {
  const root = temp(t), dataDir = join(root, 'fresh');
  const first = new HeadlessServer({ port: 0, dataDir });
  await first.listen();
  assert.deepEqual(first.configStore.get().onboarding, { completed: false, seenTips: [] });
  assert.deepEqual(JSON.parse(readFileSync(join(dataDir, 'config.json'))).onboarding,
    { completed: false, seenTips: [] });
  await first.close();
  const again = new HeadlessServer({ port: 0, dataDir });
  try {
    await again.listen();
    assert.equal(again.configStore.get().onboarding.completed, false);
    again.configStore.update({ onboarding: { completed: true, seenTips: ['welcome.projects'] } });
  } finally { await again.close(); }
  assert.deepEqual(new ConfigStore({ dataDir }).get().onboarding,
    { completed: true, seenTips: ['welcome.projects'] });
});

test('real CLI startup captures first install before ServerLock creates the directory', async (t) => {
  const dataDir = join(temp(t), 'cli-fresh');
  const signals = ['SIGINT', 'SIGTERM'];
  const before = new Map(signals.map((s) => [s, process.listeners(s)]));
  let server;
  try {
    ({ server } = await main(['--port', '0', '--data-dir', dataDir]));
    assert.equal(server.configStore.get().onboarding.completed, false);
    assert.equal(JSON.parse(readFileSync(join(dataDir, 'config.json'))).onboarding.completed, false);
  } finally {
    await server?.close();
    for (const signal of signals) {
      for (const listener of process.listeners(signal)) {
        if (!before.get(signal).includes(listener)) process.removeListener(signal, listener);
      }
    }
  }
});

test('existing, migrated and recovered state never infers first use from missing config keys', async (t) => {
  const root = temp(t);
  for (const scenario of ['empty-directory', 'sessions-without-config', 'legacy-config', 'corrupt-config']) {
    const dataDir = join(root, scenario);
    mkdirSync(dataDir);
    if (scenario === 'sessions-without-config') writeFileSync(join(dataDir, 'sessions.json'), JSON.stringify([
      { id: 'existing-session', provider: 'shell', cwd: dataDir, name: 'Existing work' },
    ]));
    if (scenario === 'legacy-config') writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ defaultCwd: '/project' }));
    if (scenario === 'corrupt-config') writeFileSync(join(dataDir, 'config.json'), '{broken');
    const server = new HeadlessServer({ port: 0, dataDir });
    try {
      await server.listen();
      assert.equal(server.configStore.get().onboarding, undefined, scenario);
      if (scenario === 'sessions-without-config') assert.equal(server.persistence.list().length, 1);
    } finally { await server.close(); }
  }
});

test('an explicit early first-install snapshot survives precreated persistence directories', async (t) => {
  const dataDir = join(temp(t), 'already-created-by-lock');
  mkdirSync(dataDir);
  const server = new HeadlessServer({ port: 0, dataDir, freshInstall: true });
  try {
    await server.listen();
    assert.equal(server.configStore.get().onboarding.completed, false);
  } finally { await server.close(); }
});

test('stale tabs cannot erase completion or previously seen update tips', (t) => {
  const dataDir = temp(t), store = new ConfigStore({ dataDir });
  store.update({ onboarding: { completed: true, seenTips: ['about-me'] } });
  store.update({ onboarding: { completed: false, seenTips: ['agent-tools', 'about-me'] } });
  store.update({ onboarding: { seenTips: [] } });
  store.update({ defaultCwd: '/another-folder' });
  assert.deepEqual(new ConfigStore({ dataDir }).get().onboarding,
    { completed: true, seenTips: ['about-me', 'agent-tools'] });
});

test('tour progress is validated and bounded, including union size across updates', (t) => {
  for (const onboarding of [null, [], { completed: 'yes' }, { seenTips: 'about-me' },
    { seenTips: [''] }, { seenTips: ['../invalid'] }, { seenTips: ['x'.repeat(81)] },
    { seenTips: [5] }, { unknown: true }]) assert.equal(isValidConfigPatch({ onboarding }), false);
  const store = new ConfigStore({ dataDir: temp(t) });
  store.update({ onboarding: { seenTips: Array.from({ length: MAX_SEEN_TIPS }, (_, i) => `feature-${i}`) } });
  assert.throws(() => store.update({ onboarding: { seenTips: ['one-too-many'] } }), /Too many/);
  assert.equal(store.get().onboarding.seenTips.length, MAX_SEEN_TIPS);
});
