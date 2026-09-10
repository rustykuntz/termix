const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, statSync } = require('fs');
const { tmpdir } = require('os');
const { join, resolve } = require('path');
const { pathToFileURL } = require('url');
const { ConfigStore } = require('../src/config-store');
const { PluginManager } = require('../src/plugin-manager');
const { readPluginManifest } = require('../src/plugin-manifest');

const PLUGIN_ROOT = resolve(__dirname, '../plugins');

function waitFor(values, predicate, timeout = 1000) {
  const started = Date.now();
  return new Promise((resolveWait, rejectWait) => {
    const check = () => {
      const value = values.find(predicate);
      if (value) resolveWait(value);
      else if (Date.now() - started >= timeout) rejectWait(new Error('Timed out waiting for Supertonic.'));
      else setTimeout(check, 5);
    };
    check();
  });
}

async function loadClient(name) {
  const path = join(PLUGIN_ROOT, name, 'client.js');
  const source = readFileSync(path, 'utf8').replaceAll(
    'import.meta.url',
    JSON.stringify(pathToFileURL(path).href),
  );
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

test('Supertonic is a valid lazy, namespaced plugin', () => {
  const manifest = readPluginManifest(join(PLUGIN_ROOT, 'supertonic'));
  assert.equal(manifest.id, 'supertonic');
  assert.equal(manifest.commands[0].usage, 'supertonic/speak <text>');
  assert.equal(manifest.hasServer, true);
  assert.equal(manifest.hasClient, true);
  assert.equal(manifest.hasPublic, true);
  const voices = manifest.settings.find((setting) => setting.key === 'voice');
  assert.deepEqual(voices.options, [
    { value: 'female-1', label: 'Female 1', preview: 'public/voices/female-1-preview.mp3' },
    { value: 'female-2', label: 'Female 2', preview: 'public/voices/female-2-preview.mp3' },
    { value: 'yara', label: 'Yara', preview: 'public/voices/yara-preview.mp3' },
    { value: 'mike', label: 'Mike', preview: 'public/voices/mike-preview.mp3' },
    { value: 'dov', label: 'Dov', preview: 'public/voices/dov-preview.mp3' },
  ]);
  assert.equal(voices.default, 'female-2');
  assert.equal(manifest.settings.find((setting) => setting.key === 'shortcut').type, 'shortcut');
  assert.equal(manifest.settings.find((setting) => setting.key === 'shortcut').default, 'F5');
  assert.equal(manifest.settings.find((setting) => setting.key === 'quality').default, 12);
  for (const voice of voices.options) {
    const style = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'supertonic', `public/voices/${voice.value}.json`), 'utf8'));
    assert.deepEqual(style.style_ttl.dims, [1, 50, 256]);
    assert.deepEqual(style.style_dp.dims, [1, 8, 16]);
    for (const tensor of [style.style_ttl, style.style_dp]) {
      assert.equal(tensor.type, 'float32');
      const values = tensor.data.flat(Infinity);
      assert.equal(values.length, tensor.dims.reduce((a, b) => a * b, 1));
      assert.ok(values.every(Number.isFinite));
    }
    const preview = join(PLUGIN_ROOT, 'supertonic', voice.preview);
    assert.ok(statSync(preview).size > 10_000);
    assert.equal(readFileSync(preview, { encoding: 'latin1', flag: 'r' }).slice(0, 3), 'ID3');
  }
  assert.equal(manifest.settings.some((setting) => setting.key === 'speed'), false);
  assert.match(
    readFileSync(join(PLUGIN_ROOT, 'supertonic', 'public/helper.js'), 'utf8'),
    /ort\.env\.logLevel\s*=\s*['"]error['"]/,
  );
  assert.deepEqual(
    manifest.settings.find((setting) => setting.key === 'normalization').options
      .map((option) => option.value),
    ['english', 'off'],
  );
});

