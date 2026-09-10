const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('fs');
const { resolve } = require('path');

const MODULE = '../plugins/supertonic/public/tts-normalizer.js';
const CHUNKS = '../plugins/supertonic/public/text-chunks.js';
const LEXICON = resolve(__dirname, '../plugins/supertonic/public/tts_normalization_lexicon.txt');

test('Supertonic lexicon normalizes technical English in one boundary-aware pass', async () => {
  const { normalizeText, parseLexicon } = await import(MODULE);
  const entries = parseLexicon(readFileSync(LEXICON, 'utf8'));
  assert.ok(entries.length > 450);
  assert.equal(
    normalizeText('a) GPU >= 2 GB; b) AI != AGI; z) 50%.', entries),
    'A G P U greater than or equal to two gigabytes; B A I does not equal A G I; Z fifty percent.',
  );
  assert.equal(normalizeText('x->y, x>=2, and x>1', entries), 'x to y, x greater than or equal to two, and x greater than one');
  assert.equal(normalizeText('SAIL uses an AI API at example.com', entries), 'SAIL uses an A I A P I at example dot com');
  assert.equal(normalizeText('“READY”—e.g. HTML…', entries), '"ready"-for example H T M L...');
});

test('Supertonic programmatically speaks numbers, money, dates, and time', async () => {
  const { normalizeText, parseLexicon } = await import(MODULE);
  const entries = parseLexicon(readFileSync(LEXICON, 'utf8'));
  assert.equal(
    normalizeText('333; 5,543; $5643; $5,543; $12.50; $0.05.', entries),
    'three hundred thirty three; five thousand five hundred forty three; five thousand six hundred forty three dollars; five thousand five hundred forty three dollars; twelve dollars and fifty cents; five cents.',
  );
  assert.equal(
    normalizeText('2026-08-26, 08/26/2026, and 26/08/2026 at 9:05 PM.', entries),
    'August twenty sixth, twenty twenty six, August twenty sixth, twenty twenty six, and August twenty sixth, twenty twenty six at nine oh five P M.',
  );
  assert.equal(
    normalizeText('3.1415, 42nd, €1.01, £2.50, and ¥500.', entries),
    'three point one four one five, forty second, one euro and one cent, two pounds and fifty pence, and five hundred yen.',
  );
  assert.equal(normalizeText('(0.09–0.30)', entries), '(zero point zero nine-zero point thirty)');
  assert.equal(
    normalizeText('Retry every 10s, wait 250ms, then stop after 1.5h or 2 days.', entries),
    'Retry every ten seconds, wait two hundred fifty milliseconds, then stop after one point five hours or two days.',
  );
  assert.equal(
    normalizeText('$897k; €1.5m; £2b; ¥3.2t; ₽5k; ₹1.25m; ₩4b; ₪2k; ฿3m.', entries),
    'eight hundred ninety seven thousand dollars; one point five million euros; two billion pounds; three point two trillion yen; five thousand rubles; one point two five million rupees; four billion won; two thousand shekels; three million baht.',
  );
  assert.equal(
    normalizeText('₽1.01; ₹2.50; ₩500; ₪1.01; ฿2.50.', entries),
    'one ruble and one kopek; two rupees and fifty paise; five hundred won; one shekel and one agora; two baht and fifty satang.',
  );
  assert.equal(
    normalizeText('since 08-26, from 1/99, and since 2025-12; but during 08-26.', entries),
    'since August twenty twenty six, from January nineteen ninety nine, and since December twenty twenty five; but during 08-26.',
  );
});

test('Supertonic keeps terminal wrapping out of technical normalization', async () => {
  const { normalizeText, parseLexicon } = await import(MODULE);
  const entries = parseLexicon(readFileSync(LEXICON, 'utf8'));
  assert.equal(
    normalizeText('Record id 42\nThen fetch ids.\n\nDone!', entries),
    'Record I D forty two\nThen fetch I Ds.\n\nDone!',
  );
});

