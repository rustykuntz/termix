const test = require('node:test');
const assert = require('node:assert/strict');
const {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { listDirectories, makeDirectory } = require('../src/directories');
const { HeadlessServer } = require('../src/server');

test('directory listing filters hidden folders and resolves symlink paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'clideck-next-directories-'));
  const actual = join(root, 'actual');
  const link = join(root, 'linked');
  mkdirSync(actual);
  mkdirSync(join(actual, 'visible'));
  mkdirSync(join(actual, '.hidden'));
  writeFileSync(join(actual, 'file.txt'), 'not a directory');
  symlinkSync(actual, link, 'dir');
  try {
    const resolvedActual = realpathSync(actual);
    assert.deepEqual(await listDirectories(link, false), {
      resolvedPath: resolvedActual,
      entries: [{ name: 'visible', hidden: false }],
    });
    assert.deepEqual(await listDirectories(link, true), {
      resolvedPath: resolvedActual,
      entries: [
        { name: '.hidden', hidden: true },
        { name: 'visible', hidden: false },
      ],
    });
    assert.deepEqual(await makeDirectory(link, 'created'), {
      path: join(resolvedActual, 'created'),
      resolvedParent: resolvedActual,
      name: 'created',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('directory controls return stale-path errors and reject unsafe folder names', async () => {
  const root = mkdtempSync(join(tmpdir(), 'clideck-next-directory-errors-'));
  const dataDir = join(root, 'data');
  const parent = join(root, 'parent');
  mkdirSync(parent);
  const server = new HeadlessServer({ port: 0, dataDir });
  const messages = [];
  const socket = {
    send(raw) {
      messages.push(JSON.parse(raw));
    },
  };
  try {
    await server.listen();
    const missing = join(root, 'stale-path');
    await server.listDirectory({ path: missing, showHidden: false }, socket);
    assert.equal(messages.at(-1).type, 'dirs.list.result');
    assert.equal(messages.at(-1).path, missing);
    assert.equal(messages.at(-1).success, false);
    assert.deepEqual(messages.at(-1).entries, []);
    assert.equal(messages.at(-1).code, 'ENOENT');

    for (const name of ['a/b', '..', '']) {
      await server.createDirectory({ parent, name }, socket);
      assert.deepEqual(messages.at(-1), {
        type: 'dirs.mkdir.result',
        parent,
        name,
        success: false,
        code: 'invalid_name',
        error: 'Invalid folder name.',
      });
    }
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
