const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const source = readFileSync(join(__dirname, '../public/js/search-similarity.js'), 'utf8');
const moduleReady = import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('missing, extra, replaced and swapped letters find the intended name', async () => {
  const { spellingScore: score } = await moduleReady;
  for (const query of ['reviwer', 'revviewer', 'revixwer', 'reveiwer']) {
    assert.ok(score(query, 'Reviewer') > 0, query);
  }
  assert.ok(score('udpate', 'Update documentation') > 0);
  assert.ok(score('mian', 'main programmer') > 0);
});

test('short and numeric-only queries do not produce spelling suggestions', async () => {
  const { spellingScore: score } = await moduleReady;
  for (const query of ['', 'u', 'ui', 'rev', '1234', '@@/ui']) {
    assert.equal(score(query, 'UI reviewer 1234'), 0, query);
  }
});

test('the edit budget is strict and scores favour closer spelling', async () => {
  const { spellingScore: score } = await moduleReady;
  assert.equal(score('mxin', 'main'), 0.75);
  assert.equal(score('mxxn', 'main'), 0);
  assert.equal(score('rexixwer', 'reviewer'), 0.75);
  assert.equal(score('xxxiewer', 'reviewer'), 0);
  assert.ok(score('revixwer', 'reviewer') > score('rexixwer', 'reviewer'));
});

test('word boundaries, multiword names and partially typed names work', async () => {
  const { spellingScore: score } = await moduleReady;
  assert.ok(score('reviwer', 'Main reviewer') > 0);
  assert.ok(score('reviwer', '@clideck-next/reviewer') > 0);
  assert.ok(score('main progrmmer', '@clideck-next/main programmer') > 0);
  assert.ok(score('progrm', 'programmer') > 0);
  assert.equal(score('reviwer', 'prereviewer'), 0);
  assert.equal(score('review', 'Main reviewer'), 1);
});

test('address punctuation cannot be removed, replaced or swapped', async () => {
  const { spellingScore: score } = await moduleReady;
  for (const [query, candidate] of [
    ['foobar', 'foo_bar'], ['foo_bar', 'foobar'],
    ['foo-bar', 'foo_bar'], ['team/main', 'teammain'],
    ['teammain', 'team/main'], ['foo bar', 'foo-bar'],
  ]) assert.equal(score(query, candidate), 0, `${query} / ${candidate}`);
  assert.ok(score('clidek-next/main', '@clideck-next/main programmer') > 0);
});

test('case and canonical Unicode equivalents match without stripping accents', async () => {
  const { spellingScore: score } = await moduleReady;
  assert.equal(score('  REVIEWER  ', 'Reviewer'), 1);
  assert.equal(score('cafe\u0301', 'Café'), 1);
  assert.ok(score('révisuer', 'réviseur') > 0);
  assert.equal(score('xxxxx', 'réviseur'), 0);
});

test('unrelated and excessive input produces no suggestion', async () => {
  const { spellingScore: score } = await moduleReady;
  for (const [query, candidate] of [
    ['reviewer', 'Designer'], ['deploy', 'Update documentation'],
    ['reviewer', 'UI'], ['reviewer', ''], ['x'.repeat(129), 'x'.repeat(130)],
  ]) assert.equal(score(query, candidate), 0);
});