test('Supertonic speaks version components as whole numbers separated by point', async () => {
  const { normalizeText, normalizeTextWithRanges, parseLexicon } = await import(MODULE);
  const entries = parseLexicon(readFileSync(LEXICON, 'utf8'));
  for (const [source, expected] of [
    ['1.11.0', 'one point eleven point zero'],
    ['Update to 1.11.0.', 'Update to one point eleven point zero.'],
    ['v2.0.1 and V10.20.300', 'version two point zero point one and version ten point twenty point three hundred'],
    ['v1.11', 'version one point eleven'],
    ['1.11.0-beta', 'one point eleven point zero-beta'],
    ['1.02.0', 'one point zero two point zero'],
  ]) {
    assert.equal(normalizeText(source, entries), expected);
    const mapped = normalizeTextWithRanges(source, entries);
    assert.equal(mapped.text, expected);
    assert.equal(mapped.ranges.length, expected.length);
    assert.ok(mapped.ranges.every(range => range.start >= 0 && range.end <= source.length && range.start < range.end));
  }
  const mapped = normalizeTextWithRanges('1.11.0', entries);
  assert.ok(mapped.ranges.every(range => range.start === 0 && range.end === 6));
  assert.equal(normalizeText('1.11.0', entries, 'off'), '1.11.0');
});

test('Supertonic number parsing leaves addresses, identifiers, and invalid dates intact', async () => {
  const { normalizeEnglishPatterns } = await import(MODULE);
  assert.equal(
    normalizeEnglishPatterns('127.0.0.1 abc333 2026-02-30 13/13/2026 2026-08-26T12:34:56Z $1.234'),
    '127.0.0.1 abc333 2026-02-30 13/13/2026 2026-08-26T12:34:56Z $1.234',
  );
  const references = '192.168.1.11 abc1.11.0 1.11.0.example /1.11.0/v2.0.1 1.11.0.js';
  assert.equal(normalizeEnglishPatterns(references), references);
  assert.equal(normalizeEnglishPatterns('08-26 from 13-26 from 08-26-30'), '08-26 from 13-26 from 08-26-30');
  assert.equal(normalizeEnglishPatterns('12:34:56'), 'twelve thirty four and fifty six seconds');
});

test('Supertonic replaces strong URLs and file paths without guessing', async () => {
  const { normalizeSpokenReferences, normalizeText, parseLexicon } = await import(MODULE);
  assert.equal(
    normalizeSpokenReferences('Open http://127.0.0.1:4100, then docs/archive/STRATEGY-FINDINGS-entry-explanation-threads-v1.md.'),
    'Open the URL in our conversation, then the document path is in our conversation.',
  );
  assert.equal(
    normalizeSpokenReferences('See https://example.com/docs?q=1 and ./reports/result.pdf:761; or www.example.org/help.'),
    'See the URL in our conversation and the document path is in our conversation; or the URL in our conversation.',
  );
  assert.equal(
    normalizeSpokenReferences('Keep 1/2, 08/26/2026, v2.0.1, and/or, API v1/users, example.com, user@example.com, and http://.'),
    'Keep 1/2, 08/26/2026, v2.0.1, and/or, API v1/users, example.com, user@example.com, and http://.',
  );
  assert.equal(normalizeSpokenReferences('docs/file.md', 'off'), 'docs/file.md');
  const entries = parseLexicon(readFileSync(LEXICON, 'utf8'));
  assert.equal(normalizeText('Read docs/file.md', entries), 'Read the document path is in our conversation');
  assert.equal(normalizeText('Keep\nline break', entries, 'off'), 'Keep\nline break');
});

