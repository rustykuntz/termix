const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const {
  AskCoordinator,
  DEFAULT_ASK_TIMEOUT_MS,
  availableAskSession,
  availableSteerSession,
  listAskTargets,
  parseAskRequest,
  resolveAskTarget,
} = require('../src/ask');

function entry(id, name = '') {
  return { id, name, provider: 'claude-code' };
}

class FakeSession extends EventEmitter {
  constructor(id = 'one', name = '') {
    super();
    this.id = id;
    this.name = name;
    this.status = 'idle';
    this.turnOpen = false;
    this.closeRequested = false;
    this.closed = false;
    this.menu = [];
    this.prompts = [];
    this.steers = [];
  }

  sendPrompt(text) {
    this.prompts.push(text);
    this.turnOpen = true;
    return true;
  }

  steerPrompt(text) {
    this.steers.push(text);
    return true;
  }
}

test('ask request validation applies defaults and rejects invalid fields', () => {
  assert.deepEqual(parseAskRequest({ target: ' Reviewer ', text: ' hello ' }), {
    target: 'Reviewer',
    text: 'hello',
    timeoutMs: DEFAULT_ASK_TIMEOUT_MS,
  });
  assert.equal(parseAskRequest({ target: '', text: 'hello' }), null);
  assert.equal(parseAskRequest({ target: 'Reviewer', text: '' }), null);
  assert.equal(parseAskRequest({ target: 'Reviewer', text: 'hello', timeoutMs: 0 }), null);
  assert.deepEqual(parseAskRequest({ target: 'Reviewer', text: 'hello', steer: true }), {
    target: 'Reviewer', text: 'hello', timeoutMs: DEFAULT_ASK_TIMEOUT_MS, steer: true,
  });
  assert.equal(parseAskRequest({ target: 'Reviewer', text: 'hello', steer: 'yes' }), null);
  assert.deepEqual(parseAskRequest({
    target: 'Reviewer',
    text: 'hello',
    callerSessionId: ' caller-id ',
    timeoutMs: 60 * 60 * 1000,
  }), {
    target: 'Reviewer',
    text: 'hello',
    callerSessionId: 'caller-id',
    timeoutMs: 60 * 60 * 1000,
  });
  assert.equal(parseAskRequest({
    target: 'Reviewer',
    text: 'hello',
    callerSessionId: {},
  }), null);
});

test('ask target resolution prefers exact ids and detects ambiguous names', () => {
  const entries = [entry('Reviewer', 'other'), entry('two', 'Reviewer'), entry('three', 'Reviewer')];
  assert.equal(resolveAskTarget(entries, 'Reviewer').entry.id, 'Reviewer');
  assert.equal(resolveAskTarget(entries, 'other').entry.id, 'Reviewer');
  assert.deepEqual(resolveAskTarget(entries, 'Reviewer name'), { error: 'unknown_target' });
  assert.deepEqual(resolveAskTarget(entries.slice(1), 'Reviewer'), {
    error: 'ambiguous_target',
    candidateIds: ['two', 'three'],
  });
});

test('ask target resolution accepts only unique id prefixes of at least six characters', () => {
  const entries = [
    entry('abcdef-one', 'First'),
    entry('abcdef-two', 'Second'),
    entry('unique-third', 'Third'),
  ];
  assert.equal(resolveAskTarget(entries, 'unique').entry.id, 'unique-third');
  assert.deepEqual(resolveAskTarget(entries, 'abcdef'), {
    error: 'ambiguous_target',
    candidateIds: ['abcdef-one', 'abcdef-two'],
  });
  assert.deepEqual(resolveAskTarget(entries, 'uniqu'), { error: 'unknown_target' });
});

test('ask target listings include identity, provider, and live state', () => {
  const entries = [
    { id: 'one', name: 'Reviewer', provider: 'claude-code', cwd: '/work/clideck' },
    { id: 'two', name: '', provider: 'codex' },
  ];
  const sessions = new Map([
    ['one', { closed: false }],
    ['two', { closed: true }],
  ]);
  assert.deepEqual(listAskTargets(entries, sessions), [
    {
      id: 'one', name: 'Reviewer', provider: 'claude-code', projectId: null,
      address: '@clideck/Reviewer', supportsAsk: true, live: true,
    },
    {
      id: 'two', name: '', provider: 'codex', projectId: null,
      address: 'two', supportsAsk: true, live: false,
    },
  ]);
});

test('ask addressing resolves projects, local names, and global unique fallbacks', () => {
  const projects = [
    { id: 'main', name: 'Main' },
    { id: 'other', name: 'Other' },
  ];
  const caller = { ...entry('caller', 'Programmer'), projectId: 'main', cwd: '/main' };
  const local = { ...entry('local', 'Reviewer'), projectId: 'main', cwd: '/main' };
  const remote = { ...entry('remote', 'Reviewer'), projectId: 'other', cwd: '/other' };
  const unique = { ...entry('unique', 'Architect'), projectId: 'other', cwd: '/other' };
  const entries = [local, remote, unique];

  assert.equal(resolveAskTarget(entries, 'reviewer', { caller, projects }).entry.id, local.id);
  assert.equal(resolveAskTarget(entries, 'Architect', { caller, projects }).entry.id, unique.id);
  assert.equal(resolveAskTarget(entries, '@other/reviewer', { caller, projects }).entry.id, remote.id);
  assert.equal(resolveAskTarget(entries, '@MAIN/Reviewer', { caller, projects }).entry.id, local.id);
});

