const test = require('node:test');
const assert = require('node:assert/strict');
const { Screen } = require('../src/screen');
const gemini = require('../src/gemini-screen');
const opencode = require('../src/opencode-screen');
const pi = require('../src/pi-screen');
const {
  latestAgentText,
  detectMenu,
  detectMenuDetails,
  hasInputPrompt,
  hasSettledPrompt,
} = require('../src/claude-screen');
const codex = require('../src/codex-screen');
const { wcwidth } = require('../src/wcwidth');

test('screen applies carriage-return rewrites', () => {
  const screen = new Screen(80, 8);
  screen.write('Working...\r\x1b[KDone\r\n');
  assert(screen.lines().includes('Done'));
  assert(!screen.lines().includes('Working...'));
});

test('wcwidth counts terminal cells for wide and zero-width code points', () => {
  assert.equal(wcwidth('A'), 1);
  assert.equal(wcwidth('界'), 2);
  assert.equal(wcwidth('Ｗ'), 2);
  assert.equal(wcwidth('🚀'), 2);
  assert.equal(wcwidth('\u0301'), 0);
  assert.equal(wcwidth('\u200d'), 0);
});

test('screen wraps wide glyphs at cell boundaries without splitting them', () => {
  const fits = new Screen(20, 5);
  fits.write(`${'a'.repeat(18)}界Z`);
  assert.deepEqual(fits.lines(), [`${'a'.repeat(18)}界`, 'Z']);

  const wraps = new Screen(20, 5);
  wraps.write(`${'a'.repeat(19)}界Z`);
  assert.deepEqual(wraps.lines(), ['a'.repeat(19), '界Z']);

  const emojiPresentation = new Screen(20, 5);
  emojiPresentation.write(`${'a'.repeat(19)}❤️Z`);
  assert.deepEqual(emojiPresentation.lines(), ['a'.repeat(19), '❤️Z']);
});

test('screen keeps combining marks and joined emoji in one display cell cluster', () => {
  const screen = new Screen(40, 5);
  screen.write('A\u0301B 👩\u200d💻 ❤️ 🇯🇵!');
  assert.deepEqual(screen.lines(), ['ÁB 👩‍💻 ❤️ 🇯🇵!']);
  assert.equal(screen.x, 12);
});

test('screen overwrites both cells occupied by a wide glyph', () => {
  const screen = new Screen(20, 5);
  screen.write('界X\rA');
  assert.deepEqual(screen.lines(), ['A X']);
});

test('Gemini screen recognizes its prompt, answer marker, and approval menu', () => {
  assert.equal(gemini.hasInputPrompt(['  Type your message or @path/to/file']), true);
  assert.equal(gemini.latestAgentText([
    ' > Say READY',
    '✦ READY',
    '',
    '  Type your message or @path/to/file',
  ], ['Say READY']), 'READY');
  const menu = gemini.detectMenuDetails([
    '✦ I will edit the file.',
    'Apply this change?',
    '● 1. Yes, allow once',
    '  2. No (esc)',
  ]);
  assert.equal(menu.choices.length, 2);
  assert.equal(menu.choices[0].selected, true);
  assert.match(menu.context, /Apply this change/);

  const trust = gemini.detectMenuDetails([
    '╭──────────────────────────╮',
    '│ Do you trust this folder? │',
    '│ ● 1. Trust folder         │',
    '│   2. Don\'t trust          │',
    '╰──────────────────────────╯',
  ]);
  assert.equal(trust.choices.length, 2);
  assert.match(trust.context, /trust this folder/i);

  const auth = gemini.detectMenuDetails([
    '╭──────────────────────────────╮',
    '│ Get started                  │',
    '│ How would you authenticate?  │',
    '│ ● 1. Sign in with Google     │',
    '│   2. Use Gemini API Key      │',
    '│   3. Vertex AI               │',
    '│ Terms and Privacy Notice     │',
    '│ (Use Enter to select)        │',
    '╰──────────────────────────────╯',
  ]);
  assert.equal(auth.choices.length, 3);
  assert.match(auth.context, /authenticate/i);
});

test('OpenCode screen recognizes its rendered input area', () => {
  assert.equal(opencode.hasInputPrompt(['┃  Ask anything... "Fix a TODO"']), true);
  assert.equal(opencode.hasSettledPrompt(['┃  Ask anything... "Fix a TODO"']), true);
  assert.equal(opencode.latestAgentText(['anything']), '');
});