test('Supertonic describes file paths by type and preserves URL precedence and punctuation', async () => {
  const { normalizeSpokenReferences, normalizeText, normalizeTextWithRanges, parseLexicon } = await import(MODULE);
  const entries = parseLexicon(readFileSync(LEXICON, 'utf8'));
  for (const [path, type] of [
    ['docs/CLOSE-20260908-first-day-under-the-screener-v1.md', 'document'],
    ['docs/notes.txt', 'document'], ['docs/draft.doc', 'document'],
    ['docs/final.docx', 'document'], ['./reports/result.PDF:761:2', 'document'],
    ['~/Photos/holiday.jpg', 'photo'], ['/tmp/screenshot.jpeg', 'photo'],
    ['images/צילום.PNG', 'photo'], ['images/animation.webp', 'photo'],
    ['clips/demo.mp4', 'video'], ['clips/demo.MOV', 'video'],
    ['recordings/voice.wav', 'audio'], ['music/song.mp3', 'audio'],
    ['reports/budget.xlsx', 'spreadsheet'], ['reports/data.csv', 'spreadsheet'],
    ['slides/intro.pptx', 'presentation'], ['backups/release.tar.gz', 'archive'],
    ['src/app.js:12', 'code file'], ['config/settings.json', 'data file'],
    ['output/model.gguf', 'file'], ['config/.env', 'file'], ['config/.md', 'file'],
  ]) {
    const expected = `the ${type} path is in our conversation`;
    assert.equal(normalizeSpokenReferences(`See (${path}), then continue.`), `See (${expected}), then continue.`, path);
    assert.equal(normalizeText(path, entries), expected, path);
    const mapped = normalizeTextWithRanges(path, entries);
    assert.equal(mapped.text, expected, path);
    assert.equal(mapped.ranges.length, expected.length, path);
    assert.ok(mapped.ranges.every(range => range.start >= 0 && range.start < range.end && range.end <= path.length), path);
    assert.equal(Math.min(...mapped.ranges.map(range => range.start)), 0, path);
    assert.equal(Math.max(...mapped.ranges.map(range => range.end)), path.length, path);
    assert.equal(normalizeSpokenReferences(path, 'off'), path);
    assert.equal(normalizeSpokenReferences(path, 'french'), path);
  }
  assert.equal(normalizeSpokenReferences('https://example.com/report.pdf and www.example.com/photo.png'),
    'the URL in our conversation and the URL in our conversation');
  const literal = 'example.md user@example.jpg 1/2 08/26/2026 v1/users docs/README';
  assert.equal(normalizeSpokenReferences(literal), literal);
});

test('Supertonic lexicon parser ignores malformed rows and keeps languages isolated', async () => {
  const { normalizeText, parseLexicon } = await import(MODULE);
  const entries = parseLexicon([
    '# comment',
    'API | A P I | english',
    'API | ah pee eye | french',
    'broken row',
  ].join('\n'));
  assert.equal(entries.length, 2);
  assert.equal(normalizeText('API', entries, 'english'), 'A P I');
  assert.equal(normalizeText('API', entries, 'french'), 'ah pee eye');
  assert.equal(normalizeText('API', entries, 'off'), 'API');
});

test('Supertonic coarse chunks retain exact displayed source ranges', async () => {
  const { chunkText, chunkTextRanges } = await import(CHUNKS);
  const source = '  One short.  Two longer sentence!\n\nThird paragraph.  ';
  assert.deepEqual(chunkTextRanges(source, 24), [
    { start: 2, end: 12, text: 'One short.' },
    { start: 14, end: 34, text: 'Two longer sentence!' },
    { start: 36, end: 52, text: 'Third paragraph.' },
  ]);
  assert.deepEqual(chunkText(source, 24), ['One short.', 'Two longer sentence!', 'Third paragraph.']);
  assert.deepEqual(chunkText('First. Second! Third?', 300), ['First. Second! Third?']);
  assert.deepEqual(chunkText('Title\n\nBody text.', 300), ['Title\n\nBody text.']);
  for (const source of ['word '.repeat(3000), 'x'.repeat(8001), '😀'.repeat(1000)]) {
    const chunks = chunkTextRanges(source, 301);
    assert.ok(chunks.every(chunk => chunk.text.length <= 301));
    assert.equal(chunks.map(chunk => chunk.text).join('').replace(/\s/g, ''), source.replace(/\s/g, ''));
    assert.ok(chunks.every(chunk => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(chunk.text)));
  }
});
