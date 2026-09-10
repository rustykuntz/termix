const { execFileSync } = require('child_process');
const { existsSync } = require('fs');
const { resolve } = require('path');
const { version: PACKAGE_VERSION } = require('../package.json');

function resolveBuildVersion(version = PACKAGE_VERSION, run = execFileSync) {
  try {
    const output = run('git', ['log', '-1', '--format=%h%n%cs'], {
      cwd: resolve(__dirname, '..'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 200,
    });
    const [sha, date] = String(output).trim().split('\n');
    if (!/^[0-9a-f]{7,40}$/i.test(sha) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return version;
    return `${version}+${sha.slice(0, 7)} (${date})`;
  } catch {
    return version;
  }
}

// Installed packages may sit below the user's own Git checkout. Only attach a
// revision when this package root itself is a checkout (including worktrees).
const ENGINE_BUILD_VERSION = existsSync(resolve(__dirname, '../.git'))
  ? resolveBuildVersion() : PACKAGE_VERSION;

module.exports = { ENGINE_BUILD_VERSION, resolveBuildVersion };
