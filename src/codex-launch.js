const { join } = require('path');
const {
  AGENT_SESSION_GUIDE,
  hasCodexDeveloperInstructions,
} = require('./agent-session-guide');

function hookGroup(command, timeout = 5) {
  return `[{ hooks = [{ type = "command", command = ${JSON.stringify(command)}, timeout = ${timeout} }] }]`;
}

function createCodexLaunch({
  command = 'codex',
  codexHome,
  port,
  bypassHookTrust = false,
  resumeHandle,
  agentGuide,
  extraArgs = [],
  hookToken = '',
}) {
  const node = process.execPath.replace(/\\/g, '/');
  const script = join(__dirname, 'codex-hook.js').replace(/\\/g, '/');
  // Codex trusts the exact hook definition. Keep launch-specific values in the
  // child environment so restarting a session does not change all four hashes.
  const hookCommand = (route) => `"${node}" "${script}" ${route}`;
  const args = [
    '--enable',
    'hooks',
    '-c',
    `hooks.UserPromptSubmit=${hookGroup(hookCommand('start'))}`,
    '-c',
    `hooks.Stop=${hookGroup(hookCommand('stop'))}`,
    '-c',
    `hooks.SessionStart=${hookGroup(hookCommand('session-start'))}`,
    '-c',
    `hooks.Interrupt=${hookGroup(hookCommand('idle'), 3)}`,
  ];
  if (!hasCodexDeveloperInstructions(command, extraArgs)) {
    args.push('-c', `developer_instructions=${JSON.stringify(agentGuide || AGENT_SESSION_GUIDE)}`);
  }
  if (resumeHandle) args.push('resume', resumeHandle);
  if (bypassHookTrust) args.unshift('--dangerously-bypass-hook-trust');
  return {
    command,
    args,
    env: {
      ...(codexHome && { CODEX_HOME: codexHome }),
      CLIDECK_PORT: String(port),
      CLIDECK_HOOK_TOKEN: hookToken,
    },
  };
}

module.exports = { createCodexLaunch };
