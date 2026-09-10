const { isRegionalIndicator, wcwidth } = require('./wcwidth');

const DEFAULT_HISTORY_LINES = 2000;
const CONTINUATION = Symbol('wide-cell-continuation');

function positiveNumber(value, fallback = 1) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function rowText(row) {
  let last = row.length - 1;
  while (last >= 0 && row[last] === undefined) last -= 1;
  let output = '';
  for (let index = 0; index <= last; index += 1) {
    const cell = row[index];
    if (cell === CONTINUATION) continue;
    output += cell === undefined ? ' ' : cell;
  }
  return output;
}

function clearCell(row, index) {
  if (row[index] === CONTINUATION) {
    row[index] = undefined;
    if (index > 0) row[index - 1] = undefined;
    return;
  }
  if (row[index] !== undefined && row[index + 1] === CONTINUATION) {
    row[index + 1] = undefined;
  }
  row[index] = undefined;
}

class Screen {
  constructor(cols = 120, rows = 40, maxHistoryLines = DEFAULT_HISTORY_LINES) {
    this.cols = Math.max(20, Number(cols));
    this.rows = Math.max(5, Number(rows));
    this.maxHistoryLines = Math.max(200, Number(maxHistoryLines));
    this.x = 0;
    this.y = 0;
    this.history = [];
    this.screen = Array.from({ length: this.rows }, () => []);
    this.state = 'normal';
    this.sequence = '';
    this.oscEscape = false;
  }

  resize(cols, rows) {
    this.cols = Math.max(20, Number(cols || this.cols));
    const nextRows = Math.max(5, Number(rows || this.rows));
    while (this.screen.length > nextRows) this.history.push(this.screen.shift() || []);
    while (this.screen.length < nextRows) this.screen.push([]);
    for (const row of this.screen) {
      if (row[this.cols] === CONTINUATION) row[this.cols - 1] = undefined;
      row.length = Math.min(row.length, this.cols);
    }
    this.rows = nextRows;
    this.y = Math.min(this.y, this.rows - 1);
    this.x = Math.min(this.x, this.cols);
    this.trimHistory();
  }

  trimHistory() {
    if (this.history.length > this.maxHistoryLines) {
      this.history.splice(0, this.history.length - this.maxHistoryLines);
    }
  }

  scroll(count = 1) {
    for (let index = 0; index < count; index += 1) {
      this.history.push(this.screen.shift() || []);
      this.screen.push([]);
    }
    this.y = this.rows - 1;
    this.trimHistory();
  }

  newline() {
    if (this.y >= this.rows - 1) this.scroll();
    else this.y += 1;
  }

  wrap() {
    this.x = 0;
    this.newline();
  }

  previousCell() {
    const row = this.screen[this.y];
    for (let index = Math.min(this.x - 1, this.cols - 1); index >= 0; index -= 1) {
      if (typeof row[index] === 'string') return { row, index };
    }
    return null;
  }

  appendToPrevious(character) {
    const previous = this.previousCell();
    if (!previous) return false;
    previous.row[previous.index] += character;
    if (character === '\ufe0f'
      && previous.row[previous.index + 1] !== CONTINUATION
      && this.x === previous.index + 1) {
      if (previous.index === this.cols - 1) {
        const cluster = previous.row[previous.index];
        previous.row[previous.index] = undefined;
        this.wrap();
        this.screen[this.y][0] = cluster;
        this.screen[this.y][1] = CONTINUATION;
        this.x = 2;
      } else {
        clearCell(previous.row, previous.index + 1);
        previous.row[previous.index + 1] = CONTINUATION;
        this.x += 1;
      }
    }
    return true;
  }

  shouldJoinPrevious(character) {
    const previous = this.previousCell();
    if (!previous) return false;
    const value = previous.row[previous.index];
    if (value.endsWith('\u200d')) return true;
    return isRegionalIndicator(character)
      && Array.from(value).filter(isRegionalIndicator).length === 1;
  }

