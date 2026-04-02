const { appendFile, writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync, unlinkSync } = require('fs');
const { join, basename } = require('path');
const { DATA_DIR } = require('./paths');
const builder = require('./transcript-builder');
const parser = require('./transcript-parser');

const DIR = join(DATA_DIR, 'transcripts');
const ANSI_RE = /\x1b[\[\]()#;?]*[0-9;]*[a-zA-Z@`~]|\x1b\].*?(?:\x07|\x1b\\)|\x1b.|\r|\x07/g;
const MAX_CACHE = 50 * 1024;
const LEGACY_SUFFIXES = ['-parsed.jsonl', '.screen'];

const inputBuf = {};
const outputBuf = {};
const cache = {};
const prefixes = {};
const entriesById = {};
const userTexts = {}; // sessionId → [text, ...] — user prompts for parser matching
const finalizePreset = {};
const lastAgentText = {};
let broadcast = null;
let notifyPlugin = null;

function init(bc, validIds, pluginNotify) {
  broadcast = bc;
  notifyPlugin = pluginNotify || null;
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  for (const file of readdirSync(DIR).filter(f => LEGACY_SUFFIXES.some(s => f.endsWith(s)))) {
    try { unlinkSync(join(DIR, file)); } catch {}
  }
  for (const file of readdirSync(DIR).filter(f => f.endsWith('.jsonl'))) {
    const id = basename(file, '.jsonl');
    if (validIds && !validIds.has(id)) { try { unlinkSync(join(DIR, file)); } catch {} continue; }
    try {
      const lines = readFileSync(join(DIR, file), 'utf8').trim().split('\n').filter(Boolean);
      entriesById[id] = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      cache[id] = entriesById[id].map(e => e.text).join('\n');
      if (cache[id].length > MAX_CACHE) cache[id] = cache[id].slice(-MAX_CACHE);
    } catch {}
  }
}

function fpath(id) { return join(DIR, `${id}.jsonl`); }
function setPrefix(id, prefix) { prefixes[id] = prefix; }
function setFinalizeOnIdle(id, presetId) {
  if (!presetId) { delete finalizePreset[id]; return; }
  finalizePreset[id] = presetId;
  entriesById[id] = builder.compactEntries(entriesById[id], presetId);
}

function rewrite(id) {
  const entries = entriesById[id] || [];
  writeFileSync(fpath(id), entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
  cache[id] = entries.map(e => e.text).join('\n');
  if (cache[id].length > MAX_CACHE) cache[id] = cache[id].slice(-MAX_CACHE);
}

function store(id, role, text) {
  const prefix = prefixes[id] || '';
  if (finalizePreset[id]) {
    if (!entriesById[id]) entriesById[id] = [];
    const entry = { ts: Date.now(), role, text, ...(prefix && { prefix }) };
    builder.addEntry(entriesById[id], entry, finalizePreset[id]);
    rewrite(id);
  } else {
    appendFile(fpath(id), JSON.stringify({ ts: Date.now(), role, text, ...(prefix && { prefix }) }) + '\n', () => {});
    if (!cache[id]) cache[id] = '';
    cache[id] += '\n' + text;
    if (cache[id].length > MAX_CACHE) cache[id] = cache[id].slice(-MAX_CACHE);
  }
  if (broadcast) broadcast({ type: 'transcript.append', id, role, text });
  if (notifyPlugin) notifyPlugin(id, role, text);
}

function trackInput(id, data) {
  if (!inputBuf[id]) inputBuf[id] = { text: '', esc: false, osc: false };
  const buf = inputBuf[id];
  for (const ch of data) {
    // OSC sequence: ESC ] ... (terminated by BEL or ESC \)
    if (buf.osc) {
      if (ch === '\x07') { buf.osc = false; continue; }                    // BEL terminator
      if (ch === '\\' && buf.escPending) { buf.osc = false; buf.escPending = false; continue; } // ESC \ terminator
      buf.escPending = (ch === '\x1b');
      continue;
    }
    if (ch === '\x1b') { buf.esc = true; continue; }
    if (buf.esc) {
      buf.esc = false;
      if (ch === ']') { buf.osc = true; continue; }                        // Start OSC
      if (ch === '[') { buf.csi = true; continue; }                        // Start CSI
      continue;                                                            // Simple ESC + char
    }
    // CSI sequence: ESC [ ... (terminated by letter or ~)
    if (buf.csi) {
      if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '~') buf.csi = false;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      const line = buf.text.trim();
      if (line) {
        delete lastAgentText[id];
        store(id, 'user', line);
        if (!userTexts[id]) userTexts[id] = [];
        userTexts[id].push(line);
      }
      buf.text = '';
    } else if (ch === '\x7f' || ch === '\x08') {
      const chars = Array.from(buf.text);
      chars.pop();
      buf.text = chars.join('');
    } else if (ch >= ' ') {
      buf.text += ch;
    }
  }
}

function recordInjectedInput(id, text) {
  delete lastAgentText[id];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    store(id, 'user', line);
    if (!userTexts[id]) userTexts[id] = [];
    userTexts[id].push(line);
  }
}

