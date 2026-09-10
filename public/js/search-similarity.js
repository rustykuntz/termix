// Conservative spelling suggestions. Callers keep their literal matches first;
// this score is only for the remaining names/addresses, never long prompt bodies.
const WORD_CHAR = /[\p{L}\p{M}\p{N}]/u;
const LETTER = /\p{L}/u;
const normalise = (text) => String(text ?? "").normalize("NFC").toLowerCase().trim();

// Compare against a prefix, allowing insertion, deletion, replacement and an
// adjacent letter swap. Punctuation is literal: foo_bar must not become foobar.
function prefixDistance(query, target, limit) {
  const n = query.length, m = Math.min(target.length, n + limit);
  if (m < n - limit) return Infinity;
  const qWord = query.map((c) => WORD_CHAR.test(c));
  const tWord = target.slice(0, m).map((c) => WORD_CHAR.test(c));
  let older;
  let previous = Array(m + 1).fill(Infinity);
  previous[0] = 0;
  for (let j = 1; j <= Math.min(m, limit); j++) {
    previous[j] = tWord[j - 1] ? previous[j - 1] + 1 : Infinity;
  }
  for (let i = 1; i <= n; i++) {
    const row = Array(m + 1).fill(Infinity);
    row[0] = qWord[i - 1] ? previous[0] + 1 : Infinity;
    for (let j = Math.max(1, i - limit); j <= Math.min(m, i + limit); j++) {
      row[j] = Math.min(
        previous[j] + (qWord[i - 1] ? 1 : Infinity),
        row[j - 1] + (tWord[j - 1] ? 1 : Infinity),
        previous[j - 1] + (query[i - 1] === target[j - 1] ? 0 : qWord[i - 1] && tWord[j - 1] ? 1 : Infinity),
      );
      if (i > 1 && j > 1 && qWord[i - 1] && qWord[i - 2]
          && query[i - 1] === target[j - 2] && query[i - 2] === target[j - 1]) {
        row[j] = Math.min(row[j], older[j - 2] + 1);
      }
    }
    older = previous;
    previous = row;
  }
  return Math.min(...previous.slice(Math.max(1, n - limit)));
}

/** 0 rejects; larger scores mean closer spelling (maximum 1).
 * Queries need four letters; eight letters allow a second edit. Names can match
 * from any word boundary, so "reviwer" finds "Main reviewer" and "@team/reviewer".
 * Prefixes support typing a name progressively. Separators stay significant.
 * Very long queries stay on the caller's existing literal search path.
 */
export function spellingScore(query, candidate) {
  const q = Array.from(normalise(query));
  if (q.length > 128) return 0;
  const letters = q.filter((c) => LETTER.test(c)).length;
  if (letters < 4) return 0;
  const limit = letters >= 8 ? 2 : 1;
  const target = Array.from(normalise(candidate));
  let best = Infinity;
  for (let start = 0; start < target.length; start++) {
    if (start > 0 && WORD_CHAR.test(target[start - 1])) continue;
    const distance = prefixDistance(q, target.slice(start, start + q.length + limit), limit);
    best = Math.min(best, distance);
    if (best === 0) return 1;
  }
  return best <= limit ? 1 - best / letters : 0;
}
