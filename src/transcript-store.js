const {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} = require('fs');
const { basename, join } = require('path');
const { ensurePrivateDataDir } = require('./private-data-dir');

const DEFAULT_CACHE_LIMIT = 50 * 1024;
const PAGE_READ_SIZE = 64 * 1024;
const SAFE_SESSION_ID = /^[a-zA-Z0-9_-]+$/;

function tailUtf8(value, limit) {
  const buffer = Buffer.from(String(value || ''));
  if (buffer.length <= limit) return buffer.toString('utf8');
  let start = buffer.length - limit;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start).toString('utf8');
}

function parseEntries(path) {
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
      try {
        const entry = JSON.parse(line);
        return (entry?.role === 'user' || entry?.role === 'agent')
          && typeof entry.text === 'string' ? [entry] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

function parsePageBuffer(buffer, offset, beginsAtLine) {
  let start = 0;
  if (!beginsAtLine) {
    const newline = buffer.indexOf(10);
    if (newline < 0) return [];
    start = newline + 1;
  }
  const records = [];
  for (let end = start; end < buffer.length; end += 1) {
    if (buffer[end] !== 10) continue;
    if (end > start) {
      try {
        const entry = JSON.parse(buffer.subarray(start, end).toString('utf8'));
        if ((entry?.role === 'user' || entry?.role === 'agent')
          && typeof entry.text === 'string') {
          records.push({ offset: offset + start, entry });
        }
      } catch {}
    }
    start = end + 1;
  }
  return records;
}

function readBackward(path, end, enough) {
  const fd = openSync(path, 'r');
  let position = end;
  let buffer = Buffer.alloc(0);
  let records = [];
  try {
    while (position > 0 && !enough(records)) {
      const length = Math.min(PAGE_READ_SIZE, position);
      position -= length;
      const chunk = Buffer.allocUnsafe(length);
      const read = readSync(fd, chunk, 0, length, position);
      buffer = Buffer.concat([chunk.subarray(0, read), buffer]);
      let beginsAtLine = position === 0;
      if (!beginsAtLine) {
        const previous = Buffer.allocUnsafe(1);
        beginsAtLine = readSync(fd, previous, 0, 1, position - 1) === 1
          && previous[0] === 10;
      }
      records = parsePageBuffer(buffer, position, beginsAtLine);
    }
  } finally {
    closeSync(fd);
  }
  return { position, records };
}

function entriesTextBytes(records) {
  return records.reduce((total, { entry }, index) => (
    total + Buffer.byteLength(entry.text) + (index ? 1 : 0)
  ), 0);
}

class TranscriptStore {
  constructor(options = {}) {
    if (!options.dataDir) throw new Error('TranscriptStore requires a dataDir.');
    this.directory = join(options.dataDir, 'transcripts');
    this.cacheLimit = Math.max(1, Number(options.cacheLimit || DEFAULT_CACHE_LIMIT));
    this.now = options.now || (() => Date.now());
    this.cache = new Map();
    ensurePrivateDataDir(options.dataDir);
    mkdirSync(this.directory, { recursive: true });
    this.load(options.validIds);
  }

  path(sessionId) {
    const id = String(sessionId || '');
    return SAFE_SESSION_ID.test(id) ? join(this.directory, `${id}.jsonl`) : null;
  }

  load(validIds) {
    const known = validIds ? new Set(validIds) : null;
    for (const file of readdirSync(this.directory).filter((name) => name.endsWith('.jsonl'))) {
      const id = basename(file, '.jsonl');
      const path = join(this.directory, file);
      if (!SAFE_SESSION_ID.test(id) || (known && !known.has(id))) {
        // A recovered registry can be older than these files. Only explicit session
        // deletion may remove them; startup must preserve recovery material.
        continue;
      }
      try {
        const size = statSync(path).size;
        const { records } = readBackward(
          path,
          size,
          (values) => entriesTextBytes(values) >= this.cacheLimit,
        );
        const text = records.map(({ entry }) => entry.text).join('\n');
        if (text) this.cache.set(id, tailUtf8(text, this.cacheLimit));
      } catch {}
    }
  }

  append(sessionId, role, text, timestamp) {
    const path = this.path(sessionId);
    const value = String(text || '').trim();
    if (!path || (role !== 'user' && role !== 'agent') || !value) return null;
    const entry = { ts: Number(timestamp) || this.now(), role, text: value };
    appendFileSync(path, `${JSON.stringify(entry)}\n`);
    const previous = this.cache.get(String(sessionId)) || '';
    this.cache.set(
      String(sessionId),
      tailUtf8(`${previous}${previous ? '\n' : ''}${value}`, this.cacheLimit),
    );
    return entry;
  }

  getCache() {
    return Object.fromEntries(this.cache);
  }

  getTurns(sessionId, count = 20) {
    const path = this.path(sessionId);
    if (!path) return [];
    const limit = Math.max(1, Math.floor(Number(count) || 20));
    const turns = [];
    for (const entry of parseEntries(path)) {
      const previous = turns.at(-1);
      if (previous?.role === entry.role) previous.text += `\n${entry.text}`;
      else turns.push({ role: entry.role, text: entry.text });
    }
    return turns.slice(-limit);
  }

  getPage(sessionId, before, count = 30) {
    const path = this.path(sessionId);
    if (!path || !existsSync(path)) return { turns: [], cursor: null, hasMore: false };
    const size = statSync(path).size;
    const end = before === undefined ? size : Math.min(size, Math.max(0, Math.floor(before)));
    const limit = Math.min(100, Math.max(1, Math.floor(Number(count) || 30)));
    if (!end) return { turns: [], cursor: null, hasMore: false };

    const { position, records } = readBackward(
      path,
      end,
      (values) => values.length >= limit,
    );

    const page = records.slice(-limit);
    const hasMore = page.length > 0 && (records.length > page.length || position > 0);
    return {
      turns: page.map(({ entry }) => entry),
      cursor: hasMore ? page[0].offset : null,
      hasMore,
    };
  }

  delete(sessionId) {
    const path = this.path(sessionId);
    if (!path) return false;
    const existed = existsSync(path);
    rmSync(path, { force: true });
    this.cache.delete(String(sessionId));
    return existed;
  }
}

module.exports = { DEFAULT_CACHE_LIMIT, TranscriptStore, tailUtf8 };
