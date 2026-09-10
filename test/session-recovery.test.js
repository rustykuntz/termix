const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { SessionPersistence } = require('../src/persistence');
const { HeadlessServer } = require('../src/server');
const { TranscriptStore } = require('../src/transcript-store');
const { ContentStore } = require('../src/content-store');

function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-recovery-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}
const entry = { id: 'one', provider: 'codex', cwd: '/tmp', resumeHandle: 'native-one' };

test('corrupt or missing registry recovers its saved sessions and preserves newer orphan data', (t) => {
  for (const missing of [false, true]) {
    const dataDir = fixture(t);
    writeFileSync(join(dataDir, 'sessions.backup.json'), JSON.stringify([entry]));
    if (!missing) writeFileSync(join(dataDir, 'sessions.json'), '{broken');
    mkdirSync(join(dataDir, 'transcripts'));
    writeFileSync(join(dataDir, 'transcripts', 'newer.jsonl'), 'recovery material');
    mkdirSync(join(dataDir, 'assets', 'newer'), { recursive: true });
    writeFileSync(join(dataDir, 'assets', 'newer', 'image.content'), 'image bytes');
    const persistence = new SessionPersistence({ dataDir });
    assert.equal(persistence.get('one').resumeHandle, 'native-one');
    assert.equal(JSON.parse(readFileSync(join(dataDir, 'sessions.json')))[0].id, 'one');
    if (!missing) assert.ok(readdirSync(dataDir).some((name) => name.startsWith('sessions.json.corrupt-')));
    new TranscriptStore({ dataDir, validIds: ['one'] });
    new ContentStore({ dataDir }).restoreSessions(persistence.list());
    assert.ok(existsSync(join(dataDir, 'transcripts', 'newer.jsonl')));
    assert.ok(existsSync(join(dataDir, 'assets', 'newer', 'image.content')));
    persistence.close();
  }
});

test('unrecoverable or partially invalid registries stop before startup can modify saved data', (t) => {
  for (const text of ['{broken', '{}', JSON.stringify([entry, {}]), JSON.stringify([entry, entry])]) {
    const dataDir = fixture(t);
    writeFileSync(join(dataDir, 'sessions.json'), text);
    assert.throws(() => new HeadlessServer({ dataDir, port: 0 }), /Saved data was left untouched/);
    assert.equal(readFileSync(join(dataDir, 'sessions.json'), 'utf8'), text);
  }
});

test('registry saves retain a previous valid snapshot and seed a recovery copy on first save', (t) => {
  const dataDir = fixture(t);
  const persistence = new SessionPersistence({ dataDir });
  persistence.register({ ...entry, provider: { id: 'codex' }, name: 'Before' });
  const backup = join(dataDir, 'sessions.backup.json');
  assert.equal(JSON.parse(readFileSync(backup))[0].name, 'Before');
  persistence.update('one', { name: 'After' }, true);
  assert.equal(JSON.parse(readFileSync(backup))[0].name, 'Before');
  persistence.flush();
  assert.equal(JSON.parse(readFileSync(backup))[0].name, 'Before');
  persistence.close();
});

test('session download includes current registry and projects without plugin credentials', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-export-'));
  const server = new HeadlessServer({ dataDir, port: 0 });
  t.after(async () => { await server.close(); rmSync(dataDir, { recursive: true, force: true }); });
  await server.listen();
  server.persistence.register({ ...entry, provider: { id: 'codex' }, name: 'Current' });
  server.configStore.update({ projects: [{ id: 'project', name: 'Project', path: '/tmp', color: '', collapsed: false }], plugins: { private: { secret: 'do-not-export' } } });
  const url = `http://127.0.0.1:${server.port}/api/session/backup`;
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition'), /attachment; filename="clideck-sessions-/);
  const backup = await response.json();
  assert.equal(backup.format, 'clideck-session-backup');
  assert.equal(backup.sessions[0].name, 'Current');
  assert.equal(backup.projects[0].id, 'project');
  assert.equal(JSON.stringify(backup).includes('do-not-export'), false);
  assert.equal((await fetch(url, { headers: { Origin: 'https://example.com' } })).status, 403);
});
