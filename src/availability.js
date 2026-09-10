const { execFile } = require('child_process');
const { augmentedPath, parseCommand } = require('./custom-command');

function runFile(command, args, options, executor = execFile) {
  return new Promise((resolve, reject) => {
    executor(command, args, options, (error, stdout = '', stderr = '') => {
      if (error) reject(error);
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function checkCommandAvailability(command, options = {}) {
  const [binary] = parseCommand(command);
  if (!binary) return { available: false, error: 'Command is empty.' };
  const env = {
    ...process.env,
    ...options.env,
    PATH: augmentedPath(options.env?.PATH || process.env.PATH, options.home),
  };
  const which = options.platform === 'win32' || (!options.platform && process.platform === 'win32')
    ? 'where'
    : 'which';
  try {
    const found = await runFile(which, [binary], { env, timeout: 3000 }, options.execFile);
    const path = found.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || binary;
    let version = '';
    try {
      const result = await runFile(path, ['--version'], { env, timeout: 3000 }, options.execFile);
      version = (result.stdout || result.stderr).split(/\r?\n/)[0].trim();
    } catch {}
    return { available: true, path, version };
  } catch {
    return { available: false, error: 'Not installed.' };
  }
}

module.exports = { augmentedPath, checkCommandAvailability };
