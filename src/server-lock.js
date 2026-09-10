const {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} = require('fs');
const { join } = require('path');
const { ensurePrivateDataDir } = require('./private-data-dir');

function isPidAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

class ServerLock {
  constructor(options = {}) {
    if (!options.dataDir) throw new Error('ServerLock requires a dataDir.');
    this.path = join(options.dataDir, 'server.lock');
    this.pid = Number(options.pid || process.pid);
    this.now = options.now || (() => new Date().toISOString());
    this.pidAlive = options.isPidAlive || isPidAlive;
    this.owned = null;
    ensurePrivateDataDir(options.dataDir);
  }

  read() {
    if (!existsSync(this.path)) return null;
    try {
      return JSON.parse(readFileSync(this.path, 'utf8'));
    } catch {
      return null;
    }
  }

  acquire({ host, port, url }) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const existing = this.read();
      if (existing && this.pidAlive(existing.pid)) return { ok: false, lock: existing };
      if (existsSync(this.path)) rmSync(this.path, { force: true });
      const lock = { pid: this.pid, host, port, url, startedAt: this.now() };
      let descriptor;
      try {
        descriptor = openSync(this.path, 'wx', 0o600);
        writeSync(descriptor, `${JSON.stringify(lock, null, 2)}\n`);
        closeSync(descriptor);
        this.owned = lock;
        return { ok: true, lock };
      } catch (error) {
        if (descriptor !== undefined) closeSync(descriptor);
        if (error.code !== 'EEXIST') throw error;
      }
    }
    const lock = this.read();
    return { ok: false, lock };
  }

  isOwned(lock = this.read()) {
    return Boolean(this.owned && lock
      && lock.pid === this.owned.pid
      && lock.startedAt === this.owned.startedAt);
  }

  update({ host, port, url }) {
    if (!this.isOwned()) return false;
    const lock = { ...this.owned, host, port, url };
    const temporary = `${this.path}.${this.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(lock, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
    this.owned = lock;
    return true;
  }

  release() {
    if (!this.isOwned()) return false;
    rmSync(this.path, { force: true });
    this.owned = null;
    return true;
  }
}

module.exports = { ServerLock, isPidAlive };
