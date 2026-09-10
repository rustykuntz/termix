const { statSync, unwatchFile, watchFile } = require('fs');

function hasNonemptyFile(path) {
  if (!path) return false;
  try {
    const stats = statSync(path);
    return stats.isFile() && stats.size > 0;
  } catch {
    return false;
  }
}

function waitForNonemptyFile(path, timeoutMs) {
  if (hasNonemptyFile(path)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (ready) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unwatchFile(path, check);
      resolve(ready);
    };
    const check = () => {
      if (hasNonemptyFile(path)) finish(true);
    };
    watchFile(path, { interval: 100, persistent: false }, check);
    timer = setTimeout(() => finish(false), timeoutMs);
    check();
  });
}

module.exports = { hasNonemptyFile, waitForNonemptyFile };
