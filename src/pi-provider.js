const screen = require('./pi-screen');
const { createPiLaunch } = require('./pi-launch');
const { structuredContextUsage } = require('./context-usage');

const piProvider = {
  id: 'pi',
  command: 'pi',
  supportsAsk: true,
  closeInput: '\x04',
  screen,
  streamsAgentTextFromScreen: false,
  finalizeOnStop: true,
  requiresSessionStart: true,
  requiresResumeTranscript: true,
  contextUsage(payload) {
    return structuredContextUsage(payload, true);
  },
  finalText(payload) {
    return String(payload.last_assistant_message || '').trim();
  },
  resumeMetadata(payload) {
    const transcriptPath = String(payload.transcript_path || '').trim();
    return {
      handle: transcriptPath || String(payload.session_id || '').trim(),
      transcriptPath,
    };
  },
  createLaunch(options) {
    return createPiLaunch({ ...options, command: options.command || this.command });
  },
};

module.exports = { piProvider };