test('Supertonic dispatches manual and opted-in automatic speech', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-supertonic-'));
  const events = [];
  const replies = [];
  const manager = new PluginManager({
    dataDir,
    bundledDir: PLUGIN_ROOT,
    configStore: new ConfigStore({ dataDir }),
    onClientEvent: (event) => events.push(event),
    log: () => {},
  });
  t.after(() => manager.close());
  await manager.start();
  const snapshot = manager.snapshot().find((plugin) => plugin.id === 'supertonic');
  assert.equal(snapshot.status, 'ready');
  assert.equal(snapshot.values['auto-read'], false);

  manager.emitCoreEvent({ type: 'agent.final', sessionId: 'one', text: 'not opted in' });
  await new Promise((resolveWait) => setTimeout(resolveWait, 15));
  assert.equal(events.length, 0);

  const result = await manager.runCommand('supertonic', 'speak', {
    args: ['hello', 'world'], sessionId: 'one',
  });
  assert.equal(result.stdout, 'Sent to Supertonic.\n');
  const manual = await waitFor(events, (event) => event.event === 'speak');
  assert.deepEqual(manual.data, {
    text: 'hello world', sessionId: 'one', source: 'agent',
  });
  await assert.rejects(
    () => manager.runCommand('supertonic', 'speak', { args: [] }),
    /Provide text/,
  );
  await assert.doesNotReject(
    () => manager.runCommand('supertonic', 'speak', { args: ['x'.repeat(8_001)] }),
  );

  manager.clientMessage('supertonic', 'ready', null, {
    requestId: 'settings-1',
    reply: (event) => replies.push(event),
  });
  const settings = await waitFor(replies, (event) => event.event === 'settings');
  assert.equal(settings.requestId, 'settings-1');
  assert.equal(settings.data.language, 'en');
  assert.equal(settings.data.voice, 'female-2');
  assert.equal(settings.data.shortcut, 'F5');
  assert.equal(settings.data.normalization, 'english');
  assert.equal('speed' in settings.data, false);

  await manager.updateSettings('supertonic', { 'auto-read': true, language: 'fr' });
  manager.emitCoreEvent({ type: 'agent.final', sessionId: 'two', text: 'bonjour' });
  const automatic = await waitFor(events, (event) => (
    event.event === 'speak' && event.data.source === 'auto'
  ));
  assert.deepEqual(automatic.data, {
    text: 'bonjour', sessionId: 'two', source: 'auto',
  });
});

test('Supertonic contributes selection and whole-document reader actions', async () => {
  const actions = [];
  const viewerTextReads = [];
  const messageHandlers = new Map();
  const hotkeys = [];
  const toasts = [];
  let terminalSelectionReads = 0;
  const { activate } = await loadClient('supertonic');
  const cleanup = await activate({
    onMessage: (event, handler) => { messageHandlers.set(event, handler); return () => {}; },
    registerAction: (action) => { actions.push(action); return () => {}; },
    registerHotkey: (combo, handler) => { hotkeys.push({ combo, handler }); return () => {}; },
    getTerminalSelection: async () => { terminalSelectionReads += 1; return ''; },
    getActiveViewerText: async () => {
      const id = viewerTextReads.length ? 'document-2' : 'document-1';
      viewerTextReads.push(id);
      return { id, kind: 'markdown', text: '', selection: '' };
    },
    getActiveSession: async () => null,
    send: () => {},
    toast: (kind, options) => toasts.push({ kind, options }),
    stopAudio: () => {},
  });

  const selection = actions.find((action) => action.id === 'read-selection');
  const document = actions.find((action) => action.id === 'read-document');
  assert.deepEqual(selection.placements, ['terminal.context', 'viewer.context']);
  assert.deepEqual(document.placements, ['viewer.context']);
  assert.equal(document.when({ content: { kind: 'markdown' } }), true);
  assert.equal(document.when({ content: { kind: 'text' } }), true);
  assert.equal(document.when({ content: { kind: 'html' } }), true);
  assert.equal(document.when({ content: { kind: 'pdf' } }), false);
  await document.run({ content: { id: 'document-1', kind: 'html', url: '/content/document-1' } });
  assert.deepEqual(viewerTextReads, ['document-1']);
  messageHandlers.get('settings')({ shortcut: 'F5' });
  assert.equal(hotkeys.at(-1).combo, 'F5');
  await hotkeys.at(-1).handler();
  assert.equal(terminalSelectionReads, 0);
  assert.match(toasts.at(-1).options.body, /no readable text/i);
  cleanup();
});
