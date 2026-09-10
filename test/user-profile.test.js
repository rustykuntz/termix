const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');
const { ConfigStore, isValidConfigPatch } = require('../src/config-store');
const { profileContext, MAX_PROFILE_BYTES } = require('../src/user-profile');
const { createAgentSessionGuide, AGENT_SESSION_GUIDE, MAX_GUIDE_BYTES,
  hasClaudeSystemPrompt, hasCodexDeveloperInstructions } = require('../src/agent-session-guide');
const { HeadlessServer } = require('../src/server');
const { getProvider } = require('../src/providers');
const { createCodexLaunch } = require('../src/codex-launch');

function temp(t) {
  const root = mkdtempSync(join(tmpdir(), 'clideck-profile-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('profile fields validate optional names, IANA zones and bounded plain notes', () => {
  assert.equal(isValidConfigPatch({ about: { name: 'Or', timeZone: 'Asia/Bangkok', notes: 'Short answers, please.\nEnglish.' } }), true);
  assert.equal(isValidConfigPatch({ about: { timeZone: 'UTC' } }), true);
  assert.equal(isValidConfigPatch({ about: { name: '', timeZone: '', notes: '' } }), true);
  for (const about of [null, [], { name: 5 }, { extra: 'not shared' },
    { name: 'x'.repeat(81) }, { notes: 'x'.repeat(501) }, { timeZone: 'not/a-zone' },
    { timeZone: '+07:00' }, { name: 'two\nlines' }, { notes: 'bad\0data' }]) {
    assert.equal(isValidConfigPatch({ about }), false, JSON.stringify(about));
  }
});

test('profile edits merge fields, normalize blanks and persist without changing other settings', (t) => {
  const dataDir = temp(t), store = new ConfigStore({ dataDir });
  store.update({ about: { name: ' Or ', timeZone: 'Asia/Bangkok', notes: ' Keep it short. ' }, defaultCwd: '/project' });
  store.update({ about: { name: 'Another name', notes: '  ' } });
  assert.deepEqual(new ConfigStore({ dataDir }).get().about, { name: 'Another name', timeZone: 'Asia/Bangkok' });
  assert.equal(store.get().defaultCwd, '/project');
  store.update({ about: { name: '', timeZone: '' } });
  assert.deepEqual(store.get().about, {});
  assert.equal(createAgentSessionGuide([], store.get().about), AGENT_SESSION_GUIDE);
});

test('filled profiles precede optional plugin help while preserving the guide budget', () => {
  const about = { name: 'Or', timeZone: 'Asia/Bangkok', notes: 'Use short lists.' };
  const commands = Array.from({ length: 24 }, (_, i) => ({ pluginName: `Plugin ${i}`, usage: `plugin-${i}/help`, description: 'x'.repeat(200) }));
  const guide = createAgentSessionGuide(commands, about);
  assert.equal(guide.startsWith(AGENT_SESSION_GUIDE), true);
  assert.ok(guide.indexOf('About the user') < guide.indexOf('Plugin Plugin'));
  assert.match(guide, /"name":"Or"/);
  assert.match(guide, /"timeZone":"Asia\/Bangkok"/);
  assert.ok(Buffer.byteLength(guide) <= MAX_GUIDE_BYTES);
  const maximum = { name: '名'.repeat(80), timeZone: 'Asia/Bangkok', notes: '文'.repeat(500) };
  assert.ok(Buffer.byteLength(profileContext(maximum)) <= MAX_PROFILE_BYTES);
  assert.ok(Buffer.byteLength(createAgentSessionGuide(commands, maximum)) <= MAX_GUIDE_BYTES);
  assert.equal(profileContext({ notes: '' }), '');
  assert.doesNotMatch(profileContext({ name: 'Or' }), /timeZone|"notes"/);
  assert.equal(createAgentSessionGuide([], {}), AGENT_SESSION_GUIDE);
});

test('instruction overrides are found in real tokens, never inside a quoted prompt body', () => {
  assert.equal(hasClaudeSystemPrompt('claude --system-prompt "custom"'), true);
  assert.equal(hasClaudeSystemPrompt('claude', ['--append-system-prompt=custom']), true);
  assert.equal(hasClaudeSystemPrompt('claude', ['--system-prompt', 'custom']), true);
  assert.equal(hasClaudeSystemPrompt('claude', ['--message', 'Explain --system-prompt custom']), false);
  assert.equal(hasClaudeSystemPrompt('claude --message "Explain --system-prompt custom"'), false);
  for (const extra of [['-c', 'developer_instructions="custom"'], ['--config', 'developer_instructions = "custom"'],
    ['--config=developer_instructions="custom"'], ['-cdeveloper_instructions="custom"'], ['-c=developer_instructions="custom"']]) {
    assert.equal(hasCodexDeveloperInstructions('codex', extra), true, extra.join(' '));
    assert.equal(createCodexLaunch({ port: 4100, extraArgs: extra }).args.some((arg) => arg.startsWith('developer_instructions=')), false);
  }
  assert.equal(hasCodexDeveloperInstructions('codex', ['--message', 'Explain -c developer_instructions=custom']), false);
  assert.equal(hasCodexDeveloperInstructions('codex --message "Explain -c developer_instructions=custom"'), false);
});

test('fresh, resumed and restarted processes receive the current profile without transcript writes', async (t) => {
  const dataDir = temp(t), server = new HeadlessServer({ port: 0, dataDir });
  const launches = [];
  server.startSession = (options) => { launches.push(options); return { id: options.id || 'fresh', cols: 80, rows: 24 }; };
  try {
    await server.listen();
    server.configStore.update({ about: { name: 'Or' } });
    server.createSession({ provider: 'codex', name: 'Main', cwd: dataDir });
    const originalGuide = launches[0].providerOptions.agentGuide;
    assert.match(originalGuide, /"name":"Or"/);
    const provider = getProvider('codex');
    server.persistence.register({ id: 'resume-profile', provider, cwd: dataDir, cols: 80, rows: 24 });
    server.persistence.recordResumeMetadata('resume-profile', { handle: 'native-handle' });
    server.configStore.update({ about: { name: 'Updated name' } });
    server.resumeSession('resume-profile');
    assert.match(launches[1].providerOptions.agentGuide, /"name":"Updated name"/);
    assert.equal(launches[1].providerOptions.resumeHandle, 'native-handle');
    assert.match(originalGuide, /"name":"Or"/);
    const writes = [];
    server.sessions.set('resume-profile', {
      id: 'resume-profile', name: 'Main', provider, cwd: dataDir, cols: 80, rows: 24,
      sendPrompt: (text) => writes.push(text),
      stopForRestart: async () => server.sessions.delete('resume-profile'),
    });
    server.configStore.update({ about: { notes: 'Brief answers.' } });
    await server.restartSession({ sessionId: 'resume-profile' });
    assert.match(launches[2].providerOptions.agentGuide, /Brief answers/);
    assert.deepEqual(writes, []);
    server.persistence.flush();
    assert.doesNotMatch(readFileSync(join(dataDir, 'sessions.json'), 'utf8'), /Updated name|Brief answers/);
    assert.doesNotMatch(JSON.stringify(server.sessionSnapshot('resume-profile')), /Updated name|Brief answers/);
    const backup = await (await fetch(`${server.address().httpUrl}/api/session/backup`)).text();
    assert.match(backup, /clideck-session-backup/);
    assert.doesNotMatch(backup, /Updated name|Brief answers/);
  } finally { server.sessions.clear(); await server.close(); }
});

test('configured launch options and server defaults preserve explicit user instructions', async (t) => {
  const server = new HeadlessServer({ port: 0, dataDir: temp(t), providerOptions: {
    codex: { extraArgs: ['-c', 'developer_instructions="server custom"'] },
  } });
  try {
    await server.listen();
    server.configStore.update({ about: { name: 'Or' }, providerArgs: { 'claude-code': '--append-system-prompt "User custom"' } });
    const claude = getProvider('claude-code').createLaunch({
      command: 'claude', port: server.port, sessionId: 'custom-profile', ...server.providerLaunchOptions('claude-code'),
    });
    try { assert.equal(claude.args.includes('--append-system-prompt'), false); } finally { claude.cleanup(); }
    const codex = createCodexLaunch({ command: 'codex', port: server.port, ...server.providerLaunchOptions('codex') });
    assert.equal(codex.args.some((arg) => arg.startsWith('developer_instructions=')), false);
    const shell = getProvider('shell').createLaunch({ agentGuide: server.providerLaunchOptions('shell').agentGuide });
    assert.doesNotMatch(JSON.stringify(shell), /About the user|"name":"Or"/);
  } finally { await server.close(); }
});
