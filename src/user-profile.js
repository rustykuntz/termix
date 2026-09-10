const MAX_NAME = 80;
const MAX_NOTES = 500;
const MAX_PROFILE_BYTES = 2048;
const FIELDS = new Set(['name', 'timeZone', 'notes']);
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function isValidProfile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !FIELDS.has(key))) return false;
  for (const [key, text] of Object.entries(value)) {
    const limit = key === 'notes' ? MAX_NOTES : MAX_NAME;
    if (typeof text !== 'string' || text.length > limit || CONTROL.test(text)) return false;
    if (key !== 'notes' && /[\r\n\t]/.test(text)) return false;
  }
  const zone = value.timeZone?.trim();
  if (zone) {
    if (!/^[A-Za-z][A-Za-z0-9_+./-]*$/.test(zone)) return false;
    try { new Intl.DateTimeFormat('en', { timeZone: zone }).format(); } catch { return false; }
  }
  return true;
}

function mergeProfile(current, patch) {
  return Object.fromEntries(Object.entries({ ...current, ...patch })
    .filter(([key, text]) => FIELDS.has(key) && typeof text === 'string' && text.trim())
    .map(([key, text]) => [key, text.trim()]));
}

function profileContext(value, availableBytes = MAX_PROFILE_BYTES) {
  if (!isValidProfile(value)) return '';
  const profile = mergeProfile({}, value);
  if (!Object.keys(profile).length) return '';
  const render = () => `About the user, shared through CliDeck settings (current requests take precedence):\n${JSON.stringify(profile)}\nUse their preferred name naturally when relevant, including when referring to them to teammates.`;
  const limit = Math.min(MAX_PROFILE_BYTES, availableBytes);
  // Reserve core tool instructions first, then this bounded profile, then optional plugin help.
  while (profile.notes && Buffer.byteLength(render()) > limit) {
    const characters = Array.from(profile.notes);
    characters.pop();
    profile.notes = characters.join('');
    if (!profile.notes) delete profile.notes;
  }
  const text = render();
  return Object.keys(profile).length && Buffer.byteLength(text) <= limit ? text : '';
}

module.exports = { isValidProfile, mergeProfile, profileContext, MAX_NAME, MAX_NOTES, MAX_PROFILE_BYTES };
