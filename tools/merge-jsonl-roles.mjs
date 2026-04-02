#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'fs';

const isCodex = process.argv.includes('--codex');
const file = process.argv.filter(a => !a.startsWith('--'))[2];
if (!file) {
  console.error('Usage: node merge-jsonl-roles.mjs <file.jsonl> [--codex]');
  process.exit(1);
}

const lines = readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
const merged = [];
const SPINNER_WORD = 'Working';
const SPINNER_TAIL = 's • esc to interrupt)';
const SPINNER_PREFIXES = ['Working', 'Workin', 'Worki', 'Work', 'Wor', 'Wo', 'W'];
const SPINNER_SUFFIXES = ['Working', 'orking', 'rking', 'king', 'ing', 'ng', 'g'];
const SPINNER_OUTRO = /^\d+s • esc to interr?upt\)/;

for (const entry of lines) {
  const prev = merged[merged.length - 1];
  if (prev && prev.role === entry.role && entry.role === 'user') {
    prev.text += '\n' + entry.text;
  } else {
    merged.push({ ...entry });
  }
}

function cleanText(text) {
  const extra = isCodex ? '\u2022\u203a' : '';
  const re = new RegExp(`[^a-zA-Z0-9.,;:!?'"()\\-/\\s@#$%&*+=<>\\[\\]{}\\\\|_~\`^${extra}]`, 'g');

  let out = text;
  if (isCodex) {
    out = collapseCodexSpinner(out);
    // collapse consecutive • (with optional whitespace between) into one
    out = out.replace(/\u2022(?:\s*\u2022)+/g, '\u2022');
  }

  return out
    .replace(re, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n(?:[ \t]*\n)+/g, '\n')
    .trim();
}

function collapseCodexSpinner(text) {
  let out = '';
  for (let i = 0; i < text.length;) {
    const buildLen = consumeSpinnerBuildUp(text, i);
    if (buildLen > 0) {
      out += '\u2022';
      i += buildLen;
      continue;
    }

    const fragmentLen = consumeSpinnerFragments(text, i);
    if (fragmentLen > 0) {
      out += '\u2022';
      i += fragmentLen;
      continue;
    }

    out += text[i];
    i += 1;
  }
  return out;
}

function consumeSpinnerBuildUp(text, start) {
  if (text[start] !== '\u2022') return 0;

  let i = start + 1;
  let matched = 0;
  while (matched < SPINNER_WORD.length && text[i] === SPINNER_WORD[matched]) {
    i += 1;
    matched += 1;
  }

  if (matched === 0) return 0;
  if (matched < SPINNER_WORD.length) return i - start;
  if (text[i] !== '(') return i - start;

  i += 1;
  while (/[0-9]/.test(text[i] || '')) i += 1;

  let tail = 0;
  while (tail < SPINNER_TAIL.length && text[i] === SPINNER_TAIL[tail]) {
    i += 1;
    tail += 1;
  }

  return i - start;
}

function consumeSpinnerFragments(text, start) {
  let i = start;
  let tokens = 0;
  let sawBullet = false;
  let startsWithBulletPrefix = false;

  while (true) {
    const bulletPrefix = text[i] === '\u2022' ? matchSpinnerPart(text, i + 1, SPINNER_PREFIXES) : '';
    if (bulletPrefix) {
      startsWithBulletPrefix ||= tokens === 0;
      sawBullet = true;
      i += 1 + bulletPrefix.length;
      tokens += 1;
      continue;
    }

    const suffix = matchSpinnerPart(text, i, SPINNER_SUFFIXES);
    if (suffix && text[i + suffix.length] === '\u2022') {
      sawBullet = true;
      i += suffix.length + 1;
      tokens += 1;
      continue;
    }

    const prefix = matchSpinnerPart(text, i, SPINNER_PREFIXES);
    if (prefix) {
      i += prefix.length;
      tokens += 1;
      continue;
    }

    if (suffix) {
      i += suffix.length;
      tokens += 1;
      continue;
    }

    const outro = text.slice(i).match(SPINNER_OUTRO)?.[0];
    if (outro) {
      sawBullet = true;
      i += outro.length;
      tokens += 1;
      continue;
    }

    const digits = text.slice(i).match(/^\d+/)?.[0];
    if (digits) {
      i += digits.length;
      tokens += 1;
      continue;
    }

    break;
  }

  if (startsWithBulletPrefix) return i - start;
  return sawBullet && tokens >= 2 ? i - start : 0;
}

function matchSpinnerPart(text, start, parts) {
  return parts.find(part => text.startsWith(part, start)) || '';
}

function splitCodexAgentEntry(entry) {
  if (!isCodex || entry.role !== 'agent') return [entry];

  const work = { ...entry, role: 'agent_work' };
  const cut = entry.text.lastIndexOf('\u2022');
  if (cut === -1) return [work];

  const output = cleanAgentOutput(entry.text.slice(cut + 1));
  if (!output) return [work];

  return [work, { ts: entry.ts, role: 'agent_output', text: output }];
}

function cleanAgentOutput(text) {
  const out = text.trim();
  const footer = out.lastIndexOf('\u203a');
  return (footer === -1 ? out : out.slice(0, footer)).trim();
}

const cleaned = merged.map(e => ({ ...e, text: cleanText(e.text) }));
const transformed = cleaned.flatMap(splitCodexAgentEntry);
const out = transformed.map(e => JSON.stringify(e)).join('\n') + '\n';
writeFileSync(file, out);
console.log(`${lines.length} lines → ${merged.length} lines`);
