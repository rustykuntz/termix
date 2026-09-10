const { homedir } = require('os');
const { delimiter, join } = require('path');

const ANSI_ESCAPE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;

function augmentedPath(current = process.env.PATH || '', home = homedir()) {
  const paths = current.split(delimiter).filter(Boolean);
  for (const path of [join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']) {
    if (!paths.includes(path)) paths.push(path);
  }
  return paths.join(delimiter);
}

function parseCommand(value) {
  const parts = [];
  let current = '';
  let quote = '';
  for (const character of String(value || '').trim()) {
    if (quote) {
      if (character === quote) quote = '';
      else current += character;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (/\s/.test(character)) {
      if (current) {
        parts.push(current);
        current = '';
      }
    } else {
      current += character;
    }
  }
  if (current) parts.push(current);
  return parts;
}

function captureToken(pattern, output) {
  if (!pattern) return '';
  const match = String(output || '').match(pattern)
    || String(output || '').replace(ANSI_ESCAPE, '').match(pattern);
  return String(match?.[1] || match?.[0] || '').trim();
}

function createCustomCommandProvider(commandConfig) {
  const native = commandConfig.providerId && require('./providers').getProvider(commandConfig.providerId);
  if (native) {
    return {
      ...native,
      createLaunch(options) {
        const [command, ...args] = parseCommand(commandConfig.command);
        const launch = native.createLaunch({ ...options, command, extraArgs: [...args, ...(options.extraArgs || [])] });
        return { ...launch, args: [...args, ...(launch.args || [])], env: { ...commandConfig.env, ...launch.env } };
      },
    };
  }
  const sessionIdPattern = commandConfig.sessionIdPattern
    ? new RegExp(commandConfig.sessionIdPattern, 'i')
    : null;
  return {
    id: 'custom-command',
    command: commandConfig.command,
    closeInput: 'exit\r',
    supportsAsk: false,
    statusFromActivity: true,
    activityIdleMs: 1500,
    streamsAgentTextFromScreen: false,
    canResume: commandConfig.canResume === true,
    captureResumeHandle(output) {
      return captureToken(sessionIdPattern, output);
    },
    createLaunch({ command, resumeHandle }) {
      const source = resumeHandle && commandConfig.canResume && commandConfig.resumeCommand
        ? commandConfig.resumeCommand.replaceAll('{{sessionId}}', resumeHandle)
        : command || commandConfig.command;
      const [executable, ...args] = parseCommand(source);
      if (!executable) throw new Error('Custom command is empty.');
      if (process.platform === 'win32'
        && !/\.(?:exe|com)$/i.test(executable)
        && !/^[a-z]:\\/i.test(executable)) {
        return {
          command: process.env.COMSPEC || 'cmd.exe',
          args: ['/c', executable, ...args],
          env: { ...commandConfig.env },
        };
      }
      return { command: executable, args, env: { ...commandConfig.env } };
    },
  };
}

module.exports = {
  augmentedPath,
  captureToken,
  createCustomCommandProvider,
  parseCommand,
};
