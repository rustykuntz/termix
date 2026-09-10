const ITEMS = Object.freeze([
  { id: 'smile', glyph: '😊', label: 'Smiling face', keywords: ['happy', 'nice'], group: 'Smileys' },
  { id: 'grin', glyph: '😄', label: 'Grinning face', keywords: ['happy', 'laugh'], group: 'Smileys' },
  { id: 'laugh', glyph: '😂', label: 'Tears of joy', keywords: ['funny', 'lol'], group: 'Smileys' },
  { id: 'wink', glyph: '😉', label: 'Winking face', keywords: ['playful'], group: 'Smileys' },
  { id: 'love', glyph: '🥰', label: 'Smiling with hearts', keywords: ['love', 'thanks'], group: 'Smileys' },
  { id: 'cool', glyph: '😎', label: 'Cool face', keywords: ['sunglasses'], group: 'Smileys' },
  { id: 'thinking', glyph: '🤔', label: 'Thinking face', keywords: ['hmm', 'question'], group: 'Smileys' },
  { id: 'surprised', glyph: '😮', label: 'Surprised face', keywords: ['wow'], group: 'Smileys' },
  { id: 'sad', glyph: '😔', label: 'Sad face', keywords: ['sorry', 'disappointed'], group: 'Smileys' },
  { id: 'cry', glyph: '😢', label: 'Crying face', keywords: ['sad', 'tear'], group: 'Smileys' },
  { id: 'angry', glyph: '😠', label: 'Angry face', keywords: ['mad', 'annoyed'], group: 'Smileys' },
  { id: 'party', glyph: '🥳', label: 'Party face', keywords: ['celebrate', 'congrats'], group: 'Smileys' },
  { id: 'thumbs-up', glyph: '👍', label: 'Thumbs up', keywords: ['yes', 'approve', 'good'], group: 'Gestures' },
  { id: 'thumbs-down', glyph: '👎', label: 'Thumbs down', keywords: ['no', 'reject', 'bad'], group: 'Gestures' },
  { id: 'clap', glyph: '👏', label: 'Clapping hands', keywords: ['applause', 'great'], group: 'Gestures' },
  { id: 'pray', glyph: '🙏', label: 'Folded hands', keywords: ['please', 'thanks'], group: 'Gestures' },
  { id: 'wave', glyph: '👋', label: 'Waving hand', keywords: ['hello', 'bye'], group: 'Gestures' },
  { id: 'ok', glyph: '👌', label: 'OK hand', keywords: ['okay', 'perfect'], group: 'Gestures' },
  { id: 'muscle', glyph: '💪', label: 'Flexed biceps', keywords: ['strong', 'done'], group: 'Gestures' },
  { id: 'crossed-fingers', glyph: '🤞', label: 'Crossed fingers', keywords: ['hope', 'luck'], group: 'Gestures' },
  { id: 'heart', glyph: '❤️', label: 'Red heart', keywords: ['love'], group: 'Symbols' },
  { id: 'fire', glyph: '🔥', label: 'Fire', keywords: ['hot', 'excellent'], group: 'Symbols' },
  { id: 'sparkles', glyph: '✨', label: 'Sparkles', keywords: ['new', 'magic'], group: 'Symbols' },
  { id: 'rocket', glyph: '🚀', label: 'Rocket', keywords: ['ship', 'launch', 'fast'], group: 'Symbols' },
  { id: 'check', glyph: '✅', label: 'Check mark', keywords: ['done', 'pass', 'yes'], group: 'Symbols' },
  { id: 'cross', glyph: '❌', label: 'Cross mark', keywords: ['fail', 'no', 'wrong'], group: 'Symbols' },
  { id: 'warning', glyph: '⚠️', label: 'Warning', keywords: ['alert', 'caution'], group: 'Symbols' },
  { id: 'bug', glyph: '🐛', label: 'Bug', keywords: ['debug', 'issue'], group: 'Symbols' },
  { id: 'eyes', glyph: '👀', label: 'Eyes', keywords: ['look', 'review'], group: 'Symbols' },
  { id: 'bulb', glyph: '💡', label: 'Light bulb', keywords: ['idea'], group: 'Symbols' },
]);

const ITEM_BY_ID = new Map(ITEMS.map((item) => [item.id, item]));

async function openEmoji(api, candidateSession) {
  const session = candidateSession?.id ? candidateSession : await api.getActiveSession();
  if (!session?.id || session.live !== true) {
    api.toast('info', { title: 'Emoji', body: 'Open a live terminal session first.' });
    return false;
  }
  const selected = await api.openPicker({
    id: 'emoji',
    title: 'Emoji',
    placeholder: 'Search smile, angry, thumbs up…',
    items: ITEMS,
    recentLimit: 8,
  });
  const item = ITEM_BY_ID.get(selected);
  if (!item) return false;
  return api.commitTerminalDraft(item.glyph, { sessionId: session.id, submit: false });
}

export function activate(api) {
  const cleanups = [];
  let removeHotkey = null;
  let settings = api.getSettings();

  const bindHotkey = () => {
    removeHotkey?.();
    removeHotkey = null;
    const shortcut = String(settings?.values?.shortcut || '');
    if (shortcut) removeHotkey = api.registerHotkey(shortcut, () => openEmoji(api));
  };

  bindHotkey();
  cleanups.push(api.onSettingsChange((next) => {
    settings = next;
    bindHotkey();
  }));
  cleanups.push(api.registerAction({
    id: 'insert',
    label: 'Emoji',
    icon: '☺',
    description: 'Insert an emoji into the active terminal input.',
    placements: ['terminal.header', 'terminal.context'],
    when: (context) => context?.session?.live === true,
    run: (context) => openEmoji(api, context?.session),
  }));

  return () => {
    removeHotkey?.();
    for (const cleanup of cleanups) cleanup?.();
  };
}
