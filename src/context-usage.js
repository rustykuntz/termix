const {
  closeSync,
  fstatSync,
  openSync,
  readSync,
  watch,
} = require('fs');

const CODEX_BASELINE_TOKENS = 12_000;
const CODEX_TAIL_BYTES = 256 * 1024;
const CODEX_WATCH_DEBOUNCE_MS = 250;

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeContextUsage(value, now = Date.now()) {
  if (!value || typeof value !== 'object') return null;
  const usedTokens = finiteNumber(value.usedTokens);
  const windowTokens = finiteNumber(value.windowTokens);
  if (usedTokens === null || usedTokens < 0 || windowTokens === null || windowTokens <= 0) return null;
  const suppliedPercent = finiteNumber(value.percent);
  const percent = suppliedPercent === null
    ? Math.round((usedTokens / windowTokens) * 100)
    : Math.round(suppliedPercent);
  return {
    usedTokens: Math.round(usedTokens),
    windowTokens: Math.round(windowTokens),
    percent: Math.min(100, Math.max(0, percent)),
    estimated: value.estimated === true,
    updatedAt: Math.round(finiteNumber(value.updatedAt) ?? now),
  };
}

function structuredContextUsage(payload, estimated = false) {
  const usage = payload?.context_usage;
  if (!usage || typeof usage !== 'object') return undefined;
  return normalizeContextUsage({
    usedTokens: usage.used_tokens ?? usage.tokens,
    windowTokens: usage.window_tokens ?? usage.context_window ?? usage.contextWindow,
    percent: usage.percent,
    estimated: usage.estimated ?? estimated,
  });
}

function claudeContextUsage(payload) {
  const context = payload?.context_window;
  if (!context || typeof context !== 'object') return undefined;
  const current = context.current_usage;
  if (!current || typeof current !== 'object') return null;
  return normalizeContextUsage({
    usedTokens: Number(current.input_tokens || 0)
      + Number(current.cache_creation_input_tokens || 0)
      + Number(current.cache_read_input_tokens || 0),
    windowTokens: context.context_window_size,
    percent: context.used_percentage,
  });
}

function codexContextUsage(info) {
  const usedTokens = finiteNumber(info?.last_token_usage?.total_tokens);
  const windowTokens = finiteNumber(info?.model_context_window);
  if (usedTokens === null || usedTokens < 0 || windowTokens === null
    || windowTokens <= CODEX_BASELINE_TOKENS) return null;
  const effectiveWindow = windowTokens - CODEX_BASELINE_TOKENS;
  const effectiveUsed = Math.max(0, usedTokens - CODEX_BASELINE_TOKENS);
  const remaining = Math.round((Math.max(0, effectiveWindow - effectiveUsed) / effectiveWindow) * 100);
  return normalizeContextUsage({
    usedTokens,
    windowTokens,
    percent: 100 - remaining,
  });
}

function parseCodexLine(line) {
  if (!line.includes('"token_count"')) return null;
  try {
    const record = JSON.parse(line);
    if (record?.type !== 'event_msg' || record.payload?.type !== 'token_count') return null;
    return codexContextUsage(record.payload.info);
  } catch {
    return null;
  }
}

function readLatestCodexUsage(path) {
  let descriptor;
  try {
    descriptor = openSync(path, 'r');
    const size = fstatSync(descriptor).size;
    if (!size) return null;
    const length = Math.min(size, CODEX_TAIL_BYTES);
    const buffer = Buffer.allocUnsafe(length);
    const bytes = readSync(descriptor, buffer, 0, length, size - length);
    const lines = buffer.subarray(0, bytes).toString('utf8').split('\n');
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const usage = parseCodexLine(lines[index]);
      if (usage) return usage;
    }
  } catch {}
  finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  return null;
}

function watchCodexContext(path, onUsage, options = {}) {
  if (!path || typeof onUsage !== 'function') return () => {};
  const readUsage = options.readUsage || readLatestCodexUsage;
  const watchFile = options.watch || watch;
  const debounceMs = Number(options.debounceMs ?? CODEX_WATCH_DEBOUNCE_MS);
  let timer = null;
  let watcher = null;
  let signature = '';
  let stopped = false;
  const sample = () => {
    if (stopped) return;
    const usage = readUsage(path);
    if (!usage) return;
    const next = `${usage.usedTokens}:${usage.windowTokens}:${usage.percent}`;
    if (next === signature) return;
    signature = next;
    onUsage(usage);
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(sample, debounceMs);
    timer.unref?.();
  };
  sample();
  try {
    watcher = watchFile(path, { persistent: false }, schedule);
    watcher.on?.('error', () => {});
  } catch {}
  return () => {
    stopped = true;
    clearTimeout(timer);
    timer = null;
    try { watcher?.close(); } catch {}
  };
}

module.exports = {
  CODEX_BASELINE_TOKENS,
  claudeContextUsage,
  codexContextUsage,
  normalizeContextUsage,
  parseCodexLine,
  readLatestCodexUsage,
  structuredContextUsage,
  watchCodexContext,
};
