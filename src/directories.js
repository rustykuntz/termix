const { mkdir, readdir, realpath, stat } = require('fs/promises');
const { join } = require('path');

function directoryError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function resolveDirectory(path) {
  const resolvedPath = await realpath(path);
  if (!(await stat(resolvedPath)).isDirectory()) {
    throw directoryError('Path is not a directory.', 'not_directory');
  }
  return resolvedPath;
}

async function isDirectory(parent, entry) {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return (await stat(join(parent, entry.name))).isDirectory();
  } catch {
    return false;
  }
}

async function listDirectories(path, showHidden) {
  const resolvedPath = await resolveDirectory(path);
  const values = await readdir(resolvedPath, { withFileTypes: true });
  const entries = (await Promise.all(values.map(async (entry) => {
    const hidden = entry.name.startsWith('.');
    if ((!showHidden && hidden) || !(await isDirectory(resolvedPath, entry))) return null;
    return { name: entry.name, hidden };
  }))).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  return { resolvedPath, entries };
}

function validDirectoryName(name) {
  const value = String(name || '').trim();
  return value && value !== '.' && value !== '..' && !/[\\/]/.test(value) ? value : '';
}

async function makeDirectory(parent, name) {
  const value = validDirectoryName(name);
  if (!value) throw directoryError('Invalid folder name.', 'invalid_name');
  const resolvedParent = await resolveDirectory(parent);
  const path = join(resolvedParent, value);
  await mkdir(path);
  return { path, resolvedParent, name: value };
}

module.exports = { listDirectories, makeDirectory, validDirectoryName };
