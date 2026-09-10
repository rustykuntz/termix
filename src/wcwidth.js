const MARK_RE = /^\p{Mark}$/u;
const FORMAT_RE = /^\p{Cf}$/u;
const EMOJI_PRESENTATION_RE = /^\p{Emoji_Presentation}$/u;

// East Asian Wide and Fullwidth ranges from Unicode's width property.
const WIDE_RANGES = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a],
  [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653],
  [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1],
  [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5],
  [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea],
  [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa],
  [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b],
  [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e],
  [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x2e80, 0x303e],
  [0x3040, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60],
  [0xffe0, 0xffe6], [0x1f200, 0x1f251], [0x20000, 0x3fffd],
];

function inRanges(codePoint, ranges) {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const [start, end] = ranges[middle];
    if (codePoint < start) high = middle - 1;
    else if (codePoint > end) low = middle + 1;
    else return true;
  }
  return false;
}

function wcwidth(character) {
  const value = String(character || '');
  const codePoint = value.codePointAt(0);
  if (codePoint === undefined) return 0;
  if (codePoint === 0 || codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  if (MARK_RE.test(value) || FORMAT_RE.test(value)) return 0;
  if (codePoint >= 0xfe00 && codePoint <= 0xfe0f) return 0;
  if (codePoint >= 0xe0100 && codePoint <= 0xe01ef) return 0;
  if (codePoint >= 0x1f3fb && codePoint <= 0x1f3ff) return 0;
  if (EMOJI_PRESENTATION_RE.test(value) || inRanges(codePoint, WIDE_RANGES)) return 2;
  return 1;
}

function isRegionalIndicator(character) {
  const codePoint = String(character || '').codePointAt(0);
  return codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff;
}

module.exports = { isRegionalIndicator, wcwidth };
