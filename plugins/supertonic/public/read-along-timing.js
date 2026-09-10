// Approximate word progress INSIDE known audio boundaries. This is a reading guide, not word alignment.
// Source ranges come through the speech normalizer, so a short token such as 365 gets the weight of every
// word in "three hundred sixty five", and a long URL gets only the weight of its spoken replacement.
export function sourceWords(text, language = 'en') {
  if (typeof Intl.Segmenter === 'function' && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u.test(text)) {
    let segmenter;
    try { segmenter = new Intl.Segmenter(language === 'na' ? undefined : language, { granularity: 'word' }); }
    catch { segmenter = new Intl.Segmenter(undefined, { granularity: 'word' }); }
    return [...segmenter.segment(text)].filter(part => part.isWordLike)
      .map(part => ({ start: part.index, end: part.index + part.segment.length }));
  }
  return [...text.matchAll(/\S+/gu)].filter(match => /[\p{L}\p{N}=<>%&@+]/u.test(match[0]))
    .map(match => ({ start: match.index, end: match.index + match[0].length }));
}

function spokenWeight(word, language) {
  const letters = [...word].length;
  if ((language === 'en' || language === 'na') && /^[a-z]+$/i.test(word)) {
    const syllables = word.toLowerCase().replace(/e$/, '').match(/[aeiouy]+/g)?.length || 1;
    return Math.max(1, syllables) + 0.4;
  }
  return 0.4 + Math.max(1, letters / 3);
}

export function estimateReadAlongCues(source, normalized, start, end, sourceOffset = 0, language = 'en') {
  const words = sourceWords(source, language);
  if (!words.length || end <= start) return [];
  const weights = new Array(words.length).fill(0);
  // Find the first source word touched by a normalized character. Ranges may cover a whole replacement.
  const owner = (at) => {
    let lo = 0, hi = words.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (words[mid].end <= at) lo = mid + 1; else hi = mid; }
    return lo;
  };
  for (const match of normalized.text.matchAll(/[\p{L}\p{N}\p{M}]+|[.,!?;:…。，！？；：]/gu)) {
    const punctuation = /^[.,!?;:…。，！？；：]$/u.test(match[0]);
    const weight = punctuation ? (/[.!?…。！？]/u.test(match[0]) ? 1.2 : 0.5)
      : spokenWeight(match[0], language);
    for (let at = match.index; at < match.index + match[0].length; at++) {
      const range = normalized.ranges[at];
      if (!range) continue;
      const first = owner(range.start);
      const touched = [];
      for (let i = first; i < words.length && words[i].start < range.end; i++) touched.push(i);
      if (!touched.length) touched.push(Math.max(0, first - 1)); // punctuation after a word
      for (const i of touched) weights[i] += weight / match[0].length / touched.length;
    }
  }
  // Removed syntax gets no spoken weight. A tiny floor keeps any retained source word's interval ordered.
  for (let i = 0; i < weights.length; i++) weights[i] = Math.max(0.05, weights[i]);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let elapsed = 0;
  return words.map((word, i) => {
    const cueStart = start + (end - start) * elapsed / total;
    elapsed += weights[i];
    return {
      start: cueStart,
      end: i === words.length - 1 ? end : start + (end - start) * elapsed / total,
      textStart: sourceOffset + word.start,
      textEnd: sourceOffset + words[Math.min(i + 2, words.length - 1)].end,
    };
  });
}
