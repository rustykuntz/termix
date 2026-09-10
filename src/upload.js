const { open, realpath, stat, unlink } = require('fs/promises');
const { extname, join } = require('path');

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

class UploadError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function validUploadName(name) {
  return typeof name === 'string' && name.length > 0
    && Buffer.byteLength(name, 'utf8') <= 255
    && name !== '.' && name !== '..'
    && !name.includes('/') && !name.includes('\\') && !name.includes('\0');
}

function collisionName(name, number) {
  if (!number) return name;
  const extension = extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  return `${stem}-${number}${extension}`;
}

async function reserveFile(directory, requestedName) {
  for (let number = 0; ; number += 1) {
    const name = collisionName(requestedName, number);
    const path = join(directory, name);
    try {
      return { handle: await open(path, 'wx', 0o600), name, path };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
}

async function writeAll(handle, data) {
  let offset = 0;
  while (offset < data.length) {
    const { bytesWritten } = await handle.write(
      data,
      offset,
      data.length - offset,
      null,
    );
    if (!bytesWritten) throw new Error('upload write failed');
    offset += bytesWritten;
  }
}

async function saveUpload(stream, cwd, name, maxBytes = MAX_UPLOAD_BYTES) {
  if (!validUploadName(name)) {
    throw new UploadError('invalid_name', 'Upload name must be a basename.', 400);
  }
  let directory;
  try {
    directory = await realpath(cwd);
    if (!(await stat(directory)).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new UploadError('invalid_cwd', 'Session working directory is unavailable.', 409);
  }

  const reserved = await reserveFile(directory, name);
  let size = 0;
  try {
    for await (const chunk of stream) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += data.length;
      if (size > maxBytes) {
        throw new UploadError('too_large', 'Upload exceeds the 100MB limit.', 413);
      }
      await writeAll(reserved.handle, data);
    }
    await reserved.handle.close();
    return { path: reserved.path, name: reserved.name, size };
  } catch (error) {
    await reserved.handle.close().catch(() => {});
    await unlink(reserved.path).catch(() => {});
    throw error;
  }
}

module.exports = {
  MAX_UPLOAD_BYTES,
  UploadError,
  collisionName,
  saveUpload,
  validUploadName,
};
