const SENTENCE_BREAK = /(?<!Mr\.|Mrs\.|Ms\.|Dr\.|Prof\.|Sr\.|Jr\.|Ph\.D\.|etc\.|e\.g\.|i\.e\.|vs\.|Inc\.|Ltd\.|Co\.|Corp\.|St\.|Ave\.|Blvd\.)(?<!\b[A-Z]\.)(?<=[.!?])\s+/g;

function trimmedRange(text, start, end) {
  while (start < end && /\s/u.test(text[start])) start += 1;
  while (end > start && /\s/u.test(text[end - 1])) end -= 1;
  return start < end ? { start, end, text: text.slice(start, end) } : null;
}

// The model already speaks long text in coarse chunks. Keep the exact source range for each chunk so the
// host can follow those real audio boundaries without guessing word timings or searching normalized speech.
export function chunkTextRanges(text, maxLen = 300) {
  if (typeof text !== 'string') throw new Error(`chunkTextRanges expects a string, got ${typeof text}`);
  if (!Number.isInteger(maxLen) || maxLen < 2) throw new Error('Chunk size must be at least two characters.');
  const sentences = [];
  let paragraphStart = 0;
  const paragraphs = /\n\s*\n+/g;
  for (let boundary = paragraphs.exec(text); ; boundary = paragraphs.exec(text)) {
    const paragraphEnd = boundary ? boundary.index : text.length;
    const paragraph = trimmedRange(text, paragraphStart, paragraphEnd);
    if (paragraph) {
      SENTENCE_BREAK.lastIndex = 0;
      let sentenceStart = paragraph.start;
      for (let split = SENTENCE_BREAK.exec(paragraph.text); split; split = SENTENCE_BREAK.exec(paragraph.text)) {
        const sentence = trimmedRange(text, sentenceStart, paragraph.start + split.index);
        if (sentence) sentences.push(sentence);
        sentenceStart = paragraph.start + split.index + split[0].length;
      }
      const sentence = trimmedRange(text, sentenceStart, paragraph.end);
      if (sentence) sentences.push(sentence);
    }
    if (!boundary) break;
    paragraphStart = paragraphs.lastIndex;
  }

  const chunks = [];
  let current = null;
  const flush = () => { if (current) chunks.push(current); current = null; };
  for (const sentence of sentences) {
    let start = sentence.start;
    while (start < sentence.end) {
      let end = Math.min(sentence.end, start + maxLen);
      if (end < sentence.end) {
        const space = text.slice(start, end).search(/\s+\S*$/u);
        if (space > 0) end = start + space;
        // A long token still has to fit; never split a UTF-16 surrogate pair.
        else if (/[\uD800-\uDBFF]/u.test(text[end - 1])) end--;
      }
      const part = trimmedRange(text, start, end);
      if (part) {
        if (current && part.end - current.start > maxLen) flush();
        current = trimmedRange(text, current?.start ?? part.start, part.end);
      }
      start = end;
      while (start < sentence.end && /\s/u.test(text[start])) start++;
    }
  }
  flush();
  return chunks;
}

export function chunkText(text, maxLen = 300) {
  return chunkTextRanges(text, maxLen).map((chunk) => chunk.text);
}
