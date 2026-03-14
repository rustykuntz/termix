// Central hotkey dispatcher — works in terminal focus and outside it.
// Plugins register shortcuts via registerHotkey(combo, callback).

import { handleTerminalKey } from './prompts.js';

const registry = new Map(); // normalized combo → { pluginId, callback }

// Normalize a KeyboardEvent into a canonical combo string
function normalizeEvent(e) {
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(e.code);
  return parts.join('+');
}

// Normalize a user-provided combo string (e.g. "Alt+Ctrl+F4" → "Ctrl+Alt+F4")
function normalizeCombo(combo) {
  const parts = combo.split('+').map(p => p.trim());
  const mods = [];
  let key = parts[parts.length - 1];
  // Normalize key token to match e.code values
  if (/^f\d+$/i.test(key)) key = key.toUpperCase(); // f4 → F4
  else if (/^[a-z]$/i.test(key)) key = 'Key' + key.toUpperCase(); // k → KeyK
  else if (/^[0-9]$/.test(key)) key = 'Digit' + key; // 1 → Digit1
  else if (key.toLowerCase() === 'escape') key = 'Escape';
  else if (key.toLowerCase() === 'space') key = 'Space';
  else if (key.toLowerCase() === 'enter') key = 'Enter';
  else if (key.toLowerCase() === 'tab') key = 'Tab';
  for (const p of parts.slice(0, -1)) {
    const lower = p.toLowerCase();
    if (lower === 'ctrl' || lower === 'cmd' || lower === 'meta') mods.push('Ctrl');
    else if (lower === 'alt') mods.push('Alt');
    else if (lower === 'shift') mods.push('Shift');
  }
  // Dedupe and sort in canonical order
  const order = ['Ctrl', 'Alt', 'Shift'];
  const sorted = order.filter(m => mods.includes(m));
  sorted.push(key);
  return sorted.join('+');
}

function isInput(target) {
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
}

function dispatch(e) {
  const combo = normalizeEvent(e);
  const entry = registry.get(combo);
  if (!entry) return true;
  e.preventDefault();
  e.stopPropagation();
  entry.callback(e);
  return false;
}

// Catch keys outside terminals — skip text inputs
document.addEventListener('keydown', (e) => {
  if (isInput(e.target)) return;
  dispatch(e);
}, true);

export function registerHotkey(pluginId, combo, callback) {
  const norm = normalizeCombo(combo);
  if (registry.has(norm)) {
    console.warn(`[hotkeys] "${norm}" already registered by ${registry.get(norm).pluginId}, ignoring ${pluginId}`);
    return false;
  }
  registry.set(norm, { pluginId, callback });
  return true;
}

export function unregisterHotkey(pluginId, combo) {
  const norm = normalizeCombo(combo);
  const entry = registry.get(norm);
  if (entry && entry.pluginId === pluginId) registry.delete(norm);
}

export function unregisterAllForPlugin(pluginId) {
  for (const [combo, entry] of registry) {
    if (entry.pluginId === pluginId) registry.delete(combo);
  }
}

// Attach to an xterm terminal instance — xterm's hidden textarea is an input,
// so we bypass the isInput check and dispatch directly.
// Prompt autocomplete (// trigger) runs first, then hotkey dispatch.
export function attachToTerminal(term) {
  term.attachCustomKeyEventHandler((e) => {
    const promptResult = handleTerminalKey(e);
    if (promptResult === false) return false;
    if (e.type !== 'keydown') return true;
    return dispatch(e);
  });
}
