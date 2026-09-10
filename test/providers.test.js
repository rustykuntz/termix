const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { createCodexLaunch } = require('../src/codex-launch');
const { AGENT_SESSION_GUIDE, createAgentSessionGuide } = require('../src/agent-session-guide');
const { createGeminiSettings, removeGeminiSettings } = require('../src/gemini-settings');
const { createOpenCodeLaunch } = require('../src/opencode-launch');
const { createPiLaunch } = require('../src/pi-launch');
const { getProvider } = require('../src/providers');

test('provider registry defaults to Claude and exposes agent providers and Shell', () => {
  assert.equal(getProvider().id, 'claude-code');
  assert.equal(getProvider('codex').command, 'codex');
  assert.equal(getProvider().closeInput, '\x04\x04');
  assert.equal(getProvider().interruptInput, '\x1b');
  assert.equal(getProvider().finalizeOnStop, true);
  assert.equal(getProvider().screenFinalFallback, false);
  assert.equal(getProvider().finalText({ last_assistant_message: ' Exact answer ' }), 'Exact answer');
  assert.equal(getProvider('codex').closeInput, '/exit');
  assert.equal(getProvider('codex').finalizeOnStop, true);
  assert.equal(getProvider('codex').screenFinalFallback, false);
  assert.equal(getProvider('codex').interruptInput, '\x1b');
  assert.equal(getProvider('shell').id, 'shell');
  assert.equal(getProvider('shell').supportsAsk, false);
  assert.equal(getProvider('shell').statusFromActivity, true);
  assert.equal(getProvider('gemini').command, 'gemini');
  assert.equal(getProvider('gemini').supportsAsk, true);
  assert.equal(getProvider('opencode').command, 'opencode');
  assert.equal(getProvider('opencode').supportsAsk, true);
  assert.equal(getProvider('opencode').finalizeOnStop, true);
  assert.equal(getProvider('opencode').finalText({ last_assistant_message: ' READY ' }), 'READY');
  assert.equal(getProvider('pi').command, 'pi');
  assert.equal(getProvider('pi').supportsAsk, true);
  assert.equal(getProvider('pi').finalizeOnStop, true);
  assert.equal(getProvider('antigravity').command, 'agy');
  assert.equal(getProvider('antigravity').screen, getProvider('claude-code').screen);
  assert.equal(getProvider('antigravity').statusFromActivity, true);
  assert.equal(getProvider('antigravity').finalizeOnActivityIdle, true);
  assert.equal(getProvider('antigravity').turnFromInput, true);
  assert.equal(getProvider('antigravity').supportsAsk, true);
  assert.deepEqual(getProvider('antigravity').createLaunch({}), { command: 'agy', args: [] });
  assert.deepEqual(getProvider('pi').resumeMetadata({
    session_id: 'pi-native',
    transcript_path: '/tmp/pi-session.jsonl',
  }), {
    handle: '/tmp/pi-session.jsonl',
    transcriptPath: '/tmp/pi-session.jsonl',
  });
  assert.equal(getProvider('gemini').finalText({ prompt_response: ' READY ' }), 'READY');
  assert.deepEqual(getProvider('gemini').resumeMetadata({
    session_id: 'gemini-native',
    transcript_path: '/tmp/gemini-native.json',
  }), {
    handle: 'gemini-native',
    transcriptPath: '/tmp/gemini-native.json',
  });
  const emptySystemSettings = join(tmpdir(), `clideck-next-gemini-empty-${process.pid}.json`);
  const geminiSmoke = getProvider('gemini').createLaunch({
    port: 4100,
    sessionId: 'gemini-smoke',
    geminiSystemSettings: emptySystemSettings,
    skipTrust: true,
    resumeHandle: 'gemini-native',
  });
  try {
    assert.deepEqual(geminiSmoke.args, ['--skip-trust', '--resume', 'gemini-native']);
    assert.equal(geminiSmoke.env.GEMINI_CLI_NO_RELAUNCH, 'true');
    assert.equal(existsSync(geminiSmoke.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH), true);
    assert.equal(
      geminiSmoke.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH,
      join(tmpdir(), 'system-defaults.json'),
    );
  } finally {
    geminiSmoke.cleanup();
  }
  assert.equal(getProvider().supportsAsk, true);
  assert.equal(getProvider('codex').supportsAsk, true);
  assert.equal(getProvider('unknown'), null);
  assert.deepEqual(getProvider().resumeMetadata({
    session_id: 'wrong-id',
    transcript_path: '/tmp/claude-native.jsonl',
  }), {
    handle: 'claude-native',
    transcriptPath: '/tmp/claude-native.jsonl',
  });
  assert.deepEqual(getProvider('codex').resumeMetadata({
    session_id: 'codex-native',
    transcript_path: '/tmp/codex-rollout.jsonl',
  }), {
    handle: 'codex-native',
    transcriptPath: '/tmp/codex-rollout.jsonl',
  });
});

