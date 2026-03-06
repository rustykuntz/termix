const { appendFile, mkdirSync, existsSync, readdirSync, readFileSync } = require('fs');
const { join, basename } = require('path');
const { DATA_DIR } = require('./paths');

const DIR = join(DATA_DIR, 'transcripts');
const ANSI_RE = /\x1b[\[\]()#;?]*[0-9;]*[a-zA-Z@`]|\x1b\].*?(?:\x07|\x1b\\)|\x1b.|\r|\x07/g;

const inputBuf = {};
const outputBuf = {};
const cache = {};
let broadcast = null;

function init(bc) {
  broadcast = bc;
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  // #1: Hydrate search cache from existing JSONL files
  for (const file of readdirSync(DIR).filter(f => f.endsWith('.jsonl'))) {
    const id = basename(file, '.jsonl');
    try {
      const lines = readFileSync(join(DIR, file), 'utf8').trim().split('\n');
      cache[id] = lines.map(l => { try { return JSON.parse(l).text; } catch { return ''; } }).join('\n');
    } catch {}
  }
}

function fpath(id) { return join(DIR, `${id}.jsonl`); }

function store(id, role, text) {
  appendFile(fpath(id), JSON.stringify({ ts: Date.now(), role, text }) + '\n', () => {});
  if (!cache[id]) cache[id] = '';
  cache[id] += '\n' + text;
  if (broadcast) broadcast({ type: 'transcript.append', id, text });
}

// #3: Proper line-editing buffer with backspace support
function trackInput(id, data) {
  if (!inputBuf[id]) inputBuf[id] = '';
  for (const ch of data) {
    if (ch === '\r' || ch === '\n') {
      const line = inputBuf[id].trim();
      if (line) store(id, 'user', line);
      inputBuf[id] = '';
    } else if (ch === '\x7f' || ch === '\x08') {
      inputBuf[id] = inputBuf[id].slice(0, -1);
    } else if (ch >= ' ' && ch <= '~') {
      inputBuf[id] += ch;
    }
    // ignore other control chars / escape sequences
  }
}

function trackOutput(id, data) {
  if (!outputBuf[id]) outputBuf[id] = { text: '', timer: null };
  const buf = outputBuf[id];
  buf.text += data;
  clearTimeout(buf.timer);
  buf.timer = setTimeout(() => flush(id), 300);
}

function flush(id) {
  const buf = outputBuf[id];
  if (!buf?.text) return;
  const clean = buf.text.replace(ANSI_RE, '').replace(/[^\x20-\x7E\n\t]/g, '');
  const lines = clean.split('\n').map(l => l.trim()).filter(l => l.length > 2);
  buf.text = '';
  if (lines.length) store(id, 'agent', lines.join('\n'));
}

function getCache() { return { ...cache }; }

// #2: Flush pending output before clearing
function clear(id) {
  flush(id);
  delete inputBuf[id];
  if (outputBuf[id]) {
    clearTimeout(outputBuf[id].timer);
    delete outputBuf[id];
  }
  delete cache[id];
}

module.exports = { init, trackInput, trackOutput, getCache, clear };