test('Pi screen recognizes its idle input row', () => {
  assert.equal(pi.hasInputPrompt(['›\u00a0']), true);
  assert.equal(pi.hasSettledPrompt(['› ']), true);
  assert.equal(pi.latestAgentText(['anything']), '');
});

test('Claude parser returns the latest full answer', () => {
  const lines = [
    '❯ Reply with exactly READY',
    '● READY',
    '',
    '  second line',
    '',
    '❯',
  ];
  assert.equal(latestAgentText(lines, ['Reply with exactly READY']), 'READY\n\nsecond line');
});

test('Claude final parsing preserves CJK and emoji like the ASCII baseline', () => {
  function renderedFinal(answer) {
    const screen = new Screen(80, 8);
    screen.write([
      '❯ Return the marker',
      `● ${answer}`,
      '',
      '❯',
    ].join('\r\n'));
    return latestAgentText(screen.lines(), ['Return the marker']);
  }
  assert.equal(renderedFinal('ASCII_READY'), 'ASCII_READY');
  assert.equal(renderedFinal('中文完成 🚀'), '中文完成 🚀');
});

test('Claude menu parser returns choices', () => {
  const lines = [
    '────────────────────',
    'Bash command',
    "printf 'MENU_OK\\n'",
    'Do you want to run this command?',
    '❯ 1. Yes',
    '  2. No',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ];
  assert.deepEqual(detectMenu(lines), [
    { value: '1', label: 'Yes', selected: true },
    { value: '2', label: 'No', selected: false },
  ]);
  assert.equal(
    detectMenuDetails(lines).context,
    "Bash command\nprintf 'MENU_OK\\n'\nDo you want to run this command?",
  );
});

test('Claude menu parsing preserves wide characters in labels', () => {
  const screen = new Screen(80, 10);
  screen.write([
    '允许修改这个文件吗？',
    '❯ 1. 是，允许修改 🚀',
    '  2. 否，取消',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ].join('\r\n'));
  assert.deepEqual(detectMenu(screen.lines()), [
    { value: '1', label: '是，允许修改 🚀', selected: true },
    { value: '2', label: '否，取消', selected: false },
  ]);
  assert.equal(detectMenuDetails(screen.lines()).context, '允许修改这个文件吗？');
});

test('Claude parser removes transient spinner chrome from updates', () => {
  const lines = [
    '❯ Reply with exactly READY',
    '⏺ READY',
    '',
    '✳ Calculating… (running stop hooks… 0/2)',
  ];
  assert.equal(latestAgentText(lines, ['Reply with exactly READY']), 'READY');
});

test('Claude prompt detection accepts its non-breaking-space cursor line', () => {
  assert.equal(hasInputPrompt(['────────────────', '❯\u00a0', '? for shortcuts']), true);
});

test('Claude settled prompt excludes active work and stop hooks', () => {
  assert.equal(hasSettledPrompt(['❯', 'esc to interrupt']), false);
  assert.equal(hasSettledPrompt(['· Finishing… (running stop hooks… 0/2)', '❯']), false);
  assert.equal(hasSettledPrompt(['❯', '? for shortcuts']), true);
});

test('Codex parser returns its latest answer', () => {
  const lines = [
    '› Reply with exactly READY',
    '• READY',
    '',
    '  second line',
    '',
    '›',
  ];
  assert.equal(codex.latestAgentText(lines, ['Reply with exactly READY']), 'READY\n\nsecond line');
});

test('Codex menu parser returns choices and context', () => {
  const lines = [
    '• Running command',
    'Allow Codex to run this command?',
    '› 1. Yes, allow',
    '  2. No, keep working (esc)',
  ];
  assert.deepEqual(codex.detectMenu(lines), [
    { value: '1', label: 'Yes, allow', selected: true },
    { value: '2', label: 'No, keep working (esc)', selected: false },
  ]);
  assert.match(codex.detectMenuDetails(lines).context, /Allow Codex/);
});

test('Codex settled prompt accepts placeholder text but rejects active work', () => {
  assert.equal(codex.hasSettledPrompt(['› Find and fix a bug in @filename', 'gpt-5.6 xhigh · ~/project']), true);
  assert.equal(codex.hasSettledPrompt(['• Working (2s • esc to interrupt)', '› Find and fix a bug']), false);
});

test('Codex parser removes its footer and transient status', () => {
  assert.equal(codex.cleanAgentText('READY\n\ngpt-5.6-sol default · ~/project'), 'READY');
  assert.equal(codex.cleanAgentText('Working (2s • esc to interrupt)\n\nplaceholder'), '');
});
