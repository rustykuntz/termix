import { finishedDraft } from './public/grammar.js';

const DEFAULT_SHORTCUT = 'F4';
let state = 'off'; // off | loading | dictating | finishing | error | closing
let sessionId = '';
let streamId = '';
let draft = '';
let revision = 0;
let microphoneStarted = false;
let microphoneStarting = false;
let hotkeyCleanup = null;
let activeApi = null;
let activationShortcut = DEFAULT_SHORTCUT;
let finishResolve = null;
let finishTimer = null;

function listeningHint() {
  return `Dictating · press ${activationShortcut} again to paste and stop`;
}

function composer(stateName, hint) {
  activeApi.updateTerminalComposition({
    state: stateName, title: 'Dictation', draft, hint,
    canSend: ['dictating', 'error'].includes(state) && Boolean(draft.trim()),
    canStop: ['dictating', 'error'].includes(state),
  });
}

function send(event, extra = {}) { activeApi.send(event, { streamId, sessionId, ...extra }); }
function matches(value) { return value?.streamId === streamId && value?.sessionId === sessionId && state !== 'off' && state !== 'closing'; }

function acceptChunk(buffer) {
  if (!microphoneStarted || !['dictating', 'finishing'].includes(state) || !(buffer instanceof ArrayBuffer)) return;
  const bytes = new Uint8Array(buffer);
  // Forward small PCM frames as they arrive, including silence. No utterance gate.
  for (let offset = 0; offset < bytes.length; offset += 16_000) {
    send('audio', { audio: btoa(String.fromCharCode(...bytes.subarray(offset, offset + 16_000))) });
  }
}

function settleFinish() {
  clearTimeout(finishTimer);
  finishTimer = null;
  finishResolve?.();
  finishResolve = null;
}

async function stopMicrophone() {
  if (microphoneStarted || microphoneStarting) await activeApi.stopMicrophone();
  microphoneStarted = false;
  microphoneStarting = false;
}

async function showError(body) {
  state = 'error';
  settleFinish();
  await stopMicrophone();
  if (state === 'error') composer('error', body || 'Dictation failed.');
}

async function beginMicrophone() {
  if (microphoneStarting || microphoneStarted || state !== 'loading') return;
  const startingStream = streamId;
  microphoneStarting = true;
  try {
    await activeApi.startMicrophone();
    if (state !== 'loading' || startingStream !== streamId) return;
    microphoneStarted = true;
    state = 'dictating';
    composer('listening', listeningHint());
  } catch (error) {
    if (state === 'loading' && startingStream === streamId) {
      send('cancel');
      await showError(error.message || String(error));
    }
  } finally { microphoneStarting = false; }
}

async function activateDictation() {
  if (state !== 'off') return;
  state = 'loading';
  try {
    const session = await activeApi.getActiveSession();
    if (state !== 'loading') return;
    if (!session || session.live === false) {
      state = 'off';
      activeApi.toast('info', { title: 'Dictation', body: 'Open a live terminal first.' });
      return;
    }
    sessionId = session.id;
    streamId = crypto.randomUUID().replaceAll('-', '');
    const openingStream = streamId;
    draft = '';
    revision = 0;
    await activeApi.openTerminalComposition({
      state: 'processing', title: 'Dictation', draft: '',
      hint: 'Preparing local dictation…', canSend: false, canStop: false,
    });
    if (state === 'loading' && streamId === openingStream) send('prepare');
  } catch (error) { if (state === 'loading') await showError(error.message); }
}

async function deactivate() {
  if (state === 'off' || state === 'closing') return;
  send('cancel');
  state = 'closing';
  settleFinish();
  await stopMicrophone();
  activeApi.closeTerminalComposition();
  draft = '';
  sessionId = '';
  streamId = '';
  state = 'off';
}

async function finish({ submit = false, punctuate = false, discard = false } = {}) {
  if (state === 'off' || state === 'closing') return;
  if (discard || state === 'loading') { await deactivate(); return; }
  if (state === 'finishing') return;
  const finishingStream = streamId;
  const needsDrain = state === 'dictating';
  state = 'finishing';
  composer('processing', 'Finishing transcription…');
  await stopMicrophone();
  if (state !== 'finishing' || streamId !== finishingStream) return;
  if (needsDrain) {
    const complete = new Promise((resolve) => { finishResolve = resolve; });
    finishTimer = setTimeout(() => {
      send('cancel');
      showError('Finishing timed out. You can still paste the text shown.');
    }, 65_000);
    send('finish');
    await complete;
  }
  if (state !== 'finishing' || streamId !== finishingStream) return;
  const text = draft.trim();
  try {
    if (text) await activeApi.commitTerminalDraft(punctuate ? finishedDraft(text) : text, { sessionId, submit });
    await deactivate();
  } catch (error) { await showError(error.message); }
}

function toggle() {
  if (state === 'off') activateDictation();
  else finish({ punctuate: true });
}

function bindShortcut(api, shortcut) {
  hotkeyCleanup?.();
  activationShortcut = shortcut || DEFAULT_SHORTCUT;
  hotkeyCleanup = api.registerHotkey(activationShortcut, toggle);
  if (state === 'dictating') composer('listening', listeningHint());
}

export async function activate(api) {
  activeApi = api;
  const cleanups = [];
  bindShortcut(api, api.getSettings().values.shortcut);
  cleanups.push(api.onSettingsChange((next) => bindShortcut(api, next.values.shortcut)));
  cleanups.push(api.onMicrophoneData(acceptChunk));
  cleanups.push(api.onMicrophoneState((value) => {
    if (value?.state === 'ended' && state !== 'off' && state !== 'finishing' && state !== 'error') deactivate();
  }));
  cleanups.push(api.onTerminalCompositionAction((value) => {
    if (value?.sessionId !== sessionId) return;
    if (value.reason) { deactivate(); return; }
    if (value.type === 'send') finish({ submit: true });
    else if (value.type === 'stop') finish();
    else if (value.type === 'cancel') finish({ discard: true });
  }));
  cleanups.push(api.onMessage('status', (value) => {
    if (!matches(value) || state !== 'loading') return;
    if (value.state === 'ready') beginMicrophone();
    else composer('processing', value.body || 'Preparing…');
  }));
  cleanups.push(api.onMessage('transcript', (value) => {
    if (!matches(value) || !['dictating', 'finishing'].includes(state)
      || !Number.isSafeInteger(value.revision) || value.revision <= revision || typeof value.text !== 'string') return;
    revision = value.revision;
    draft = value.text.slice(0, 16_000);
    composer(state === 'finishing' ? 'processing' : 'listening',
      state === 'finishing' ? 'Finishing transcription…' : listeningHint());
  }));
  cleanups.push(api.onMessage('finished', (value) => { if (matches(value)) settleFinish(); }));
  cleanups.push(api.onMessage('error', (value) => { if (matches(value)) showError(value.body); }));
  cleanups.push(api.registerAction({
    id: 'dictate', label: 'Dictation', icon: 'mic',
    description: 'Dictate privately with live text from a smaller local speech model.',
    placements: ['terminal.voice'],
    when: (context) => Boolean(context?.session && context.session.live !== false), run: toggle,
  }));
  return async () => {
    hotkeyCleanup?.();
    for (const cleanup of cleanups) cleanup?.();
    await deactivate();
    activeApi = null;
  };
}
