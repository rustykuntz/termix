const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync } = require('fs');
const { tmpdir } = require('os');
const { dirname, join, resolve } = require('path');
const { ConfigStore } = require('../src/config-store');
const { PluginManager } = require('../src/plugin-manager');
const { readPluginManifest } = require('../src/plugin-manifest');
const { SpeechRuntime, RecognitionStream, MAX_AUDIO_BYTES } = require('../plugins/smart-dictation/speech-runtime');

const PLUGIN_DIR = resolve(__dirname, '../plugins/smart-dictation');
const tempDir = () => mkdtempSync(join(tmpdir(), 'clideck-smart-dictation-'));

async function grammar() {
  const source = readFileSync(join(PLUGIN_DIR, 'public/grammar.js'), 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

test('Dictation keeps its existing plugin identity and ships inert with F4 activation', async (t) => {
  const dataDir = tempDir();
  const manager = new PluginManager({
    dataDir,
    configStore: new ConfigStore({ dataDir }),
    log: () => {},
  });
  t.after(() => manager.close());
  await manager.start();
  const plugin = manager.snapshot().find((entry) => entry.id === 'smart-dictation');
  assert.equal(plugin.name, 'Dictation');
  assert.equal(plugin.enabled, false);
  assert.equal(plugin.status, 'disabled');
  assert.equal(plugin.values.shortcut, 'F4');
  assert.equal(plugin.values['wake-phrase'], undefined);
  assert.equal(readPluginManifest(PLUGIN_DIR).commands.length, 0);
  assert.equal(require('fs').existsSync(join(dataDir, 'plugin-data/smart-dictation/runtime')), false);
});

test('shortcut completion adds a separator without duplicating punctuation', async () => {
  const { finishedDraft } = await grammar();
  for (const punctuation of ['!', '?', '.', ',']) {
    assert.equal(finishedDraft(`finished${punctuation}`), `finished${punctuation} `);
  }
  assert.equal(finishedDraft('finished'), 'finished. ');
});


const { selectBuild, download } = require('../plugins/smart-dictation/native-assets');
const { WebSocketServer } = require('ws');
const http = require('http');
const { createHash } = require('crypto');

const tick = () => new Promise((r) => setTimeout(r, 10));
async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error('Timed out'); await tick(); }
}

test('native build selection covers Apple Silicon, Intel Mac and both Ubuntu architectures', () => {
  assert.equal(selectBuild('auto', 'darwin', 'arm64').key, 'macos-aarch64-metal');
  assert.equal(selectBuild('cpu', 'darwin', 'arm64').key, 'macos-aarch64-cpu');
  assert.equal(selectBuild('auto', 'darwin', 'x64').key, 'macos-x86_64-cpu');
  assert.equal(selectBuild('auto', 'linux', 'x64').key, 'linux-x86_64-cpu');
  assert.equal(selectBuild('auto', 'linux', 'arm64').key, 'linux-aarch64-cpu');
  assert.throws(() => selectBuild('mps', 'linux', 'x64'), /Apple Silicon/);
  assert.throws(() => selectBuild('auto', 'win32', 'x64'), /supports Mac and Ubuntu/);
});

