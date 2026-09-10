const { SpeechRuntime } = require('./speech-runtime');

function safeEnvelope(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const { streamId, sessionId } = data;
  if (typeof streamId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(streamId)
    || typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) return null;
  return { streamId, sessionId };
}

exports.activate = (api) => {
  let runtime = null;
  let active = null;
  let device = api.getSetting('device') || 'auto';
  const send = (entry, event, data) => {
    if (active === entry) api.sendToClients(event, { ...entry.envelope, ...data });
  };
  const matches = (data) => safeEnvelope(data) && active
    && active.envelope.streamId === data.streamId && active.envelope.sessionId === data.sessionId;
  const cancel = () => {
    const entry = active;
    active = null;
    entry?.stream?.cancel();
    // Also cancel first-use downloads/model startup when the user closes preparation.
    if (entry && !entry.stream) { runtime?.stop(); runtime = null; }
  };
  const fail = (entry, error) => {
    if (active !== entry) return;
    send(entry, 'error', { body: error.message || String(error) });
    cancel();
  };

  api.onClientMessage('prepare', async (data) => {
    const envelope = safeEnvelope(data);
    if (!envelope) return;
    if (active) {
      if (!matches(data)) api.sendToClients('error', { ...envelope, body: 'Another dictation is already active. Stop it first.' });
      return;
    }
    const entry = { envelope, stream: null, revision: 0, finishing: false };
    active = entry;
    try {
      const session = await api.getSession(envelope.sessionId);
      if (active !== entry) return;
      if (!session || session.live === false) throw new Error('Open a live terminal first.');
      if (!runtime) runtime = new SpeechRuntime({
        dataDir: api.dataDir, device,
        onStatus: (body) => { if (active) send(active, 'status', { state: 'setup', body }); },
      });
      const stream = await runtime.openStream(
        (text) => send(entry, 'transcript', { revision: ++entry.revision, text }),
        (error) => fail(entry, error),
      );
      if (active !== entry) { stream.cancel(); return; }
      entry.stream = stream;
      send(entry, 'status', { state: 'ready', body: 'Dictation is ready.' });
    } catch (error) { fail(entry, error); }
  });

  api.onClientMessage('audio', (data) => {
    if (!matches(data) || !active.stream || active.finishing) return;
    const entry = active;
    const audio = data.audio;
    if (typeof audio !== 'string' || !audio.length || audio.length > 48_000
      || audio.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(audio)) {
      fail(entry, new Error('Invalid microphone audio.')); return;
    }
    const bytes = Buffer.from(audio, 'base64');
    if (bytes.length % 2) { fail(entry, new Error('Invalid microphone audio.')); return; }
    try { entry.stream.push(bytes); } catch (error) { fail(entry, error); }
  });

  api.onClientMessage('finish', async (data) => {
    if (!matches(data) || !active.stream || active.finishing) return;
    const entry = active;
    entry.finishing = true;
    try {
      await entry.stream.finish();
      send(entry, 'finished', {});
      if (active === entry) active = null;
    } catch (error) { fail(entry, error); }
  });
  api.onClientMessage('cancel', (data) => { if (matches(data)) cancel(); });
  api.onSettingsChange((next) => {
    const wanted = next.device || 'auto';
    if (wanted === device) return;
    if (active) fail(active, new Error('Speech processor changed. Start dictation again.'));
    device = wanted;
    runtime?.stop();
    runtime = null;
  });
  api.onShutdown(() => { cancel(); runtime?.stop(); });
};

exports.safeEnvelope = safeEnvelope;