test('Pi launch loads an explicit temporary extension', () => {
  const launch = createPiLaunch({ port: 4100, sessionId: 'pi-one' });
  const extensionPath = launch.args[1];
  try {
    assert.deepEqual(launch.args, ['--extension', extensionPath]);
    assert.equal(existsSync(extensionPath), true);
    assert.match(readFileSync(extensionPath, 'utf8'), /agent_end/);
    assert.match(readFileSync(extensionPath, 'utf8'), /getContextUsage/);
    assert.equal(launch.env.CLIDECK_NEXT_PORT, '4100');
    assert.equal(launch.env.CLIDECK_NEXT_SESSION_ID, 'pi-one');
  } finally {
    launch.cleanup();
    assert.equal(existsSync(extensionPath), false);
  }

  const resumed = createPiLaunch({
    port: 4100,
    sessionId: 'pi-two',
    resumeHandle: '/tmp/pi-session.jsonl',
  });
  try {
    assert.deepEqual(resumed.args.slice(-2), ['--session', '/tmp/pi-session.jsonl']);
  } finally {
    resumed.cleanup();
  }

  const selected = createPiLaunch({
    port: 4100,
    sessionId: 'pi-three',
    providerName: 'openai-codex',
    model: 'gpt-5.4-mini',
  });
  try {
    assert.deepEqual(selected.args.slice(0, 4), [
      '--provider', 'openai-codex', '--model', 'gpt-5.4-mini',
    ]);
  } finally {
    selected.cleanup();
  }
});

