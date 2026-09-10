const { randomUUID } = require('crypto');
const { spawn } = require('child_process');
const net = require('net');
const WebSocket = require('ws');
const { setTimeout: delay } = require('timers/promises');
const { ensureAssets } = require('./native-assets');

const MAX_AUDIO_BYTES = 16_000 * 2 * 60 * 5;
const MAX_TEXT = 16_000;

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

class RecognitionStream {
  constructor(url, token, onText, onError) {
    this.onText = onText;
    this.onError = onError;
    this.finals = '';
    this.partial = '';
    this.bytes = 0;
    this.closed = false;
    this.finishing = false;
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.socket = new WebSocket(`${url.replace('http:', 'ws:')}/v1/realtime`, {
      headers: { Authorization: `Bearer ${token}` }, maxPayload: 128 * 1024,
    });
    this.armTimeout(15_000, 'Speech connection timed out.');
    this.socket.on('message', (raw) => {
      if (this.closed) return;
      try { this.receive(JSON.parse(raw)); }
      catch (error) { this.fail(error); }
    });
    this.socket.on('error', (error) => this.fail(error));
    this.socket.on('close', () => this.fail(new Error('Speech connection closed. Try dictating again.')));
  }

  armTimeout(ms, message) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fail(new Error(message)), ms);
    this.timer.unref?.();
  }

  receive(event) {
    if (event.type === 'session.created') {
      this.socket.send(JSON.stringify({ type: 'session.update', session: {
        sample_rate: 16000, language: 'en-US', automatic_punctuation: true,
      } }));
    } else if (event.type === 'session.updated') {
      this.resolveReady();
      this.armTimeout(90_000, 'Microphone stopped sending audio. Try dictating again.');
    } else if (event.type === 'conversation.item.input_audio_transcription.delta') {
      this.partial += String(event.delta || '');
      this.publish();
    } else if (event.type === 'conversation.item.input_audio_transcription.completed') {
      // A final replaces the current partial, which can contain revised spelling/punctuation.
      this.finals = [this.finals, String(event.transcript || '').trim()].filter(Boolean).join(' ');
      this.partial = '';
      this.publish();
    } else if (event.type === 'input_audio_buffer.committed' && this.finishing) {
      this.resolveFinish?.();
      this.close();
    } else if (event.type === 'error') {
      this.fail(new Error(event.error?.message || 'Speech recognition failed.'));
    }
  }

  publish() {
    const text = [this.finals, this.partial.trim()].filter(Boolean).join(' ');
    if (text.length > MAX_TEXT) throw new Error('Dictation is full. Stop and paste this message before continuing.');
    if (text !== this.lastText) { this.lastText = text; this.onText(text); }
  }

  push(audio) {
    if (this.closed || this.finishing) throw new Error('This dictation has ended.');
    if (this.bytes + audio.length > MAX_AUDIO_BYTES) throw new Error('Dictation is limited to five minutes per message.');
    if (this.socket.bufferedAmount > 2 * 1024 * 1024) throw new Error('Speech recognition cannot keep up. Stop and try a shorter message.');
    this.bytes += audio.length;
    this.socket.send(audio);
    this.armTimeout(90_000, 'Microphone stopped sending audio. Try dictating again.');
  }

  finish() {
    if (this.finishPromise) return this.finishPromise;
    if (this.closed) return Promise.reject(new Error('This dictation has ended.'));
    this.finishing = true;
    this.finishPromise = new Promise((resolve, reject) => { this.resolveFinish = resolve; this.rejectFinish = reject; });
    this.armTimeout(60_000, 'Finishing speech recognition timed out.');
    this.socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    return this.finishPromise;
  }

  fail(error) {
    if (this.closed) return;
    this.rejectReady(error);
    this.rejectFinish?.(error);
    this.close();
    this.onError(error);
  }

  cancel() {
    if (this.closed) return;
    const error = new Error('Dictation cancelled.');
    this.rejectReady(error);
    this.rejectFinish?.(error);
    this.close();
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.socket.terminate();
  }
}

class SpeechRuntime {
  constructor(options) {
    this.dataDir = options.dataDir;
    this.device = options.device || 'auto';
    this.onStatus = options.onStatus || (() => {});
    this.ensureAssets = options.ensureAssets || ensureAssets;
    this.controller = new AbortController();
    this.streams = new Set();
    this.worker = null;
    this.startPromise = null;
    this.token = randomUUID();
  }

  start() {
    if (!this.startPromise) {
      this.startPromise = this.startWorker().catch((error) => { this.startPromise = null; throw error; });
    }
    return this.startPromise;
  }

  async startWorker() {
    const signal = this.controller.signal;
    const assets = await this.ensureAssets(this.dataDir, this.device, signal, (body) => this.onStatus(body));
    signal.throwIfAborted();
    this.onStatus('Loading Nemotron streaming speech locally…');
    const port = await freePort();
    signal.throwIfAborted();
    this.url = `http://127.0.0.1:${port}`;
    const child = spawn(assets.binary, ['serve', '--asr-model', assets.model,
      '--host', '127.0.0.1', '--port', String(port), '--no-ui',
      '--asr.backend.gpu', assets.metal ? '0' : '-1',
      '--asr.batching.enabled=false', '--asr.streaming.rnnt_right_context', '3',
      '--asr.endpointing.enable=true'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NEMO_SPEECH_HTTP_API_KEY: this.token },
    });
    this.worker = child;
    let failure = null;
    let lastLog = '';
    child.stdout.resume();
    child.stderr.on('data', (chunk) => { lastLog = (lastLog + chunk.toString()).slice(-2000); });
    child.once('error', (error) => { failure = error; });
    child.once('close', () => {
      failure ||= new Error(`Speech runtime stopped. ${lastLog.trim().split('\n').at(-1) || ''}`);
      if (this.worker === child) {
        this.worker = null;
        this.startPromise = null;
        for (const stream of this.streams) stream.fail(failure);
        this.streams.clear();
      }
    });
    try {
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        signal.throwIfAborted();
        if (failure) throw failure;
        try {
          const response = await fetch(`${this.url}/ready`, { signal: AbortSignal.timeout(1000) });
          if (response.ok && (await response.json()).ready === true) return;
        } catch {}
        await delay(250, undefined, { signal });
      }
      throw new Error('Loading the speech model timed out.');
    } catch (error) { child.kill(); throw error; }
  }

  async openStream(onText, onError) {
    await this.start();
    this.controller.signal.throwIfAborted();
    const stream = new RecognitionStream(this.url, this.token, onText, onError);
    this.streams.add(stream);
    stream.socket.once('close', () => this.streams.delete(stream));
    await stream.ready;
    return stream;
  }

  stop() {
    this.controller.abort();
    for (const stream of this.streams) stream.cancel();
    this.streams.clear();
    this.worker?.kill();
    this.worker = null;
    this.startPromise = null;
  }
}

module.exports = { SpeechRuntime, RecognitionStream, MAX_AUDIO_BYTES };
