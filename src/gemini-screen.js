const { createMenuParser } = require('./menu-screen');

const USER_PROMPT_RE = /^\s*>\s(.*)$/;
const AGENT_RE = /^\s*✦\s(.*)$/u;
const menu = createMenuParser({
  selectionMarker: /●/u,
  turnMarker: /^(?:\s*✦|\s*>\s)/u,
  footerPattern: /\besc\b|\(esc\)|press enter to continue|use enter to select|^\s*[╰└].*[╯┘]\s*$/iu,
});
const DIALOG_CHOICE_RE = /^\s*(?:[│┃║]\s*)?([●•]?)\s*(\d+)\.\s+(.+?)(?:\s*[│┃║])?\s*$/u;

function detectDialogMenu(lines) {
  const scanStart = Math.max(0, lines.length - 40);
  const selectedIndex = lines.findLastIndex((line, index) => (
    index >= scanStart && DIALOG_CHOICE_RE.test(line) && /[●•]/u.test(line)
  ));
  if (selectedIndex < 0) return null;

  let first = selectedIndex;
  let last = selectedIndex;
  while (first > scanStart && DIALOG_CHOICE_RE.test(lines[first - 1])) first -= 1;
  while (last + 1 < lines.length && DIALOG_CHOICE_RE.test(lines[last + 1])) last += 1;
  const choices = lines.slice(first, last + 1).map((line) => {
    const match = line.match(DIALOG_CHOICE_RE);
    return {
      value: match[2],
      label: match[3].trim(),
      selected: Boolean(match[1]),
    };
  });
  if (choices.length < 2) return null;

  let contextStart = first;
  for (let index = first - 1; index >= scanStart; index -= 1) {
    contextStart = index;
    if (/^\s*[╭┌].*[╮┐]\s*$/u.test(lines[index])) break;
  }
  const context = lines.slice(contextStart, first)
    .map((line) => line.replace(/^\s*[│┃║]\s?/u, '').replace(/[│┃║]\s*$/u, '').trim())
    .filter((line) => line && !/^\s*[╭┌].*[╮┐]\s*$/u.test(line))
    .join('\n');
  return { choices, context };
}

function detectMenuDetails(lines) {
  const standard = menu.detectMenuDetails(lines);
  return standard.choices.length ? standard : detectDialogMenu(lines) || standard;
}

function latestAgentText(lines, userPrompts = []) {
  const known = userPrompts.length ? new Set(userPrompts) : null;
  let current = null;
  let latest = '';
  for (const line of lines) {
    const user = line.match(USER_PROMPT_RE);
    const agent = line.match(AGENT_RE);
    if (user && (!known || known.has(user[1].trim()))) {
      current = null;
      continue;
    }
    if (agent) {
      if (current) latest = current.trim();
      current = agent[1];
      continue;
    }
    if (current !== null) current += `\n${line}`;
  }
  if (current) latest = current.trim();
  return latest.replace(/\n\s*Type your message[\s\S]*$/i, '').trim();
}

function hasInputPrompt(lines) {
  return lines.slice(-10).some((line) => /Type your message or @path\/to\/file/i.test(line));
}

function hasSettledPrompt(lines) {
  const tail = lines.slice(-14);
  return hasInputPrompt(tail) && !tail.some((line) => /esc to cancel/i.test(line));
}

module.exports = {
  latestAgentText,
  detectMenu: (lines) => detectMenuDetails(lines).choices,
  detectMenuDetails,
  stripMenu: menu.stripMenu,
  hasInputPrompt,
  hasSettledPrompt,
};