test('OpenCode launch loads a session plugin without changing global config', () => {
  const launch = createOpenCodeLaunch({ port: 4100, sessionId: 'open-one' });
  try {
    assert.deepEqual(launch.args, []);
    assert.equal(launch.env.CLIDECK_NEXT_PORT, '4100');
    assert.equal(launch.env.CLIDECK_NEXT_SESSION_ID, 'open-one');
    assert.equal(existsSync(launch.env.OPENCODE_CONFIG), true);
    const config = JSON.parse(readFileSync(launch.env.OPENCODE_CONFIG, 'utf8'));
    assert.equal(config.plugin.length, 1);
    assert.match(config.plugin[0], /^file:/);
    assert.equal(existsSync(new URL(config.plugin[0])), true);
    const source = readFileSync(new URL(config.plugin[0]), 'utf8');
    assert.match(source, /step-finish/);
    assert.match(source, /provider\.list/);
    assert.match(source, /post\('context'/);
  } finally {
    const configPath = launch.env.OPENCODE_CONFIG;
    launch.cleanup();
    assert.equal(existsSync(configPath), false);
  }

  const resumed = createOpenCodeLaunch({
    port: 4100,
    sessionId: 'open-two',
    resumeHandle: 'ses_native',
  });
  try {
    assert.deepEqual(resumed.args, ['--session', 'ses_native']);
  } finally {
    resumed.cleanup();
  }
});

test('Gemini launch settings preserve system policy without changing the source', () => {
  const source = mkdtempSync(join(tmpdir(), 'clideck-next-gemini-source-'));
  mkdirSync(source, { recursive: true });
  const original = {
    ui: { theme: 'Default' },
    hooks: {
      BeforeAgent: [{
        matcher: '*',
        hooks: [{
          type: 'command',
          name: 'clideck-start',
          command: 'node /old/gemini-hook.js 4000 start',
        }],
      }],
    },
  };
  const sourcePath = join(source, 'settings.json');
  writeFileSync(sourcePath, JSON.stringify(original));

  const temporary = createGeminiSettings(4100, 'session-one', sourcePath);
  try {
    const settings = JSON.parse(readFileSync(temporary.path, 'utf8'));
    assert.deepEqual(settings.ui, original.ui);
    assert.equal(settings.hooksConfig.notifications, false);
    assert.equal(settings.hooksConfig.disabled.includes('clideck-start'), true);
    assert.match(settings.hooks.BeforeAgent[0].hooks[0].command, /4100 session-one start/);
    assert.equal(JSON.stringify(settings).includes('/old/gemini-hook.js'), false);
    assert.deepEqual(JSON.parse(readFileSync(sourcePath, 'utf8')), original);
  } finally {
    removeGeminiSettings(temporary);
    assert.equal(existsSync(temporary.path), false);
    rmSync(source, { recursive: true, force: true });
  }
});

test('Codex launch uses session-scoped inline hooks', () => {
  const launch = createCodexLaunch({ port: 4100 });
  const config = launch.args.join(' ');
  assert.match(config, /hooks\.UserPromptSubmit/);
  assert.match(config, /hooks\.Stop/);
  assert.match(config, /codex-hook\.js/);
  assert.match(config, /developer_instructions=/);
  assert.match(config, /clideck agents/);
  assert.equal(launch.args.includes('--dangerously-bypass-hook-trust'), false);
});

test('Claude and Codex inject the agent guide unless the user supplied one', () => {
  const pluginGuide = createAgentSessionGuide([{
    pluginId: 'browse-web', pluginName: 'Browse Web', name: 'browse',
    description: 'Browse a URL.', usage: 'browse-web/browse <url>',
  }]);
  const claude = getProvider('claude-code').createLaunch({
    command: 'claude',
    port: 4100,
    sessionId: 'guided-claude',
    agentGuide: pluginGuide,
  });
  const customClaude = getProvider('claude-code').createLaunch({
    command: 'claude --system-prompt custom',
    port: 4100,
    sessionId: 'custom-claude',
  });
  try {
    const guideIndex = claude.args.indexOf('--append-system-prompt');
    assert.equal(claude.args[guideIndex + 1], pluginGuide);
    const claudeSettings = JSON.parse(readFileSync(claude.args[1], 'utf8'));
    assert.match(claudeSettings.statusLine.command, /claude-hook\.js.*context/);
    assert.match(pluginGuide, /browse-web\/browse/);
    assert.match(pluginGuide, /<url>/);
    assert.match(AGENT_SESSION_GUIDE, /bin\/clideck\.js/);
    assert.match(AGENT_SESSION_GUIDE, /clideck ask status/);
    assert.match(AGENT_SESSION_GUIDE, /--steer/);
    assert.equal(customClaude.args.includes('--append-system-prompt'), false);
  } finally {
    claude.cleanup();
    customClaude.cleanup();
  }

  const codex = createCodexLaunch({ port: 4100, agentGuide: pluginGuide });
  const customCodex = createCodexLaunch({
    command: 'codex -c developer_instructions="custom"',
    port: 4100,
  });
  assert.equal(codex.args.some((value) => value.includes('developer_instructions=')), true);
  assert.equal(codex.args.some((value) => value.includes('browse-web/browse')), true);
  assert.equal(customCodex.args.some((value) => value.includes('developer_instructions=')), false);

  const pi = createPiLaunch({ port: 4100, sessionId: 'pi-guide', agentGuide: pluginGuide });
  try {
    assert.deepEqual(pi.args.slice(0, 2), ['--append-system-prompt', pluginGuide]);
  } finally {
    pi.cleanup();
  }

  const opencode = createOpenCodeLaunch({
    port: 4100, sessionId: 'open-guide', agentGuide: pluginGuide,
  });
  try {
    const config = JSON.parse(readFileSync(opencode.env.OPENCODE_CONFIG, 'utf8'));
    assert.equal(config.instructions.length, 1);
    assert.equal(readFileSync(config.instructions[0], 'utf8'), pluginGuide);
  } finally {
    opencode.cleanup();
  }

  const gemini = getProvider('gemini').createLaunch({
    command: 'gemini',
    port: 4100,
    sessionId: 'gemini-guide',
    geminiSystemSettings: join(tmpdir(), 'missing-gemini-settings.json'),
    agentGuide: pluginGuide,
  });
  try {
    const settings = JSON.parse(readFileSync(gemini.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, 'utf8'));
    const command = settings.hooks.SessionStart[0].hooks[0].command;
    assert.match(command, /gemini-hook\.js/);
    const guidePath = command.match(/("[^"]+"|\S+)$/)[0].replace(/^"|"$/g, '');
    assert.equal(readFileSync(guidePath, 'utf8'), pluginGuide);
  } finally {
    gemini.cleanup();
  }
});

test('Codex smoke options isolate state without changing normal launch', () => {
  const launch = createCodexLaunch({
    port: 4100,
    codexHome: '/tmp/clideck-next-smoke',
    bypassHookTrust: true,
  });
  assert.equal(launch.args[0], '--dangerously-bypass-hook-trust');
  assert.equal(launch.env.CODEX_HOME, '/tmp/clideck-next-smoke');
});
