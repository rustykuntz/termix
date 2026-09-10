import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const sent = [];
globalThis.self = {
  location: { href: 'http://127.0.0.1/js/plugin-client-worker.js?id=smart-dictation' },
  postMessage(message) { sent.push(message); }, close() {},
};
const tick = () => new Promise((r) => setTimeout(r, 0));
const latest = (type, method) => [...sent].reverse().find((m) => m.type === type && (!method || m.method === method || m.event === method));
const count = (method) => sent.filter((m) => m.type === 'request' && m.method === method).length;
const checks = [];
const ok = (name, pass) => { checks.push(!!pass); console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}`); };
const emit = async (data) => { await self.onmessage({ data }); await tick(); };
async function reply(request, value = true) {
  if (!request) throw new Error('Missing host request');
  await emit({ type: 'response', requestId: request.requestId, success: true, value });
}
const event = (name, data) => emit({ type: 'plugin-message', event: name, data });
const action = (type, extra = {}) => emit({ type: 'terminal-composition-action', action: { type, sessionId: 'S', ...extra } });
const toggle = () => emit({ type: 'invoke', requestId: String(Math.random()), method: 'hotkey', id: shortcut, context: {} });
let shortcut = 'F4';
await import('../public/js/plugin-client-worker.js?dictation=' + Date.now());
const grammar = readFileSync(new URL('../plugins/smart-dictation/public/grammar.js', import.meta.url), 'utf8').replaceAll('export ', '');
const client = readFileSync(new URL('../plugins/smart-dictation/client.js', import.meta.url), 'utf8').replace(/^import .*grammar\.js';\n/, '');
await emit({ type: 'init', clientUrl: 'data:text/javascript;base64,' + Buffer.from(grammar + '\n' + client).toString('base64'),
  settings: { values: { shortcut, device: 'auto' }, configured: {} } });
ok('Dictation registers F4 and the voice button', sent.some((m) => m.type === 'register-hotkey' && m.combo === 'F4') && sent.some((m) => m.type === 'register-action' && m.definition.label === 'Dictation'));

async function start({ ready = true } = {}) {
  await toggle();
  await reply(latest('request', 'get-active-session'), { id: 'S', live: true });
  await reply(latest('request', 'open-terminal-composition'), { sessionId: 'S' });
  const envelope = latest('send', 'prepare').data;
  if (ready) {
    await event('status', { ...envelope, state: 'ready' });
    await reply(latest('request', 'start-microphone'), { sampleRate: 16000 });
  }
  return envelope;
}
async function text(envelope, revision, value) { await event('transcript', { ...envelope, revision, text: value }); }
async function finish(envelope, type = 'shortcut') {
  if (type === 'shortcut') await toggle(); else await action(type);
  await reply(latest('request', 'stop-microphone'));
  await event('finished', envelope);
  const commit = latest('request', 'commit-terminal-draft');
  await reply(commit);
  return commit;
}
async function cancel() { await action('cancel'); await reply(latest('request', 'stop-microphone')); }

const beforeMic = count('start-microphone');
const first = await start({ ready: false });
ok('preparation binds the live terminal and waits before opening the microphone', first.sessionId === 'S' && count('start-microphone') === beforeMic);
await event('status', { ...first, state: 'ready' });
await reply(latest('request', 'start-microphone'), { sampleRate: 16000 });
const pcm = new Int16Array(2560); pcm.fill(1200);
await emit({ type: 'microphone-data', buffer: pcm.buffer });
ok('microphone frames stream immediately without a pause or final utterance', latest('send', 'audio')?.data.audio === Buffer.from(pcm.buffer).toString('base64'));
await text(first, 1, 'write');
ok('partial text is visible while the microphone is still running', latest('terminal-composition-update').patch.draft === 'write' && count('stop-microphone') === 0);
await text(first, 2, 'Write this.');
ok('revised text replaces the partial without duplication', latest('terminal-composition-update').patch.draft === 'Write this.');
await text(first, 1, 'old'); await text({ ...first, streamId: 'different' }, 9, 'foreign');
ok('old revisions and other streams cannot replace the draft', latest('terminal-composition-update').patch.draft === 'Write this.');
const literal = 'send message cancel recording pause dictation start dictation resume dictation new paragraph new line microphone off';
await text(first, 3, literal);
ok('former spoken commands stay literal and never act', latest('terminal-composition-update').patch.draft === literal && count('stop-microphone') === 0 && count('commit-terminal-draft') === 0);
ok('the hint describes the active shortcut', latest('terminal-composition-update').patch.hint.includes('F4'));
const beforeCommit = count('commit-terminal-draft');
await toggle();
const beforeTail = sent.filter((m) => m.type === 'send' && m.event === 'audio').length;
await emit({ type: 'microphone-data', buffer: new ArrayBuffer(64) });
ok('the final microphone frame is forwarded while Stop is draining', sent.filter((m) => m.type === 'send' && m.event === 'audio').length === beforeTail + 1);
await reply(latest('request', 'stop-microphone'));
ok('stopping asks the streaming model to finish and waits', latest('send', 'finish').data.streamId === first.streamId && count('commit-terminal-draft') === beforeCommit);
await text(first, 4, literal + ' last words');
ok('late final words update the draft before pasting', latest('terminal-composition-update').patch.draft.endsWith('last words') && count('commit-terminal-draft') === beforeCommit);
await event('finished', first);
const pasted = latest('request', 'commit-terminal-draft');
ok('F4 pastes all final words without sending', pasted.text === literal + ' last words. ' && pasted.options.submit === false && pasted.options.sessionId === 'S');
await reply(pasted);
ok('stopping closes the composition', !!latest('terminal-composition-close'));

const warmCount = count('start-microphone');
const warm = await start({ ready: false });
ok('even a warm start waits for its new streaming connection', count('start-microphone') === warmCount);
await event('status', { ...warm, state: 'ready' }); await reply(latest('request', 'start-microphone'));
await text(warm, 1, 'discard me');
const cancelledCount = count('commit-terminal-draft');
await cancel(); await text(warm, 2, 'late words');
ok('Cancel closes capture and discards late results', count('commit-terminal-draft') === cancelledCount && latest('send', 'cancel').data.streamId === warm.streamId);

const stopStream = await start(); await text(stopStream, 1, 'Paste this.');
const stopped = await finish(stopStream, 'stop');
ok('Stop pastes without submitting', stopped.text === 'Paste this.' && stopped.options.submit === false);
const sendStream = await start(); await text(sendStream, 1, 'Send this.');
const submitted = await finish(sendStream, 'send');
ok('the explicit Send button submits the final text', submitted.text === 'Send this.' && submitted.options.submit === true);

const loading = await start({ ready: false });
const beforeLateReady = count('start-microphone');
await action('cancel');
await event('status', { ...loading, state: 'ready' });
ok('cancelling preparation prevents a late ready event opening the microphone', count('start-microphone') === beforeLateReady && latest('send', 'cancel').data.streamId === loading.streamId);

const failureStream = await start(); await text(failureStream, 1, 'Keep these words.');
await event('error', { ...failureStream, body: 'Connection failed' });
await reply(latest('request', 'stop-microphone'));
ok('recognition errors turn off capture and keep visible text', latest('terminal-composition-update').patch.state === 'error' && latest('terminal-composition-update').patch.draft === 'Keep these words.');
await action('stop'); await tick();
const rescued = latest('request', 'commit-terminal-draft');
ok('the user can paste retained words after an error', rescued.text === 'Keep these words.' && rescued.options.submit === false);
await reply(rescued);

const interrupted = await start(); await text(interrupted, 1, 'Do not send.');
await action('send'); await reply(latest('request', 'stop-microphone'));
const beforeInterrupted = count('commit-terminal-draft');
await action('cancel'); await event('finished', interrupted);
ok('Cancel while final words are pending prevents Send from submitting', count('commit-terminal-draft') === beforeInterrupted);

shortcut = 'F6';
await emit({ type: 'settings', settings: { values: { shortcut, device: 'auto' }, configured: { shortcut: true } } });
const changed = await start();
ok('a changed shortcut registers and appears in the live hint', latest('register-hotkey').combo === 'F6' && latest('terminal-composition-update').patch.hint.includes('F6'));
await cancel();
await emit({ type: 'shutdown' });
console.log(`\n${checks.filter(Boolean).length}/${checks.length} Dictation checks passed`);
if (checks.some((pass) => !pass)) process.exitCode = 1;
