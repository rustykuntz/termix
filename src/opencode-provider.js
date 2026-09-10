const screen = require('./opencode-screen');
const { createOpenCodeLaunch } = require('./opencode-launch');
const { structuredContextUsage } = require('./context-usage');

const opencodeProvider = {
  id: 'opencode',
  command: 'opencode',
  supportsAsk: true,
  screen,
  streamsAgentTextFromScreen: false,
  finalizeOnStop: true,
  requiresSessionStart: true,
  contextUsage(payload) {
    return structuredContextUsage(payload);
  },
  finalText(payload) {
    return String(payload.last_assistant_message || '').trim();
  },
  resumeMetadata(payload) {
    return { handle: String(payload.session_id || '').trim() };
  },
  createLaunch(options) {
    return createOpenCodeLaunch({ ...options, command: options.command || this.command });
  },
};

module.exports = { opencodeProvider };