test('ask addressing gives project-less cwd groups canonical addresses', () => {
  const entries = [
    { ...entry('programmer', 'Programmer'), cwd: '/work/clideck' },
    { ...entry('reviewer', 'Reviewer'), cwd: '/work/clideck' },
    { ...entry('other', 'Reviewer'), cwd: '/work/other' },
  ];
  const sessions = new Map(entries.map((value) => [value.id, { closed: false }]));

  assert.equal(listAskTargets(entries, sessions)[1].address, '@clideck/Reviewer');
  assert.equal(resolveAskTarget(entries, '@clideck/reviewer').entry.id, 'reviewer');
  assert.equal(resolveAskTarget(entries, '@OTHER/Reviewer').entry.id, 'other');
});

test('ask addressing reports ambiguous and unknown projects clearly', () => {
  const projects = [
    { id: 'one', name: 'Duplicate' },
    { id: 'two', name: 'duplicate' },
  ];
  assert.deepEqual(resolveAskTarget([], '@Duplicate/Reviewer', { projects }), {
    error: 'ambiguous_project',
    candidateProjectIds: ['one', 'two'],
    message: 'Multiple projects named "Duplicate". Use the project id.',
  });
  assert.deepEqual(resolveAskTarget([], '@Missing/Reviewer', { projects }), {
    error: 'unknown_project',
    message: 'No project named "Missing" was found.',
  });
  assert.equal(resolveAskTarget([], '@missing', { projects }).error, 'invalid_target');
});

test('ask availability rejects providers that do not support asks', () => {
  const target = { id: 'shell-one', name: 'Shell', provider: 'shell' };
  const sessions = new Map([['shell-one', new FakeSession('shell-one')]]);
  assert.deepEqual(availableAskSession(target, sessions, new AskCoordinator()), {
    error: 'unsupported_target',
  });
});

test('ask availability rejects dormant, busy, menu, and reserved sessions', () => {
  const target = entry('one', 'Reviewer');
  const coordinator = new AskCoordinator();
  const sessions = new Map();
  assert.deepEqual(availableAskSession(target, sessions, coordinator), { error: 'dormant' });

  const session = new FakeSession();
  sessions.set(session.id, session);
  assert.equal(availableAskSession(target, sessions, coordinator).session, session);
  session.status = 'working';
  assert.deepEqual(availableAskSession(target, sessions, coordinator), {
    error: 'busy', steerable: true,
  });
  session.status = 'idle';
  session.menu = ['Approve'];
  assert.deepEqual(availableAskSession(target, sessions, coordinator), { error: 'busy' });
  session.menu = [];
  coordinator.active.set(session.id, true);
  assert.deepEqual(availableAskSession(target, sessions, coordinator), {
    error: 'busy', steerable: true,
  });
});

test('steering requires active work and refuses approval menus', () => {
  const target = entry('one', 'Reviewer');
  const coordinator = new AskCoordinator();
  const session = new FakeSession();
  const sessions = new Map([[session.id, session]]);

  assert.deepEqual(availableSteerSession(target, sessions, coordinator), { error: 'not_working' });
  session.status = 'working';
  assert.equal(availableSteerSession(target, sessions, coordinator).session, session);
  session.menu = ['Approve'];
  assert.deepEqual(availableSteerSession(target, sessions, coordinator), { error: 'busy' });
});

test('ask dispatches exactly once at injection and returns the target final', async () => {
  const session = new FakeSession('target-id', 'Reviewer');
  const dispatches = [];
  const coordinator = new AskCoordinator((event) => dispatches.push(event));
  const resultPromise = coordinator.ask(session, 'question', 1000, {
    fromId: 'caller-id',
    fromName: 'Programmer',
  });
  assert.equal(coordinator.isActive(session.id), true);
  assert.deepEqual(session.prompts, ['question']);
  assert.deepEqual(dispatches, [{
    type: 'session.dispatch',
    fromId: 'caller-id',
    fromName: 'Programmer',
    toId: 'target-id',
    toName: 'Reviewer',
  }]);
  session.emit('event', { type: 'agent.final', text: 'answer' });
  assert.deepEqual(await resultPromise, { ok: true, answer: 'answer' });
  assert.equal(coordinator.isActive(session.id), false);
  assert.equal(dispatches.length, 1);
});

test('busy and unknown asks do not dispatch', async () => {
  const dispatches = [];
  const coordinator = new AskCoordinator((event) => dispatches.push(event));
  const session = new FakeSession();
  coordinator.active.set(session.id, true);
  assert.deepEqual(await coordinator.ask(session, 'question', 1000), {
    ok: false,
    error: 'busy',
  });
  assert.deepEqual(resolveAskTarget([entry('known')], 'missing'), { error: 'unknown_target' });
  assert.deepEqual(dispatches, []);
});

test('steering injects once, acknowledges immediately, and dispatches once', () => {
  const session = new FakeSession('target-id', 'Reviewer');
  const dispatches = [];
  const coordinator = new AskCoordinator((event) => dispatches.push(event));

  assert.deepEqual(coordinator.steer(session, 'new constraint', {
    fromId: 'caller-id', fromName: 'Manager',
  }), { ok: true, steered: true });
  assert.deepEqual(session.steers, ['new constraint']);
  assert.deepEqual(dispatches, [{
    type: 'session.dispatch',
    fromId: 'caller-id',
    fromName: 'Manager',
    toId: 'target-id',
    toName: 'Reviewer',
  }]);
});

test('timed out asks remain reserved until the target turn finishes', async () => {
  const session = new FakeSession();
  const coordinator = new AskCoordinator();
  assert.deepEqual(await coordinator.ask(session, 'slow question', 5), {
    ok: false,
    error: 'timeout',
  });
  assert.equal(coordinator.isActive(session.id), true);
  assert.deepEqual(await coordinator.ask(session, 'too soon', 5), { ok: false, error: 'busy' });
  session.emit('event', { type: 'agent.final', text: 'late answer' });
  assert.equal(coordinator.isActive(session.id), false);
});
