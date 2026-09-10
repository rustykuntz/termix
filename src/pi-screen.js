const { createMenuParser } = require('./menu-screen');

const menu = createMenuParser({
  selectionMarker: /[›❯]/u,
  turnMarker: /^\s*[›❯•]\s/u,
});

function hasInputPrompt(lines) {
  return lines.slice(-12).some((line) => /^\s*[›❯](?:\s|\u00a0)*$/u.test(line));
}

module.exports = {
  latestAgentText: () => '',
  detectMenu: menu.detectMenu,
  detectMenuDetails: menu.detectMenuDetails,
  stripMenu: menu.stripMenu,
  hasInputPrompt,
  hasSettledPrompt: hasInputPrompt,
};
