const screen = require('./claude-screen');

const antigravityProvider = {
  id: 'antigravity',
  command: 'agy',
  supportsAsk: true,
  interruptInput: '\x1b',
  screen,
  statusFromActivity: true,
  activityIdleMs: 1500,
  finalizeOnActivityIdle: true,
  turnFromInput: true,
  createLaunch({ command }) {
    return { command: command || this.command, args: [] };
  },
};

module.exports = { antigravityProvider };
