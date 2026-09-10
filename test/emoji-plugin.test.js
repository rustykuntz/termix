const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('fs');
const { join, resolve } = require('path');
const { readPluginManifest } = require('../src/plugin-manifest');

const PLUGIN_ROOT = resolve(__dirname, '../plugins');

async function loadClient() {
  const source = readFileSync(join(PLUGIN_ROOT, 'emoji', 'client.js'), 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

test('Emoji is a client-only plugin with an optional conflict-safe shortcut', () => {
  const manifest = readPluginManifest(join(PLUGIN_ROOT, 'emoji'));
  assert.equal(manifest.id, 'emoji');
  assert.equal(manifest.hasClient, true);
  assert.equal(manifest.hasServer, false);
  assert.equal(manifest.hasPublic, false);
  assert.deepEqual(manifest.commands, []);
  assert.equal(manifest.settings[0].key, 'shortcut');
  assert.equal(manifest.settings[0].type, 'shortcut');
  assert.equal(manifest.settings[0].default, '');
});

test('Emoji picker inserts the chosen glyph without submitting', async () => {
  const actions = [];
  const commits = [];
  const pickers = [];
  const { activate } = await loadClient();
  const cleanup = activate({
    getSettings: () => ({ values: { shortcut: '' }, configured: {} }),
    onSettingsChange: () => () => {},
    registerAction: (action) => { actions.push(action); return () => {}; },
    registerHotkey: () => () => {},
    openPicker: async (options) => { pickers.push(options); return 'thumbs-up'; },
    getActiveSession: async () => ({ id: 'session-1', live: true }),
    commitTerminalDraft: async (text, options) => { commits.push({ text, options }); return true; },
    toast: () => {},
  });

  const action = actions.find((candidate) => candidate.id === 'insert');
  assert.deepEqual(action.placements, ['terminal.header', 'terminal.context']);
  assert.equal(action.when({ session: { live: true } }), true);
  assert.equal(action.when({ session: { live: false } }), false);
  await action.run({ session: { id: 'session-1', live: true } });
  assert.equal(pickers.length, 1);
  assert.equal(pickers[0].id, 'emoji');
  assert.ok(pickers[0].items.length >= 24);
  assert.ok(pickers[0].items.every((item) => (
    typeof item.id === 'string' && typeof item.glyph === 'string' && typeof item.label === 'string'
  )));
  assert.deepEqual(commits, [{
    text: '👍',
    options: { sessionId: 'session-1', submit: false },
  }]);
  cleanup();
});
