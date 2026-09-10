const test = require('node:test');
const assert = require('node:assert/strict');
const {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} = require('fs');
const { Readable } = require('stream');
const { tmpdir } = require('os');
const { join } = require('path');
const {
  UploadError,
  collisionName,
  saveUpload,
  validUploadName,
} = require('../src/upload');

test('uploads save privately without overwrite and remove oversized partials', async (context) => {
  const cwd = mkdtempSync(join(tmpdir(), 'clideck-upload-'));
  context.after(() => rmSync(cwd, { recursive: true, force: true }));

  const first = await saveUpload(Readable.from(['first']), cwd, 'image.png');
  const second = await saveUpload(Readable.from(['second']), cwd, 'image.png');
  assert.equal(first.name, 'image.png');
  assert.equal(second.name, 'image-1.png');
  assert.equal(readFileSync(first.path, 'utf8'), 'first');
  assert.equal(readFileSync(second.path, 'utf8'), 'second');
  assert.equal(first.size, 5);

  await assert.rejects(
    saveUpload(Readable.from(['123', '456']), cwd, 'large.bin', 5),
    (error) => error instanceof UploadError && error.code === 'too_large',
  );
  assert.equal(readdirSync(cwd).includes('large.bin'), false);
});

test('upload names are basenames and collision suffixes precede extensions', () => {
  assert.equal(validUploadName('report.tar.gz'), true);
  for (const name of ['', '.', '..', '../x', 'a/b', 'a\\b', 'a\0b']) {
    assert.equal(validUploadName(name), false, name);
  }
  assert.equal(collisionName('report.tar.gz', 2), 'report.tar-2.gz');
  assert.equal(collisionName('.env', 1), '.env-1');
});
