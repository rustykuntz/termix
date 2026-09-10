const { createMenuParser } = require('./menu-screen');

const USER_PROMPT_RE = /^(?:[│ ]\s*)?[❯›]\s(.*)$/;
const AGENT_RE = /^(?:[│ ]\s*)?[⏺•●]\s(.*)$/;
const menu = createMenuParser({
  selectionMarker: /[❯›]/,
  turnMarker: /^(?:[│ ]\s*)?[⏺•●❯›]\s/,
});

function cleanAgentText(text) {
  let output = String(text || '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .trim();
  const prompt = Math.max(output.lastIndexOf('›'), output.lastIndexOf('❯'));
  if (prompt !== -1) output = output.slice(0, prompt).trim();
  output = output.replace(/\n\s*.*\(running stop hook\)[\s\S]*$/, '').trim();
  output = output.replace(/\n\s*\?\s*for shortcuts[\s\S]*$/, '').trim();
  output = output.replace(/\n\s*esc to interrupt[\s\S]*$/, '').trim();
  output = output.replace(/\n\n\s*[✻✢✣✤✥✦✧✳✶✽·][\s\S]*$/, '').trim();
  output = output.replace(/\n\n─{5,}[\s\S]*$/, '').trim();
  return output;
}

function parseTurns(lines, userPrompts) {
  const knownPrompts = userPrompts.length ? new Set(userPrompts) : null;
  const turns = [];
  let current = null;

  const pushCurrent = () => {
    if (!current) return;
    current.text = current.text.replace(/\n+$/, '');
    turns.push(current);
  };

  for (const line of lines) {
    const agent = line.match(AGENT_RE);
    if (agent) {
      pushCurrent();
      current = { role: 'agent', text: agent[1] };
      continue;
    }

    const user = line.match(USER_PROMPT_RE);
    if (user && (!knownPrompts || knownPrompts.has(user[1].trim()))) {
      pushCurrent();
      current = { role: 'user', text: user[1] };
      continue;
    }

    if (!current) continue;
    let continuation = line;
    if (continuation.startsWith('│ ') || continuation.startsWith('  ')) {
      continuation = continuation.slice(2);
    }
    current.text += `\n${continuation}`;
  }

  pushCurrent();
  return turns;
}

function parseLastAgent(lines) {
  let promptIndex = -1;
  for (let index = lines.length - 1; index >= 0; index--) {
    if (USER_PROMPT_RE.test(lines[index])) {
      promptIndex = index;
      break;
    }
  }

  const upperBound = promptIndex >= 0 ? promptIndex : lines.length;
  let start = -1;
  for (let index = upperBound - 1; index >= 0; index--) {
    if (AGENT_RE.test(lines[index])) {
      start = index;
      break;
    }
  }
  if (start < 0) return null;

  const first = lines[start].match(AGENT_RE);
  let text = first[1];
  for (let index = start + 1; index < upperBound; index++) {
    if (USER_PROMPT_RE.test(lines[index]) || AGENT_RE.test(lines[index])) break;
    let continuation = lines[index];
    if (continuation.startsWith('│ ') || continuation.startsWith('  ')) {
      continuation = continuation.slice(2);
    }
    text += `\n${continuation}`;
  }
  return { role: 'agent', text: text.replace(/\n+$/, '') };
}

function latestAgentText(lines, userPrompts = []) {
  const turns = parseTurns(lines, userPrompts);
  const latest = turns.length ? turns[turns.length - 1] : parseLastAgent(lines);
  if (latest?.role !== 'agent') return '';
  return cleanAgentText(latest.text);
}

function hasInputPrompt(lines) {
  return lines.slice(-8).some((line) => /^\s*[❯›](?:\s|\u00a0)*$/u.test(line));
}

function hasSettledPrompt(lines) {
  const tail = lines.slice(-12);
  return hasInputPrompt(tail)
    && !tail.some((line) => /esc to interrupt|running stop hooks/i.test(line));
}

module.exports = {
  cleanAgentText,
  latestAgentText,
  detectMenu: menu.detectMenu,
  detectMenuDetails: menu.detectMenuDetails,
  stripMenu: menu.stripMenu,
  hasInputPrompt,
  hasSettledPrompt,
};
