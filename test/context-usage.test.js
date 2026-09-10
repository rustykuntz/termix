const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, writeFileSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const {
  claudeContextUsage,
  codexContextUsage,
  readLatestCodexUsage,
  structuredContextUsage,
  watchCodexContext,
} = require('../src/context-usage');

test('Claude context telemetry uses input and cache tokens and clears while unavailable', () => {
  const usage = claudeContextUsage({ context_window: {
    context_window_size: 200_000,
    used_percentage: 42,
    current_usage: {
      input_tokens: 100,
      cache_creation_input_tokens: 3_000,
      cache_read_input_tokens: 80_900,
      output_tokens: 5_000,
    },
  } });
  assert.equal(Number.isFinite(usage.updatedAt), true);
  assert.deepEqual({ ...usage, updatedAt: 0 }, {
    usedTokens: 84_000,
    windowTokens: 200_000,
    percent: 42,
    estimated: false,
    updatedAt: 0,
  });
  assert.equal(claudeContextUsage({ context_window: { current_usage: null } }), null);
  assert.equal(claudeContextUsage({}), undefined);
});

test('Codex context telemetry mirrors its reserved-window percentage', () => {
  const usage = codexContextUsage({
    last_token_usage: { total_tokens: 98_058 },
    model_context_window: 258_400,
  });
  assert.equal(Number.isFinite(usage.updatedAt), true);
  assert.deepEqual({ ...usage, updatedAt: 0 }, {
    usedTokens: 98_058,
    windowTokens: 258_400,
    percent: 35,
    estimated: false,
    updatedAt: 0,
  });
});

test('Codex rollout reader finds the latest structured token snapshot', () => {
  const directory = mkdtempSync(join(tmpdir(), 'clideck-codex-context-'));
  const path = join(directory, 'rollout.jsonl');
  try {
    writeFileSync(path, [
      JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: {
        last_token_usage: { total_tokens: 20_000 }, model_context_window: 100_000,
      } } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', text: 'ignored' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: {
        last_token_usage: { total_tokens: 56_000 }, model_context_window: 100_000,
      } } }),
    ].join('\n'));
    const usage = readLatestCodexUsage(path);
    assert.equal(usage.usedTokens, 56_000);
    assert.equal(usage.windowTokens, 100_000);
    assert.equal(usage.percent, 50);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Codex watcher samples on changes and suppresses duplicate usage', async () => {
  let notifyChange;
  let current = 10_000;
  const seen = [];
  const stop = watchCodexContext('/tmp/rollout.jsonl', (usage) => seen.push(usage.usedTokens), {
    debounceMs: 0,
    readUsage: () => ({
      usedTokens: current, windowTokens: 100_000, percent: current / 1_000,
    }),
    watch: (_path, _options, listener) => {
      notifyChange = listener;
      return { close() {}, on() {} };
    },
  });
  assert.deepEqual(seen, [10_000]);
  notifyChange();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(seen, [10_000]);
  current = 20_000;
  notifyChange();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(seen, [10_000, 20_000]);
  stop();
});

test('structured provider telemetry preserves its precision marker', () => {
  const usage = structuredContextUsage({ context_usage: {
    used_tokens: 25_000,
    window_tokens: 100_000,
    estimated: true,
  } });
  assert.equal(usage.percent, 25);
  assert.equal(usage.estimated, true);
});
