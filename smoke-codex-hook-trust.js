// Exercise native trust persistence without the lifecycle smoke's trust bypass.
// No model turn is submitted; approval and config writes stay in a temporary home.
const assert = require('node:assert/strict');
const { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { homedir, tmpdir } = require('node:os');
const { join } = require('node:path');
const pty = require('node-pty');
const { createCodexLaunch } = require('./src/codex-launch');
const { Screen } = require('./src/screen');
const { startupModel } = require('./src/codex-screen');

const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function checkLaunch(codexHome, port, hookToken, expectReview, changeDefinition = false) {
  const launch = createCodexLaunch({ codexHome, port, hookToken });
  assert.ok(!launch.args.includes('--dangerously-bypass-hook-trust'));
  if (changeDefinition) {
    const index = launch.args.findIndex(arg => arg.startsWith('hooks.Stop='));
    launch.args[index] = launch.args[index].replace('timeout = 5', 'timeout = 4');
  }
  const screen = new Screen(150, 45);
  const child = pty.spawn(launch.command, launch.args, {
    cwd: process.cwd(), cols: 150, rows: 45,
    env: { ...process.env, ...launch.env, TERM: 'xterm-256color', CLIDECK_NEXT_SESSION_ID: 'trust-smoke' },
  });
  let exited = false;
  const exit = new Promise(resolve => child.onExit(() => { exited = true; resolve(); }));
  child.onData(data => {
    screen.write(data);
    if (data.includes('\x1b[6n')) child.write('\x1b[1;1R');
  });
  async function waitFor(predicate, label) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !exited) {
      if (predicate(screen.lines())) return;
      await pause(100);
    }
    throw new Error(`Timed out waiting for ${label}\n${screen.lines().join('\n')}`);
  }
  const needsReview = lines => lines.some(line => /Hooks need review/.test(line));
  try {
    await waitFor(lines => needsReview(lines) || startupModel(lines), 'startup');
    assert.equal(needsReview(screen.lines()), expectReview, 'native hook review expectation');
    if (expectReview) {
      const count = changeDefinition ? 1 : 4;
      assert.match(screen.lines().join('\n'), new RegExp(`${count} hooks? (?:are|is) new or changed`));
      // Explicitly approve only this smoke's known definitions in its isolated home.
      child.write('2');
      await pause(300);
      child.write('\r');
      await waitFor(lines => !needsReview(lines) && startupModel(lines), 'approved startup');
    }
    // Allow startup to finish; a delayed review must also fail the second launch.
    await pause(1500);
    assert.equal(needsReview(screen.lines()), false);
  } finally {
    if (!exited) child.kill();
    await exit;
  }
}

async function run() {
  const codexHome = mkdtempSync(join(tmpdir(), 'clideck-hook-trust-smoke-'));
  try {
    copyFileSync(join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json'), join(codexHome, 'auth.json'));
    writeFileSync(join(codexHome, 'config.toml'),
      `model = "gpt-6-astra"\n[projects.${JSON.stringify(process.cwd())}]\ntrust_level = "trusted"\n`);
    await checkLaunch(codexHome, 1, 'first-launch', true);
    const config = readFileSync(join(codexHome, 'config.toml'), 'utf8');
    assert.equal((config.match(/trusted_hash = /g) || []).length, 4);
    console.log('PASS: first launch requests review and persists four approvals');
    await checkLaunch(codexHome, 2, 'second-launch', false);
    const trustEntries = text => text.match(/\[hooks\.state\.[^\n]+\]\ntrusted_hash = [^\n]+/g)?.sort();
    assert.deepEqual(trustEntries(readFileSync(join(codexHome, 'config.toml'), 'utf8')), trustEntries(config));
    console.log('PASS: changed port/token launch reuses approval without review');
    await checkLaunch(codexHome, 3, 'third-launch', true, true);
    console.log('PASS: changing one definition still requires native review');
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
