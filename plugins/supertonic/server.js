function settings(api) {
  return {
    voice: api.getSetting('voice'),
    shortcut: api.getSetting('shortcut'),
    language: api.getSetting('language'),
    normalization: api.getSetting('normalization'),
    quality: api.getSetting('quality'),
    autoRead: api.getSetting('auto-read') === true,
  };
}

function speechText(value) {
  const text = String(value || '').trim();
  if (!text) throw new Error('Provide text to read.');
  return text;
}

exports.activate = (api) => {
  api.registerCommand('speak', ({ args, stdin, sessionId }) => {
    const text = speechText(args.join(' ').trim() || stdin);
    api.sendToClients('speak', { text, sessionId, source: 'agent' });
    return 'Sent to Supertonic.\n';
  });

  api.onClientMessage('ready', (_data, context) => {
    context.reply('settings', settings(api));
  });

  api.onSettingsChange(() => api.sendToClients('settings', settings(api)));

  api.onEvent('agent.final', (event) => {
    if (api.getSetting('auto-read') !== true || !event.text) return;
    api.sendToClients('speak', {
      text: String(event.text),
      sessionId: String(event.sessionId || ''),
      source: 'auto',
    });
  });
};