  put(character) {
    const width = wcwidth(character);
    if (width === 0 || this.shouldJoinPrevious(character)) {
      this.appendToPrevious(character);
      return;
    }
    if (this.x >= this.cols || (width === 2 && this.x === this.cols - 1)) this.wrap();
    const row = this.screen[this.y];
    clearCell(row, this.x);
    if (width === 2) clearCell(row, this.x + 1);
    row[this.x] = character;
    if (width === 2) row[this.x + 1] = CONTINUATION;
    this.x += width;
  }

  clearRange(start, end) {
    const row = this.screen[this.y];
    for (let index = Math.max(0, start); index < Math.min(this.cols, end); index += 1) {
      clearCell(row, index);
    }
  }

  eraseLine(mode) {
    if (mode === 2) this.screen[this.y] = [];
    else if (mode === 1) this.clearRange(0, this.x + 1);
    else this.clearRange(this.x, this.cols);
  }

  eraseDisplay(mode) {
    if (mode === 2 || mode === 3) {
      this.history = [];
      this.screen = Array.from({ length: this.rows }, () => []);
      this.x = 0;
      this.y = 0;
      return;
    }
    if (mode === 1) {
      for (let index = 0; index < this.y; index++) this.screen[index] = [];
      this.clearRange(0, this.x + 1);
      return;
    }
    this.eraseLine(0);
    for (let index = this.y + 1; index < this.rows; index++) this.screen[index] = [];
  }

  handleCsi(sequence) {
    const final = sequence[sequence.length - 1];
    const raw = sequence.slice(0, -1).replace(/[?=]/g, '');
    const parts = raw.split(';').filter(Boolean);
    const first = positiveNumber(parts[0]);
    const second = positiveNumber(parts[1]);

    if (final === 'A') this.y = Math.max(0, this.y - first);
    else if (final === 'B') this.y = Math.min(this.rows - 1, this.y + first);
    else if (final === 'C') this.x = Math.min(this.cols - 1, this.x + first);
    else if (final === 'D') this.x = Math.max(0, this.x - first);
    else if (final === 'G') this.x = Math.min(this.cols - 1, Math.max(0, first - 1));
    else if (final === 'H' || final === 'f') {
      this.y = Math.min(this.rows - 1, Math.max(0, first - 1));
      this.x = Math.min(this.cols - 1, Math.max(0, second - 1));
    } else if (final === 'K') this.eraseLine(Number(parts[0] || 0));
    else if (final === 'J') this.eraseDisplay(Number(parts[0] || 0));
    else if (final === 'S') this.scroll(first);
  }

  write(data) {
    for (const character of Array.from(String(data || ''))) {
      if (this.state === 'osc') {
        if (character === '\x07') {
          this.state = 'normal';
          this.oscEscape = false;
          continue;
        }
        if (this.oscEscape && character === '\\') {
          this.state = 'normal';
          this.oscEscape = false;
          continue;
        }
        this.oscEscape = character === '\x1b';
        continue;
      }

      if (this.state === 'csi') {
        this.sequence += character;
        if (character >= '@' && character <= '~') {
          this.handleCsi(this.sequence);
          this.sequence = '';
          this.state = 'normal';
        }
        continue;
      }

      if (this.state === 'escape') {
        if (character === '[') {
          this.state = 'csi';
          this.sequence = '';
          continue;
        }
        if (character === ']') {
          this.state = 'osc';
          this.oscEscape = false;
          continue;
        }
        this.state = 'normal';
        continue;
      }

      if (character === '\x1b') this.state = 'escape';
      else if (character === '\r') this.x = 0;
      else if (character === '\n') this.newline();
      else if (character === '\b' || character === '\x7f') this.x = Math.max(0, this.x - 1);
      else if (character === '\t') {
        const next = Math.min(this.cols, this.x + (8 - (this.x % 8)));
        while (this.x < next) this.put(' ');
      } else if (character >= ' ') this.put(character);
    }
  }

  lines() {
    const lines = [...this.history, ...this.screen]
      .map((row) => rowText(row).replace(/[ \t]+$/g, ''));
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    return lines.slice(-this.maxHistoryLines);
  }
}

module.exports = { Screen };
