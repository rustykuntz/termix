const { chmodSync, mkdirSync } = require('fs');

function ensurePrivateDataDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

module.exports = { ensurePrivateDataDir };
