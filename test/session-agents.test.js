const test = require('node:test');
const assert = require('node:assert/strict');
const { listSessionAgents, resolveLiveCaller } = require('../src/session-agents');
const { formatAgents, formatStatus } = require('../src/cli');
const { AGENT_SESSION_GUIDE } = require('../src/agent-session-guide');

function fixture() {
  const projects = [{ id: 'here', name: 'Current' }, { id: 'there', name: 'Other' }];
  const entries = ['self', 'idle', 'working', 'stopped', 'closed', 'elsewhere'].map((id) => ({
    id, name: id, provider: 'codex', cwd: '/same-folder', projectId: id === 'elsewhere' ? 'there' : 'here',
    lastActive: '2026-09-08T06:45:33Z', lastFinal: 'Previous final',
  }));
  const sessions = new Map(entries.filter((e) => e.id !== 'stopped').map((e) => [e.id, {
    id: e.id, status: e.id === 'working' ? 'working' : 'idle', closed: e.id === 'closed',
    menu: [], latestUpdate: 'Current update',
  }]));
  const coordinator = { isActive: () => false };
  const caller = resolveLiveCaller(entries, sessions, 'self');
  const list = (options) => listSessionAgents(entries, sessions, coordinator, caller, projects, options);
  return { entries, sessions, coordinator, caller, projects, list };
}

test('discovery includes current-project dormant sessions and explicit live states', () => {
  const f = fixture(), agents = f.list();
  assert.deepEqual(agents.map((a) => [a.id, a.status]), [
    ['self', 'idle'], ['idle', 'idle'], ['working', 'working'], ['stopped', 'dormant'], ['closed', 'dormant'],
  ]);
  const stopped = agents.find((a) => a.id === 'stopped');
  assert.equal(stopped.live, false);
  assert.equal(stopped.working, false);
  assert.equal(stopped.supportsAsk, true);
  assert.equal(stopped.lastPreview, 'Previous final');
  assert.equal(stopped.lastActive, '2026-09-08T06:45:33.000Z');
  assert.equal(agents.find((a) => a.id === 'closed').lastPreview, 'Previous final');
  assert.equal(agents[0].caller, true);
  assert.equal(agents[0].lastPreview, 'Current update');
  assert.equal(resolveLiveCaller(f.entries, f.sessions, 'stopped'), null);
});

test('all includes other projects and reflects closure and rename on the next request', () => {
  const f = fixture();
  assert.equal(f.list({ all: true }).length, 6);
  assert.equal(f.list({ all: true }).at(-1).projectName, 'Other');
  f.sessions.get('idle').closed = true;
  f.entries.find((e) => e.id === 'idle').name = 'Renamed';
  const refreshed = f.list().find((a) => a.id === 'idle');
  assert.equal(refreshed.status, 'dormant');
  assert.equal(refreshed.address, '@Current/Renamed');
  assert.equal(f.list({ all: false }).some((a) => a.id === 'elsewhere'), false);
});

test('missing timestamps stay unknown, shell cannot be asked, reserved sessions stay busy', () => {
  const f = fixture();
  f.entries[1].lastActive = 'not a date';
  f.entries[1].provider = 'shell';
  delete f.entries[2].lastActive;
  f.coordinator.isActive = (id) => id === 'self';
  const agents = f.list();
  assert.equal(agents[0].status, 'working');
  assert.equal(agents[1].lastActive, null);
  assert.equal(agents[1].supportsAsk, false);
  assert.equal(agents[2].lastActive, null);
  assert.match(formatAgents(agents), /no-ask/);
});

test('legacy folder scoping is preserved and all still exposes unassigned sessions', () => {
  const f = fixture();
  for (const e of f.entries) delete e.projectId;
  f.entries.at(-1).cwd = '/other';
  assert.equal(f.list().length, 5);
  assert.equal(f.list({ all: true }).length, 6);
  assert.equal(f.list()[0].address, '@same-folder/self');
  assert.equal(f.list()[0].projectName, 'No project');
});

test('text groups all projects, omits previews, and preserves complete ask addresses', () => {
  const agents = fixture().list({ all: true });
  agents[1].address = '@Current/two  spaces ' + 'long'.repeat(50);
  const text = formatAgents(agents, { all: true });
  assert.match(text, /^Current \(current\)\n  self \| idle self/m);
  assert.match(text, /^Other\n  elsewhere \| idle/m);
  assert.ok(text.includes(`ask=${JSON.stringify(agents[1].address)}`));
  assert.doesNotMatch(text, /Current update|Previous final|cwd=/);
  assert.match(text, /last-active=2026-09-08T06:45:33.000Z/);
  assert.match(text, /dormant = stopped, not a required role/);
  assert.equal(formatStatus(agents, { all: true }), text);
  assert.match(formatAgents(agents.slice(0, 1)), /no live ask-capable peers/);
});

test('duplicate addresses expose exact ids and empty discovery offers a next step', () => {
  const agents = fixture().list();
  agents[1].address = agents[2].address;
  const text = formatAgents(agents);
  assert.match(text, /id=idle/);
  assert.match(text, /id=working/);
  assert.match(formatAgents([]), /No sessions found\.[\s\S]*Use --all/);
});

test('startup guide explains fresh discovery, dormant roles, and bounded test cleanup', () => {
  assert.match(AGENT_SESSION_GUIDE, /before choosing a peer/);
  assert.match(AGENT_SESSION_GUIDE, /clideck agents --all/);
  assert.match(AGENT_SESSION_GUIDE, /refresh after a failed contact or team change/);
  assert.match(AGENT_SESSION_GUIDE, /saved session is not a required team role/);
  assert.match(AGENT_SESSION_GUIDE, /Only stop test processes you started/);
});
