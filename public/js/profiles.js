import { state } from './state.js';

const FALLBACK = { background: '#282a36', foreground: '#f8f8f2' };

export function resolveTheme(themeId) {
  return state.themes.find(t => t.id === themeId)?.theme || FALLBACK;
}

export function resolveAccent(themeId) {
  return state.themes.find(t => t.id === themeId)?.accent || '#bd93f9';
}

export function applyTheme(term, themeId) {
  term.options.theme = resolveTheme(themeId);
}

export function themePreviewColors(themeId) {
  const preset = state.themes.find(t => t.id === themeId);
  if (!preset) return [];
  const t = preset.theme;
  return [t.background, t.foreground, t.red, t.green, t.yellow, t.blue, t.magenta, t.cyan];
}
