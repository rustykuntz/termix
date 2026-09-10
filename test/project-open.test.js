const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { openProjectPath } = require('../src/project-open');
const { HeadlessServer } = require('../src/server');

function fakeSession(id, cwd) {
  return {
    id,
    provider: { id: 'shell' },
    name: 'Folder',
    cwd,
    cols: 100,
    rows: 30,
  };
}

test('project folder opener uses platform commands and detects headless Linux', async () => {
  const calls = [];
  const execFile = (command, args, options, callback) => {
    calls.push({ command, args, options });
    callback(null);
  };
  assert.deepEqual(await openProjectPath('/tmp/project', {
    platform: 'darwin',
    env: {},
    execFile,
  }), { success: true });
  assert.deepEqual(await openProjectPath('C:\\work & calc', {
    platform: 'win32',
    env: {},
    execFile,
  }), { success: true });
  assert.deepEqual(calls, [
    { command: 'open', args: ['/tmp/project'], options: { shell: false } },
    { command: 'explorer', args: ['C:\\work & calc'], options: { shell: false } },
  ]);

  let invoked = false;
  const headless = await openProjectPath('/tmp/project', {
    platform: 'linux',
    env: {},
    execFile() {
      invoked = true;
    },
  });
  assert.equal(invoked, false);
  assert.deepEqual(headless, {
    success: false,
    code: 'headless',
    headless: true,
    error: 'No graphical desktop is available.',
  });
});

test('project.open accepts only a cwd already known to session persistence', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-next-project-open-'));
  const opened = [];
  const server = new HeadlessServer({
    port: 0,
    dataDir,
    openProjectPath: async (cwd) => {
      opened.push(cwd);
      return { success: true };
    },
  });
  const messages = [];
  const socket = {
    send(raw) {
      messages.push(JSON.parse(raw));
    },
  };
  try {
    await server.listen();
    await server.openProject('/tmp/arbitrary-client-path', socket);
    assert.deepEqual(opened, []);
    assert.deepEqual(messages.at(-1), {
      type: 'project.open.result',
      cwd: '/tmp/arbitrary-client-path',
      success: false,
      code: 'unknown_cwd',
      error: 'This project folder is not known to CliDeck.',
      fallback: 'copy',
    });

    const cwd = '/tmp/known-project';
    server.persistence.register(fakeSession('known-session', cwd));
    await server.openProject(cwd, socket);
    assert.deepEqual(opened, [cwd]);
    assert.deepEqual(messages.at(-1), {
      type: 'project.open.result',
      cwd,
      success: true,
    });
  } finally {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
