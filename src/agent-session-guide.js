const { join } = require('path');
const { profileContext } = require('./user-profile');
const { parseCommand } = require('./custom-command');

const cliPath = join(__dirname, '../bin/clideck.js');
const nodeCli = `"${process.execPath}" "${cliPath}"`;
const MAX_GUIDE_BYTES = 6 * 1024;

function createAgentSessionGuide(pluginCommands = [], about = {}) {
  const base = `CliDeck session tools (when CLIDECK_SESSION_ID is set):
You are one session in a CliDeck project. At the start of project work and before choosing a peer, refresh the team with \`clideck agents\`: it identifies you and current-project sessions, with idle/working/dormant status and exact ask addresses. Dormant means stopped; a saved session is not a required team role. Use \`clideck agents --all\` for other projects. Lists are snapshots: refresh after a failed contact or team change; never rely on old handoff names or ask the user to revive a session before checking current peers. Session names can indicate roles; confirm unclear responsibilities with the peer. Follow the user's assigned role and coordinate file ownership before parallel edits; peers share the working files. Only stop test processes you started, using their exact child handles or verified PIDs; never broad name, pattern, or port-based cleanup.
Use existing peers when their expertise helps. If a useful role is missing, ask the user to open a session in this project and name it for that role (for example UI or Reviewer; rename with the header pencil or row menu). Once it appears in agents, use its exact printed ask address and send its project context, concrete task, scope, and expected result through ask; the user does not need to write team introduction prompts. Continue independent work while waiting. A single session can also handle a project; create a team only when the work benefits from it.
Discover peers: \`clideck agents\` or \`${nodeCli} agents\`.
Check current status (add \`--all\` for every project): \`clideck ask status\`.
Ask an idle peer: \`clideck ask "<target>" "<message>" --timeout 10m\` (use ${nodeCli} instead of clideck if needed).
If that peer is working, add \`--steer\` to inject guidance immediately; steering acknowledges without waiting for an answer.
Render image/video/text/json/markdown/html/pdf/mermaid/diff files in a preview tab: \`clideck show <path>\` or \`cat x.md | clideck show --stdin --kind markdown --name "Notes"\` (file kind by extension). Reusing a name replaces its open preview. HTML is a single file; embed its assets. Chart and testresults previews accept JSON through stdin with the corresponding kind. Use previews to show the user useful artifacts directly.
Ask the user a question in CliDeck: \`clideck prompt "<question>" --options "Choice A,Choice B" --timeout 10m\` (options are optional). Request visual feedback on a project image: \`clideck annotate <image-file> --timeout 10m\`. Both wait and print the user's answer to stdout; keep the command running until it answers.
Discover installed extensions at any time with \`clideck plugins\`.
Full command help: \`clideck --help\`; list peers/plugins as JSON with \`--json\`. If the global clideck command is missing or incompatible, use the session's exact CLI \`${nodeCli}\` for every command above. The session environment already supplies the server address and caller identity.
Keep a normal ask running for its stdout answer; busy asks are not queued. Give peers concrete tasks and enough context to act, then assess their findings for relevance before applying them.`;
  let guide = base;
  const profile = profileContext(about, MAX_GUIDE_BYTES - Buffer.byteLength(base) - 1);
  if (profile) guide += `\n${profile}`;
  for (const command of pluginCommands.slice(0, 24)) {
    const line = `Plugin ${command.pluginName}: \`clideck ${command.usage}\` — ${command.description}`
      .replace(/\s+/g, ' ');
    if (Buffer.byteLength(`${guide}\n${line}`) > MAX_GUIDE_BYTES) break;
    guide += `\n${line}`;
  }
  return guide;
}

const AGENT_SESSION_GUIDE = createAgentSessionGuide();

function hasClaudeSystemPrompt(command, extraArgs = []) {
  return [...parseCommand(command), ...extraArgs].some((arg) => (
    typeof arg === 'string' && /^--(?:append-)?system-prompt(?:=|$)/.test(arg)
  ));
}

function hasCodexDeveloperInstructions(command, extraArgs = []) {
  const args = [...parseCommand(command), ...extraArgs];
  return args.some((arg, index) => {
    if (typeof arg !== 'string') return false;
    if (arg === '-c' || arg === '--config') return /^\s*developer_instructions\s*=/.test(args[index + 1] || '');
    return /^(?:--config=|-c=?)[\s]*developer_instructions\s*=/.test(arg);
  });
}

module.exports = {
  AGENT_SESSION_GUIDE,
  createAgentSessionGuide,
  hasClaudeSystemPrompt,
  hasCodexDeveloperInstructions,
  MAX_GUIDE_BYTES,
};
