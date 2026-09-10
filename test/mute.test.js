const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { AgentSession } = require('../src/session');
const { getProvider } = require('../src/providers');
const { HeadlessServer } = require('../src/server');

test('session mute updates and rebroadcasts live and dormant snapshots', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-next-mute-'));
  const server = new HeadlessServer({ port: 0, dataDir });
  const events = [];
  server.broadcast = (event) => events.push(event);
  try {
    await server.listen();
    const dormant = new AgentSession({
      id: 'dormant-session',
      provider: getProvider('shell'),
      name: 'Dormant',
      cwd: '/tmp/muted-project',
    });
    server.persistence.register(dormant);
    assert.equal(server.setSessionMute(dormant.id, true), true);
    assert.equal(server.persistence.get(dormant.id).muted, true);
    assert.equal(events.at(-1).type, 'session.created');
    assert.equal(events.at(-1).sessionId, dormant.id);
    assert.equal(events.at(-1).live, false);
    assert.equal(events.at(-1).muted, true);

    const live = new AgentSession({
      id: 'live-session',
      provider: getProvider('shell'),
      name: 'Live',
      cwd: '/tmp/muted-project',
      muted: true,
    });
    server.persistence.register(live);
    server.sessions.set(live.id, live);
    assert.equal(server.setSessionMute(live.id, false), true);
    assert.equal(live.muted, false);
    assert.equal(server.persistence.get(live.id).muted, false);
    assert.equal(events.at(-1).type, 'session.created');
    assert.equal(events.at(-1).sessionId, live.id);
    assert.equal(events.at(-1).live, true);
    assert.equal(events.at(-1).muted, false);
    assert.equal(server.setSessionMute('unknown-session', true), false);
    server.sessions.clear();
  } finally {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
