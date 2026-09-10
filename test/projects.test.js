const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { ConfigStore, isValidConfigPatch } = require('../src/config-store');
const { SessionPersistence } = require('../src/persistence');
const { HeadlessServer } = require('../src/server');

const PROJECTS = [
  { id: 'main', name: 'Main', path: '/tmp/main', color: '#123456', collapsed: false },
  { id: 'other', name: 'Other', path: '/tmp/other', color: '#654321', collapsed: true },
];

function session(id, name, cwd, projectId, includeProject = true) {
  return {
    id,
    name,
    provider: { id: 'shell' },
    cwd,
    cols: 100,
    rows: 30,
    ...(includeProject && { projectId }),
  };
}

test('project config model validates and round-trips', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-next-project-config-'));
  try {
    const store = new ConfigStore({ dataDir });
    store.update({ projects: PROJECTS });
    assert.deepEqual(new ConfigStore({ dataDir }).get().projects, PROJECTS);
    assert.equal(isValidConfigPatch({ projects: [{ ...PROJECTS[0], collapsed: 'no' }] }), false);
    assert.equal(isValidConfigPatch({ projects: [{ ...PROJECTS[0], id: '../bad' }] }), false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('session project identity persists and dormant snapshots always carry the field', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-next-project-persistence-'));
  try {
    const persistence = new SessionPersistence({ dataDir });
    const projected = session('projected', 'Projected', '/tmp/main', 'main');
    const legacy = session('legacy', 'Legacy', '/tmp/legacy', null, false);
    persistence.register(projected);
    persistence.register(legacy);
    persistence.close();

    const restored = new SessionPersistence({ dataDir });
    assert.equal(restored.get(projected.id).projectId, 'main');
    assert.equal(Object.hasOwn(restored.get(legacy.id), 'projectId'), false);
    const server = new HeadlessServer({ port: 0, persistence: restored, autoSaveMs: 0 });
    assert.equal(server.dormantSnapshot(restored.get(projected.id)).projectId, 'main');
    assert.equal(server.dormantSnapshot(restored.get(legacy.id)).projectId, null);
    restored.close();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('project assignment enforces project name scope and preserves legacy cwd scope', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-next-project-scope-'));
  const server = new HeadlessServer({ port: 0, dataDir, autoSaveMs: 0 });
  const events = [];
  server.broadcast = (event) => events.push(event);
  try {
    await server.listen();
    server.configStore.update({ projects: PROJECTS });
    const mainReviewer = session('main-reviewer', 'Reviewer', '/tmp/a', 'main');
    const otherReviewer = session('other-reviewer', 'Reviewer', '/tmp/b', 'other');
    const ungroupedReviewer = session('ungrouped-reviewer', 'Reviewer', '/tmp/c', null);
    const legacyReviewer = session('legacy-reviewer', 'Reviewer', '/tmp/legacy', null, false);
    for (const value of [mainReviewer, otherReviewer, ungroupedReviewer, legacyReviewer]) {
      server.persistence.register(value);
    }

    assert.equal(server.setSessionProject(otherReviewer.id, 'main'), false);
    assert.equal(server.persistence.get(otherReviewer.id).projectId, 'other');
    assert.equal(events.at(-1).error.operation, 'session.setProject');
    assert.equal(events.at(-1).error.conflictSessionId, mainReviewer.id);

    const starts = [];
    server.startSession = (options) => {
      starts.push(options);
      return options;
    };
    assert.equal(server.createSession({
      provider: 'shell', name: 'reviewer', cwd: '/tmp/new', projectId: 'main',
    }), false);
    assert.equal(server.createSession({
      provider: 'shell', name: 'reviewer', cwd: '/tmp/new', projectId: null,
    }), false);
    assert.equal(server.createSession({
      provider: 'shell', name: 'reviewer', cwd: '/tmp/legacy-other',
    }).cwd, '/tmp/legacy-other');
    assert.equal(server.createSession({
      provider: 'shell', name: 'reviewer', cwd: '/tmp/legacy',
    }), false);
    assert.equal(starts.length, 1);

    assert.equal(server.setSessionProject(legacyReviewer.id, 'other'), false);
    assert.equal(Object.hasOwn(server.persistence.get(legacyReviewer.id), 'projectId'), false);
    assert.equal(server.renameSession(legacyReviewer.id, 'Builder'), true);
    assert.equal(server.setSessionProject(legacyReviewer.id, null), true);
    assert.equal(server.persistence.get(legacyReviewer.id).projectId, null);
    assert.equal(events.at(-1).projectId, null);
  } finally {
    server.sessions.clear();
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('project deletion closes live and dormant sessions before removing the entity', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-next-project-delete-'));
  const server = new HeadlessServer({ port: 0, dataDir, autoSaveMs: 0 });
  const events = [];
  server.broadcast = (event) => events.push(event);
  try {
    await server.listen();
    server.configStore.update({ projects: PROJECTS });
    const dormant = session('dormant-main', 'Dormant', '/tmp/main', 'main');
    const liveEntry = session('live-main', 'Live', '/tmp/main', 'main');
    const outside = session('outside', 'Outside', '/tmp/other', 'other');
    server.persistence.register(dormant);
    server.persistence.register(liveEntry);
    server.persistence.register(outside);
    const live = {
      ...liveEntry,
      closed: false,
      closeCalled: false,
      close() {
        this.closeCalled = true;
        this.closed = true;
      },
      waitForClose() { return Promise.resolve(); },
    };
    server.sessions.set(live.id, live);

    assert.equal(await server.deleteProject('main'), true);
    assert.equal(live.closeCalled, true);
    assert.equal(server.sessions.has(live.id), false);
    assert.equal(server.persistence.has(dormant.id), false);
    assert.equal(server.persistence.has(live.id), false);
    assert.equal(server.persistence.has(outside.id), true);
    assert.deepEqual(server.configStore.get().projects, [PROJECTS[1]]);
    assert.deepEqual(events.filter((event) => event.type === 'session.closed')
      .map((event) => event.sessionId).sort(), [dormant.id, live.id].sort());
    assert.equal(events.at(-1).type, 'config');
  } finally {
    server.sessions.clear();
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('ambiguous project addresses return a clear HTTP conflict', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-next-project-address-'));
  const server = new HeadlessServer({ port: 0, dataDir, autoSaveMs: 0 });
  try {
    server.configStore.update({ projects: [
      { ...PROJECTS[0], id: 'duplicate-one', name: 'Duplicate' },
      { ...PROJECTS[1], id: 'duplicate-two', name: 'duplicate' },
    ] });
    const { httpUrl } = await server.listen();
    const response = await fetch(`${httpUrl}/api/session/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: '@Duplicate/Reviewer', text: 'Hello' }),
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: 'ambiguous_project',
      candidateProjectIds: ['duplicate-one', 'duplicate-two'],
      message: 'Multiple projects named "Duplicate". Use the project id.',
      targets: [],
    });
  } finally {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