test('verified downloads are reused and a bad replacement cannot overwrite a valid file', async (t) => {
  let requests = 0;
  const body = Buffer.from('verified asset');
  const hash = createHash('sha256').update(body).digest('hex');
  const server = http.createServer((req, res) => { requests++; res.end(body); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/model`;
  const path = join(tempDir(), 'model');
  await download(url, path, hash, { bytes: body.length });
  await download(url, path, hash, { bytes: body.length });
  assert.equal(requests, 1);
  await assert.rejects(download(url, path, '0'.repeat(64)), /verification/);
  assert.deepEqual(readFileSync(path), body);
  assert.equal(require('fs').readdirSync(dirname(path)).length, 1);
});

test('the native model warms once and a stopped startup cannot spawn a late process', async () => {
  const runtime = new SpeechRuntime({ dataDir: tempDir() });
  let starts = 0;
  runtime.startWorker = async () => { starts++; };
  await Promise.all([runtime.start(), runtime.start()]);
  assert.equal(starts, 1);
  let resolveAssets;
  const cancelled = new SpeechRuntime({ dataDir: tempDir(), ensureAssets: () => new Promise((r) => { resolveAssets = r; }) });
  const loading = cancelled.start();
  cancelled.stop();
  resolveAssets({ binary: '/must-never-run', model: '/unused' });
  await assert.rejects(loading, /abort/i);
  assert.equal(cancelled.worker, null);
});

async function realtime(t, onMessage) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => server.on('listening', r));
  const requests = [];
  let socket;
  server.on('connection', (ws, req) => {
    socket = ws;
    assert.equal(req.headers.authorization, 'Bearer secret');
    ws.on('message', (raw, binary) => {
      if (binary) { requests.push(Buffer.from(raw)); onMessage?.(ws, raw, true); return; }
      const event = JSON.parse(raw);
      requests.push(event);
      if (event.type === 'session.update') ws.send(JSON.stringify({ type: 'session.updated' }));
      else onMessage?.(ws, event, false);
    });
    ws.send(JSON.stringify({ type: 'session.created' }));
  });
  t.after(() => { for (const ws of server.clients) ws.terminate(); server.close(); });
  const texts = [], errors = [];
  const stream = new RecognitionStream(`http://127.0.0.1:${server.address().port}`, 'secret', (s) => texts.push(s), (e) => errors.push(e));
  t.after(() => stream.cancel());
  await stream.ready;
  return { stream, texts, errors, requests, emit: (event) => socket.send(JSON.stringify(event)), socket };
}

test('real streaming socket shows partials, replaces each final, and drains before finishing', async (t) => {
  let finishRequested = false;
  const x = await realtime(t, (ws, event, binary) => { if (!binary && event.type === 'input_audio_buffer.commit') finishRequested = true; });
  const pcm = Buffer.from([1, 0, 2, 0]);
  x.stream.push(pcm);
  await until(() => x.requests.some(Buffer.isBuffer));
  assert.deepEqual(x.requests.find(Buffer.isBuffer), pcm);
  x.emit({ type: 'conversation.item.input_audio_transcription.delta', delta: 'helo' });
  await until(() => x.texts.length === 1);
  assert.equal(x.texts[0], 'helo');
  x.emit({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Hello.' });
  x.emit({ type: 'conversation.item.input_audio_transcription.delta', delta: 'More' });
  await until(() => x.texts.length === 3);
  assert.equal(x.texts[2], 'Hello. More');
  let finished = false;
  const completion = x.stream.finish().then(() => { finished = true; });
  await until(() => finishRequested);
  assert.equal(finished, false);
  x.emit({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'More words.' });
  x.emit({ type: 'input_audio_buffer.committed' });
  await completion;
  assert.equal(x.texts.at(-1), 'Hello. More words.');
  assert.equal(x.stream.closed, true);
  assert.deepEqual(x.errors, []);
});

test('stream cancellation rejects a pending finish and ignores late words', async (t) => {
  const x = await realtime(t);
  const finishing = x.stream.finish();
  x.stream.cancel();
  await assert.rejects(finishing, /cancelled/);
  x.emit({ type: 'conversation.item.input_audio_transcription.delta', delta: 'late' });
  await tick();
  assert.deepEqual(x.texts, []);
});

test('socket failure preserves received text and reports failure, with bounded audio', async (t) => {
  const x = await realtime(t);
  x.stream.bytes = MAX_AUDIO_BYTES;
  assert.throws(() => x.stream.push(Buffer.alloc(2)), /five minutes/);
  x.emit({ type: 'conversation.item.input_audio_transcription.delta', delta: 'Retained' });
  await until(() => x.texts.length);
  x.socket.terminate();
  await until(() => x.errors.length);
  assert.deepEqual(x.texts, ['Retained']);
  assert.equal(x.stream.closed, true);
});

test('the backend binds streams, preserves order, and cancels pending preparation', async () => {
  const runtimePath = require.resolve('../plugins/smart-dictation/speech-runtime');
  const serverPath = require.resolve('../plugins/smart-dictation/server');
  const original = require.cache[runtimePath].exports;
  const streams = [];
  let resolveOpen, delayOpen = false;
  class FakeRuntime {
    async openStream(onText, onError) {
      const stream = { pushed: [], cancelled: false, onText, onError,
        push(audio) { this.pushed.push(audio); onText('live words'); },
        async finish() { onText('Final words.'); }, cancel() { this.cancelled = true; } };
      streams.push(stream);
      if (delayOpen) await new Promise((r) => { resolveOpen = r; });
      return stream;
    }
    stop() {}
  }
  require.cache[runtimePath].exports = { SpeechRuntime: FakeRuntime };
  delete require.cache[serverPath];
  const handlers = new Map(), events = [];
  const api = {
    dataDir: tempDir(), getSetting: () => 'auto',
    onClientMessage: (name, handler) => handlers.set(name, handler),
    onSettingsChange() {}, onShutdown() {},
    getSession: async (id) => (id === 'S' ? { live: true } : null),
    sendToClients: (event, data) => events.push({ event, data }),
  };
  try {
    require(serverPath).activate(api);
    const envelope = { streamId: 'stream_123', sessionId: 'S' };
    await handlers.get('audio')({ ...envelope, audio: 'AAAA' });
    assert.equal(streams.length, 0);
    await handlers.get('prepare')(envelope);
    await handlers.get('audio')({ ...envelope, sessionId: 'other', audio: 'AAAA' });
    assert.equal(streams[0].pushed.length, 0);
    await handlers.get('audio')({ ...envelope, audio: 'AAAAAA==' });
    assert.equal(events.at(-1).data.text, 'live words');
    await handlers.get('finish')(envelope);
    assert.deepEqual(events.slice(-2).map((e) => e.event), ['transcript', 'finished']);
    assert.equal(events.at(-2).data.text, 'Final words.');
    assert.equal(events.at(-2).data.revision, 2);
    await handlers.get('prepare')(envelope);
    await handlers.get('audio')({ ...envelope, audio: 'A'.repeat(48004) });
    assert.equal(events.at(-1).event, 'error');
    assert.equal(streams[1].cancelled, true);
    delayOpen = true;
    const pending = handlers.get('prepare')(envelope);
    await tick();
    await handlers.get('cancel')(envelope);
    const before = events.length;
    resolveOpen(); await pending;
    assert.equal(streams[2].cancelled, true);
    assert.equal(events.length, before);
    await handlers.get('prepare')({ ...envelope, sessionId: 'missing' });
    assert.equal(streams.length, 3);
    assert.match(events.at(-1).data.body, /live terminal/);
  } finally {
    require.cache[runtimePath].exports = original;
    delete require.cache[serverPath];
  }
});
