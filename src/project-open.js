const { execFile } = require('child_process');

function openProjectPath(cwd, options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const run = options.execFile || execFile;
  if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
    return Promise.resolve({
      success: false,
      code: 'headless',
      headless: true,
      error: 'No graphical desktop is available.',
    });
  }
  const command = platform === 'darwin'
    ? 'open'
    : platform === 'win32' ? 'explorer' : 'xdg-open';
  return new Promise((resolve) => {
    run(command, [cwd], { shell: false }, (error) => {
      resolve(error
        ? { success: false, code: 'open_failed', error: error.message }
        : { success: true });
    });
  });
}

module.exports = { openProjectPath };
