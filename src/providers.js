const { antigravityProvider } = require('./antigravity-provider');
const { claudeProvider } = require('./claude-provider');
const { codexProvider } = require('./codex-provider');
const { geminiProvider } = require('./gemini-provider');
const { opencodeProvider } = require('./opencode-provider');
const { piProvider } = require('./pi-provider');
const { shellProvider } = require('./shell-provider');

const providers = new Map([
  [claudeProvider.id, claudeProvider],
  [antigravityProvider.id, antigravityProvider],
  [codexProvider.id, codexProvider],
  [geminiProvider.id, geminiProvider],
  [opencodeProvider.id, opencodeProvider],
  [piProvider.id, piProvider],
  [shellProvider.id, shellProvider],
]);

function getProvider(id = 'claude-code') {
  return providers.get(id) || null;
}

function listProviders() {
  return [...providers.values()];
}

module.exports = { getProvider, listProviders };