// Server-side fallback: captures raw PTY output (noisy but always available)
function trackOutput(id, data) {
  if (finalizePreset[id]) return;
  if (!outputBuf[id]) outputBuf[id] = { text: '', timer: null };
  const buf = outputBuf[id];
  buf.text += data;
  clearTimeout(buf.timer);
  buf.timer = setTimeout(() => flush(id), 300);
}

function flush(id) {
  const buf = outputBuf[id];
  if (!buf?.text) return;
  const clean = buf.text.replace(ANSI_RE, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  const lines = clean.split('\n').map(l => l.trim()).filter(l => l.length > 2);
  buf.text = '';
  if (lines.length) store(id, 'agent', lines.join('\n'));
}

function parseTurnsFromLines(id, agent, lines, opts) {
  const turns = parser.parseTurns(agent, lines, getUsers(id));
  if (!opts?.raw && turns?.length && turns[turns.length - 1].role === 'user') turns.pop();
  return turns?.length >= 2 ? turns : null;
}

function captureAgentTurn(id, agent, lines) {
  if (!finalizePreset[id]) return;
  const turns = parseTurnsFromLines(id, agent, lines);
  const last = turns?.length ? turns[turns.length - 1] : null;
  const text = last?.role === 'agent' ? builder.cleanAgentText(finalizePreset[id], last.text) : '';
  if (!text || text === lastAgentText[id]) return;
  lastAgentText[id] = text;
  store(id, 'agent', text);
}

function getUsers(id) {
  if (userTexts[id]?.length) return userTexts[id];
  return (entriesById[id] || []).filter(e => e.role === 'user').map(e => e.text);
}

function getLastTurns(id, n) {
  n = n || 4;
  const file = fpath(id);
  if (!existsSync(file)) return [];
  try {
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    const turns = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      let entry;
      try { entry = JSON.parse(lines[i]); } catch { continue; }
      if (turns.length && turns[turns.length - 1].role === entry.role) {
        turns[turns.length - 1].text = entry.text + '\n' + turns[turns.length - 1].text;
      } else {
        turns.push({ role: entry.role, text: entry.text });
        if (turns.length >= n) break;
      }
    }
    return turns.reverse();
  } catch { return []; }
}

function getCache() { return { ...cache }; }

function getReplayText(id, presetId) {
  const entries = builder.compactEntries(entriesById[id], presetId);
  if (!entries?.length) return '';
  const marks = {
    'claude-code': { user: '❯', agent: '⏺' },
    codex: { user: '›', agent: '•' },
    'gemini-cli': { user: '>', agent: '✦' },
    opencode: { user: '›', agent: '•' },
  }[presetId] || { user: '›', agent: '•' };
  return entries.map(e => `${e.role === 'user' ? marks.user : marks.agent} ${e.text}`).join('\n\n');
}

function clear(id) {
  flush(id);
  delete inputBuf[id];
  if (outputBuf[id]) {
    clearTimeout(outputBuf[id].timer);
    delete outputBuf[id];
  }
  delete cache[id];
  delete entriesById[id];
  delete prefixes[id];
  delete userTexts[id];
  delete lastAgentText[id];
  delete finalizePreset[id];
}

// Detect interactive menus from raw screen lines. Returns [{value, label, selected}] or null.
// Finds the footer line, then walks upward collecting only the contiguous menu block.
const MENU_MARKERS = { 'claude-code': /[❯›]/, codex: /[›❯]/, 'gemini-cli': /●/ };
const MENU_CHOICE_RE = /^\s*(?:[│❯›●•]\s+)*(\d+)\.\s+(.+)$/;
function detectMenu(lines, presetId) {
  const marker = MENU_MARKERS[presetId];
  if (!marker) return null;
  // Only scan the bottom 40 lines — menus are always near the visible area
  const scanStart = Math.max(0, lines.length - 40);
  let footerIdx = -1;
  for (let i = lines.length - 1; i >= scanStart; i--) {
    if (/\besc\b|\(esc\)/i.test(lines[i])) { footerIdx = MENU_CHOICE_RE.test(lines[i]) ? i + 1 : i; break; }
  }
  if (footerIdx < 0) return null;
  const choices = [];
  for (let i = footerIdx - 1; i >= scanStart; i--) {
    if (!lines[i].trim() || /^[│\s]+$/.test(lines[i])) continue;
    const m = lines[i].match(MENU_CHOICE_RE);
    if (!m) { if (/^\s{2,}\S/.test(lines[i])) continue; break; }
    if (choices.length && +m[1] >= +choices[0].value) break;
    choices.unshift({ value: m[1], label: m[2].trim(), selected: marker.test(lines[i]) });
  }
  if (!choices.some(c => c.selected)) return null;
  return choices.length ? choices : null;
}

module.exports = { init, trackInput, recordInjectedInput, trackOutput, captureAgentTurn, parseTurnsFromLines, getLastTurns, getCache, getReplayText, clear, setPrefix, setFinalizeOnIdle, detectMenu };
