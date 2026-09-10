const { existsSync } = require('fs');

function defaultShell() {
  return process.env.SHELL || (existsSync('/bin/zsh') ? '/bin/zsh' : 'sh');
}

const shellProvider = {
  id: 'shell',
  command: defaultShell(),
  closeInput: 'exit\r',
  supportsAsk: false,
  statusFromActivity: true,
  activityIdleMs: 1500,
  streamsAgentTextFromScreen: false,
  createLaunch({ command }) {
    return { command: command || this.command, args: [] };
  },
};

module.exports = { shellProvider };
