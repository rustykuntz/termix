const screen = require('./codex-screen');
const { createCodexLaunch } = require('./codex-launch');
const { watchCodexContext } = require('./context-usage');

const codexProvider = {
  id: 'codex',
  command: 'codex',
  supportsAsk: true,
  closeInput: '/exit',
  closeSubmit(lines) {
    return screen.hasInputCommand(lines, '/exit') ? '\r' : '';
  },
  finalizeOnStop: true,
  screenFinalFallback: false,
  interruptInput: '\x1b',
  screen,
  streamsAgentTextFromScreen: false,
  requiresSessionStart: false,
  watchContextUsage: watchCodexContext,
  model: (payload) => payload.model,
  finalText(payload) {
    return String(payload.last_assistant_message || '').trim();
  },
  resumeMetadata(payload) {
    return {
      handle: String(payload.session_id || '').trim(),
      transcriptPath: String(payload.transcript_path || '').trim(),
    };
  },
  createLaunch(options) {
    return createCodexLaunch({ ...options, command: options.command || this.command });
  },
};

module.exports = { codexProvider };
