const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PromptCoordinator,
  parseAnnotateRequest,
  parsePromptRequest,
} = require('../src/prompt-coordinator');

test('prompt requests preserve validated options and reject oversized fields', () => {
  assert.deepEqual(parsePromptRequest({
    sessionId: 'session',
    question: 'Choose one',
    options: ['Alpha', ' Beta '],
    timeoutMs: 1000,
  }), {
    sessionId: 'session',
    question: 'Choose one',
    options: ['Alpha', ' Beta '],
    timeoutMs: 1000,
  });
  assert.equal(parsePromptRequest({
    sessionId: 'session',
    question: 'x'.repeat(2001),
  }), null);
  assert.equal(parsePromptRequest({
    sessionId: 'session',
    question: 'Choose',
    options: Array(13).fill('x'),
  }), null);
  assert.equal(parsePromptRequest({
    sessionId: 'session',
    question: 'Choose',
    options: ['x'.repeat(201)],
  }), null);
  assert.deepEqual(parseAnnotateRequest({
    sessionId: 'session',
    path: '/tmp/image.png',
  }), {
    sessionId: 'session',
    path: '/tmp/image.png',
    timeoutMs: 600_000,
  });
});

test('prompt coordinator resolves answers, timeouts, and session cancellation once', async () => {
  const events = [];
  let nextId = 0;
  const coordinator = new PromptCoordinator(
    (event) => events.push(event),
    { createId: () => `prompt-${++nextId}` },
  );

  const answered = coordinator.prompt(
    'session-a',
    { question: 'Question', options: ['a', 'b'] },
    1000,
  );
  assert.deepEqual(events[0], {
    type: 'prompt.show',
    sessionId: 'session-a',
    promptId: 'prompt-1',
    question: 'Question',
    options: ['a', 'b'],
  });
  assert.equal(coordinator.answer('prompt-1', 'b\nexact'), true);
  assert.deepEqual(await answered, { ok: true, value: 'b\nexact' });
  assert.equal(coordinator.answer('prompt-1', 'late'), false);

  const timedOut = coordinator.prompt('session-b', { question: 'Wait', options: [] }, 5);
  assert.deepEqual(await timedOut, { ok: false, error: 'timeout' });

  const cancelled = coordinator.prompt('session-c', { question: 'Close', options: [] }, 1000);
  assert.equal(coordinator.cancelSession('session-c'), 1);
  assert.deepEqual(await cancelled, { ok: false, error: 'session_closed' });
  assert.equal(coordinator.cancelSession('session-c'), 0);

  assert.deepEqual(
    events.filter((event) => event.type === 'prompt.resolved').map((event) => event.promptId),
    ['prompt-1', 'prompt-2', 'prompt-3'],
  );
});
