const MAX_SEEN_TIPS = 512;
const TIP_ID = /^[a-z][a-z0-9._:-]{0,79}$/;

function isValidOnboarding(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => key === 'completed' || key === 'seenTips')
    && (value.completed === undefined || typeof value.completed === 'boolean')
    && (value.seenTips === undefined || (Array.isArray(value.seenTips)
      && value.seenTips.length <= MAX_SEEN_TIPS
      && value.seenTips.every((id) => typeof id === 'string' && TIP_ID.test(id)))));
}

function mergeOnboarding(current = {}, patch) {
  const seenTips = [...new Set([...(current.seenTips || []), ...(patch.seenTips || [])])];
  if (seenTips.length > MAX_SEEN_TIPS) throw new Error('Too many saved feature tips.');
  return {
    // Completion and seen markers only advance. A stale tab cannot reset another tab.
    completed: current.completed === true || (patch.completed ?? current.completed ?? true),
    seenTips,
  };
}

module.exports = { isValidOnboarding, mergeOnboarding, MAX_SEEN_TIPS };
