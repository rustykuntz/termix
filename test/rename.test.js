const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { resolveAskTarget } = require('../src/ask');
const { HeadlessServer } = require('../src/server');

function registrySession(id, name) {
  return {
    id,
    name,
    provider: { id: 'claude-code' },
    cwd: '/tmp/project',
    cols: 100,
    rows: 30,
  };
}

test('session rename updates live and dormant identities and ask resolution', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-next-rename-'));
  const server = new HeadlessServer({ port: 0, dataDir });
  const events = [];
  server.broadcast = (event) => events.push(event);
  try {
    await server.listen();
    const live = {
      ...registrySession('live-session', 'Old live'),
      closed: false,
      snapshot() {
        return {
          type: 'session.created',
          sessionId: this.id,
          provider: this.provider.id,
          name: this.name,
          muted: false,
          live: true,
        };
      },
      close() {},
      waitForClose: () => Promise.resolve(),
    };
    server.persistence.register(live);
    server.sessions.set(live.id, live);

    assert.equal(server.renameSession(live.id, '  Reviewer  '), true);
    assert.equal(live.name, 'Reviewer');
    assert.equal(server.persistence.get(live.id).name, 'Reviewer');
    assert.equal(events.at(-1).name, 'Reviewer');
    assert.equal(events.at(-1).live, true);
    assert.equal(resolveAskTarget(server.persistence.list(), 'Reviewer').entry.id, live.id);

    assert.equal(server.renameSession(live.id, '   '), true);
    assert.equal(server.persistence.get(live.id).name, '');

    const dormant = registrySession('dormant-session', 'Old dormant');
    server.persistence.register(dormant);
    assert.equal(server.renameSession(dormant.id, '  Archive  '), true);
    assert.equal(server.persistence.get(dormant.id).name, 'Archive');
    assert.equal(events.at(-1).name, 'Archive');
    assert.equal(events.at(-1).live, false);
    assert.equal(server.renameSession('unknown-session', 'Ignored'), false);
  } finally {
    server.sessions.clear();
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('session names are unique per cwd group and conflicts preserve the existing identity', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-next-unique-names-'));
  const server = new HeadlessServer({ port: 0, dataDir });
  const events = [];
  server.broadcast = (event) => events.push(event);
  try {
    await server.listen();
    const reviewer = registrySession('reviewer-session', 'Reviewer');
    const builder = registrySession('builder-session', 'Builder');
    server.persistence.register(reviewer);
    server.persistence.register(builder);
    const liveBuilder = {
      ...builder,
      closed: false,
      snapshot() {
        return {
          type: 'session.created',
          sessionId: this.id,
          protocol: 1,
          provider: this.provider.id,
          name: this.name,
          pid: 42,
          cwd: this.cwd,
          cols: this.cols,
          rows: this.rows,
          muted: false,
          live: true,
        };
      },
      close() {
        this.closed = true;
      },
      waitForClose: () => Promise.resolve(),
    };
    server.sessions.set(builder.id, liveBuilder);

    assert.equal(server.renameSession(builder.id, '  rEvIeWeR  '), false);
    assert.equal(server.persistence.get(builder.id).name, 'Builder');
    assert.deepEqual(events.at(-1), {
      type: 'session.created',
      sessionId: builder.id,
      protocol: 1,
      provider: 'claude-code',
      name: 'Builder',
      pid: 42,
      cwd: builder.cwd,
      cols: builder.cols,
      rows: builder.rows,
      muted: false,
      live: true,
      error: {
        code: 'name_conflict',
        operation: 'session.rename',
        field: 'name',
        value: 'rEvIeWeR',
        cwd: builder.cwd,
        conflictSessionId: reviewer.id,
        message: 'Session name "rEvIeWeR" is already taken in this project.',
      },
    });

    assert.equal(server.createSession({
      provider: 'shell',
      cwd: reviewer.cwd,
      name: ' reviewer ',
    }), false);
    assert.equal(events.at(-1).sessionId, reviewer.id);
    assert.equal(events.at(-1).name, 'Reviewer');
    assert.equal(events.at(-1).error.operation, 'session.create');

    const starts = [];
    server.startSession = (options) => {
      starts.push(options);
      return options;
    };
    assert.equal(server.createSession({
      provider: 'shell',
      cwd: '/tmp/another-project',
      name: 'REVIEWER',
    }).cwd, '/tmp/another-project');
    assert.equal(server.createSession({
      provider: 'shell',
      cwd: reviewer.cwd,
      name: '',
    }).name, '');
    assert.equal(starts.length, 2);
  } finally {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
