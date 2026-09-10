const MENU_CHOICE_RE = /^\s*(?:[│❯›●•]\s+)*(\d+)\.\s+(.+)$/;
const MENU_TOP_RE = /^\s*[╭┌┏╔].*[╮┐┓╗]\s*$/;
const MENU_BOTTOM_RE = /^\s*[╰└┗╚].*[╯┘┛╝]\s*$/;
const MENU_RULE_RE = /^\s*[─━═-]{5,}\s*$/;
const MENU_CONTEXT_RULE_RE = /^\s*[─━═╌┄┈-]{5,}\s*$/u;

function cleanMenuLabel(text) {
  return String(text || '').replace(/[│┃║]\s*$/u, '').trim();
}

function extractMenuContext(lines, startIndex, firstChoiceIndex) {
  return lines.slice(startIndex, firstChoiceIndex)
    .map((line) => String(line || '')
      .replace(/^\s*[│┃║]\s?/u, '')
      .replace(/[│┃║]\s*$/u, '')
      .trim())
    .filter((line) => line
      && !MENU_TOP_RE.test(line)
      && !MENU_BOTTOM_RE.test(line)
      && !MENU_CONTEXT_RULE_RE.test(line))
    .join('\n');
}

function createMenuParser({
  selectionMarker,
  turnMarker,
  footerPattern = /\besc\b|\(esc\)|press enter to continue/i,
}) {
  function detectMenuBlock(lines) {
    const scanStart = Math.max(0, lines.length - 40);
    let footerIndex = -1;
    for (let index = lines.length - 1; index >= scanStart; index--) {
      if (footerPattern.test(lines[index])) {
        footerIndex = index;
        break;
      }
    }
    if (footerIndex < 0) return null;

    const choices = [];
    let firstChoiceIndex = -1;
    const searchFrom = MENU_CHOICE_RE.test(lines[footerIndex]) ? footerIndex : footerIndex - 1;
    for (let index = searchFrom; index >= scanStart; index--) {
      const line = lines[index];
      if (!line.trim() || /^[│\s]+$/.test(line)) continue;
      if (MENU_RULE_RE.test(line) || MENU_BOTTOM_RE.test(line)) continue;
      const match = line.match(MENU_CHOICE_RE);
      if (!match) {
        if (choices.length && /^\s{2,}\S/.test(line)) continue;
        break;
      }
      if (choices.length && Number(match[1]) >= Number(choices[0].value)) break;
      choices.unshift({
        value: match[1],
        label: cleanMenuLabel(match[2]),
        selected: selectionMarker.test(line),
      });
      firstChoiceIndex = index;
    }
    if (!choices.length || !choices.some((choice) => choice.selected)) return null;

    let startIndex = firstChoiceIndex;
    for (let index = startIndex - 1; index >= scanStart; index--) {
      if (turnMarker.test(lines[index])) break;
      if (lines[index].trim()) startIndex = index;
      if (MENU_TOP_RE.test(lines[index])) {
        startIndex = index;
        break;
      }
    }

    let endIndex = footerIndex;
    if (MENU_CHOICE_RE.test(lines[footerIndex])) {
      for (let index = footerIndex + 1; index < Math.min(lines.length, footerIndex + 6); index++) {
        if (MENU_BOTTOM_RE.test(lines[index])) {
          endIndex = index;
          break;
        }
      }
    }
    return {
      choices,
      context: extractMenuContext(lines, startIndex, firstChoiceIndex),
      startIndex,
      endIndex,
    };
  }

  return {
    detectMenu(lines) {
      return detectMenuBlock(lines)?.choices || [];
    },
    detectMenuDetails(lines) {
      const block = detectMenuBlock(lines);
      return block
        ? { choices: block.choices, context: block.context }
        : { choices: [], context: '' };
    },
    stripMenu(lines) {
      const block = detectMenuBlock(lines);
      if (!block) return lines;
      return lines.filter((_, index) => index < block.startIndex || index > block.endIndex);
    },
  };
}

module.exports = { createMenuParser };
