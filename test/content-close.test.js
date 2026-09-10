const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const WebSocket = require('ws');
const { HeadlessServer } = require('../src/server');
const { ContentStore } = require('../src/content-store');

const SESSION_ID = 'content-session';

test('only preview tabs consume the preview limit and closing them releases every slot', () => {
  const content = new ContentStore({ maxPerSession: 2 });
  const annotation = content.store(SESSION_ID, { name: 'annotation.png', source: 'file', kind: 'image' }, false);
  const first = content.addPayload(SESSION_ID, 'one', 'text', 'one.txt');
  const second = content.addPayload(SESSION_ID, 'two', 'text', 'two.txt');
  assert.throws(() => content.addPayload(SESSION_ID, 'three', 'text', 'three.txt'), /2 open preview tabs/);
  const updated = content.addPayload(SESSION_ID, 'updated', 'text', 'one.txt');
  assert.equal(updated.replaces, first.contentId);
  content.remove(SESSION_ID, updated.contentId);
  content.remove(SESSION_ID, second.contentId);
  assert.deepEqual(content.metadata(SESSION_ID), {});
  assert.ok(content.get(annotation.contentId));
  content.addPayload(SESSION_ID, 'three', 'text', 'three.txt');
  content.addPayload(SESSION_ID, 'four', 'text', 'four.txt');
  content.store(SESSION_ID, { name: 'another.png', source: 'file', kind: 'image' }, false);
  assert.throws(() => content.store(SESSION_ID, { name: 'third.png' }, false), /pending image annotations/);
});

function fakeSocket(messages = []) {
  return {
    readyState: WebSocket.OPEN,
    send(raw) { messages.push(JSON.parse(raw)); },
    close() {},
  };
}

function closeControl(contentId) {
  return Buffer.from(JSON.stringify({
    type: 'content.close',
    sessionId: SESSION_ID,
    contentId,
  }));
}

test('content.close persists real removal and broadcasts existing or absent ids', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-next-content-close-'));
  const server = new HeadlessServer({ port: 0, dataDir, autoSaveMs: 0 });
  const requesterMessages = [];
  const peerMessages = [];
  const requester = fakeSocket(requesterMessages);
  const peer = fakeSocket(peerMessages);
  let present = true;
  const persisted = [];
  server.contentStore = {
    remove(sessionId, contentId) {
      if (sessionId !== SESSION_ID || contentId !== 'document' || !present) return false;
      present = false;
      return true;
    },
  };
  server.persistAssets = (sessionId) => persisted.push(sessionId);
  server.clients.add(requester);
  server.clients.add(peer);

  try {
    await server.listen();
    server.handleControl(requester, closeControl('document'));
    server.handleControl(requester, closeControl('document'));

    const expected = [
      { type: 'content.closed', sessionId: SESSION_ID, contentId: 'document' },
      { type: 'content.closed', sessionId: SESSION_ID, contentId: 'document' },
    ];
    assert.deepEqual(persisted, [SESSION_ID]);
    assert.deepEqual(requesterMessages, expected);
    assert.deepEqual(peerMessages, expected);
  } finally {
    server.clients.clear();
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('content.close suppresses a stale replay before content.show is sent', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-next-content-close-race-'));
  const server = new HeadlessServer({ port: 0, dataDir, autoSaveMs: 0 });
  const messages = [];
  const socket = fakeSocket(messages);
  let releaseReplay;
  let present = true;
  const replayReady = new Promise((resolve) => { releaseReplay = resolve; });
  server.contentStore = {
    replay: () => replayReady,
    get(contentId) {
      if (contentId === 'kept') return { sessionId: SESSION_ID };
      return present && contentId === 'closed' ? { sessionId: SESSION_ID } : null;
    },
    remove(sessionId, contentId) {
      if (sessionId !== SESSION_ID || contentId !== 'closed' || !present) return false;
      present = false;
      return true;
    },
  };
  server.persistAssets = () => {};
  server.clients.add(socket);

  try {
    await server.listen();
    const replay = server.replayContent(socket, SESSION_ID);
    server.handleControl(socket, closeControl('closed'));
    releaseReplay({
      changed: false,
      events: [
        { sessionId: SESSION_ID, contentId: 'closed', kind: 'markdown' },
        { sessionId: SESSION_ID, contentId: 'kept', kind: 'markdown' },
      ],
    });
    await replay;

    assert.deepEqual(messages, [
      { type: 'content.closed', sessionId: SESSION_ID, contentId: 'closed' },
      {
        type: 'content.show',
        sessionId: SESSION_ID,
        contentId: 'kept',
        kind: 'markdown',
        replay: true,
      },
    ]);
  } finally {
    server.clients.clear();
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
