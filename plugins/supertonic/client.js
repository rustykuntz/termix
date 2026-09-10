const MODEL_REVISION = '3cadd1ee6394adea1bd021217a0e650ede09a323';
const MODEL_ROOT = `https://huggingface.co/Supertone/supertonic-3/resolve/${MODEL_REVISION}`;
const MODEL_FILES = Object.freeze([
  'tts.json', 'unicode_indexer.json', 'duration_predictor.onnx',
  'text_encoder.onnx', 'vector_estimator.onnx', 'vocoder.onnx',
]);
const CACHE_NAME = `clideck-supertonic-${MODEL_REVISION}`;
const LEXICON_URL = new URL('./public/tts_normalization_lexicon.txt', import.meta.url);
const VOICE_STYLE_URLS = Object.freeze({
  'female-1': new URL('./public/voices/female-1.json', import.meta.url),
  'female-2': new URL('./public/voices/female-2.json', import.meta.url),
  yara: new URL('./public/voices/yara.json', import.meta.url),
  mike: new URL('./public/voices/mike.json', import.meta.url),
  dov: new URL('./public/voices/dov.json', import.meta.url),
});
const PLAYBACK_CHARS = 1_200;
const MAX_AUDIO_BYTES = 64 * 1024 * 1024;
const MAX_WAV_SAMPLES = Math.floor((MAX_AUDIO_BYTES - 44) / 2);
const DEFAULTS = Object.freeze({
  voice: 'female-2', shortcut: 'F5', language: 'en', normalization: 'english', quality: 12, autoRead: false,
});

let preferences = { ...DEFAULTS };
let runtimePromise = null;
let lexiconPromise = null;
let reading = null;
let synthesisQueue = Promise.resolve();
let sequence = 0;
let speechCache = null;

async function normalizedText(text, normalization) {
  const normalizer = await import('./public/tts-normalizer.js');
  if (normalization !== 'english') return normalizer.normalizeTextWithRanges(text, [], 'off');
  if (!lexiconPromise) {
    lexiconPromise = fetch(LEXICON_URL).then((response) => {
      if (!response.ok) throw new Error('Could not load the speech lexicon.');
      return response.text();
    }).then(source => normalizer.parseLexicon(source)).catch(() => null);
  }
  const lexicon = await lexiconPromise;
  return normalizer.normalizeTextWithRanges(text, lexicon || [], lexicon ? normalization : 'off');
}

function progress(api, body, kind = 'info') {
  api.toast(kind, {
    id: 'supertonic-progress',
    title: 'Supertonic Voice',
    body,
    duration: kind === 'success' ? 3500 : 0,
  });
}

async function cachedUrl(path) {
  const remote = `${MODEL_ROOT}/${path}`;
  if (typeof caches === 'undefined') return { url: remote, release() {} };
  const cache = await caches.open(CACHE_NAME);
  let response = await cache.match(remote);
  if (!response) {
    const download = await fetch(remote);
    if (!download.ok) throw new Error(`Could not download ${path.split('/').pop()}.`);
    try {
      await cache.put(remote, download);
      response = await cache.match(remote);
    } catch {
      return { url: remote, release() {} };
    }
  }
  const url = URL.createObjectURL(await response.blob());
  return { url, release: () => URL.revokeObjectURL(url) };
}

async function modelAssets() {
  const loaded = [];
  const assets = {};
  try {
    for (let index = 0; index < MODEL_FILES.length; index += 1) {
      const name = MODEL_FILES[index];
      const asset = await cachedUrl(`onnx/${name}`);
      loaded.push(asset);
      assets[name] = asset.url;
    }
    return { assets, release: () => loaded.forEach((asset) => asset.release()) };
  } catch (error) {
    loaded.forEach((asset) => asset.release());
    throw error;
  }
}

async function runtime(api) {
  if (!runtimePromise) {
    progress(api, 'Loading the private voice model (~380 MB on first use)…');
    runtimePromise = import('./public/helper.js').then(async (helper) => {
      let result;
      const local = await modelAssets();
      try {
        try {
          result = await helper.loadTextToSpeech(`${MODEL_ROOT}/onnx`, {
            executionProviders: ['webgpu'],
            graphOptimizationLevel: 'all',
          }, null, local.assets);
          result.backend = 'WebGPU';
        } catch {
          result = await helper.loadTextToSpeech(`${MODEL_ROOT}/onnx`, {
            executionProviders: ['wasm'],
            graphOptimizationLevel: 'all',
          }, null, local.assets);
          result.backend = 'WASM';
        }
      } finally {
        local.release();
      }
      progress(api, `Voice model ready with ${result.backend}.`, 'success');
      return { helper, ...result, styles: new Map() };
    }).catch((error) => {
      runtimePromise = null;
      throw error;
    });
  }
  return runtimePromise;
}

async function voiceStyle(engine, voice) {
  const id = Object.hasOwn(VOICE_STYLE_URLS, voice) ? voice : DEFAULTS.voice;
  if (!engine.styles.has(id)) {
    engine.styles.set(id, engine.helper.loadVoiceStyle([VOICE_STYLE_URLS[id].href]));
  }
  return engine.styles.get(id);
}

function speechKey(text, settings) {
  return JSON.stringify([
    text, settings.voice, settings.language,
    settings.normalization, settings.quality,
  ]);
}

function targetKey(target) {
  return JSON.stringify([target?.surface, target?.sessionId, target?.contentId, target?.anchor,
    target?.sourceOffset ?? (target?.surface === 'terminal' ? 0 : null)]);
}

function audioOptions(cache) {
  const target = cache.target;
  return {
    mime: 'audio/wav',
    title: 'Supertonic Voice',
    text: cache.sourceText,
    ...(target?.surface && target.sessionId ? {
      readAlong: {
        ...target,
        sessionId: target.sessionId,
        sourceText: cache.sourceText,
        cues: cache.cues,
        timing: 'estimated',
        ...(target.anchor ? { anchor: target.anchor } : {}),
      },
    } : {}),
  };
}

function playCached(api, target) {
  if (!speechCache) return false;
  speechCache.target = target;
  api.playAudio(speechCache.wav.slice(0), audioOptions(speechCache));
  return true;
}

async function toggleCached(api, key = '', target) {
  if (key && speechCache?.key !== key) return false;
  if (key && targetKey(target) !== targetKey(speechCache?.target)) return playCached(api, target);
  try {
    if (await api.toggleAudio?.()) return true;
  } catch {}
  return playCached(api, key ? target : speechCache?.target);
}

async function synthesize(engine, sourceText, settings, style, cancelled = () => false) {
  const { estimateReadAlongCues } = await import('./public/read-along-timing.js');
  const sampleRate = engine.textToSpeech.sampleRate;
  const silenceSamples = Math.floor(0.3 * sampleRate);
  const maxLen = settings.language === 'ko' || settings.language === 'ja' ? 120 : 300;
  const chunks = engine.helper.chunkTextRanges(sourceText, maxLen);
  const parts = [];
  const cues = [];
  let sampleCount = 0;
  for (const chunk of chunks) {
    if (cancelled()) throw new Error('Reading cancelled.');
    const source = sourceText.slice(chunk.start, chunk.end);
    const normalized = await normalizedText(source, settings.normalization);
    const gap = parts.length ? silenceSamples : 0;
    const result = await engine.textToSpeech.call(
      normalized.text,
      settings.language,
      style,
      settings.quality,
      1,
      0.3,
      null,
      MAX_WAV_SAMPLES - sampleCount - gap,
    );
    if (cancelled()) throw new Error('Reading cancelled.');
    const length = Math.min(result.wav.length, Math.floor(sampleRate * result.duration[0]));
    if (sampleCount + gap + length > MAX_WAV_SAMPLES) {
      throw new Error('Speech is too long for the CliDeck audio player.');
    }
    if (gap) { parts.push(new Float32Array(gap)); sampleCount += gap; }
    const start = sampleCount / sampleRate;
    // Read-along timing is approximate. Keep it out of the waveform: inserting
    // silence at an estimated paragraph boundary can split a spoken word.
    parts.push(Float32Array.from(result.wav.slice(0, length)));
    sampleCount += length;
    const estimated = estimateReadAlongCues(source, normalized, start,
      sampleCount / sampleRate, chunk.start, settings.language);
    cues.push(...(estimated.length ? estimated : [{
      start, end: sampleCount / sampleRate, textStart: chunk.start, textEnd: chunk.end,
    }]));
  }

  const audio = new Float32Array(sampleCount);
  let offset = 0;
  for (const part of parts) { audio.set(part, offset); offset += part.length; }
  return { audio, cues };
}

async function speak(api, rawText, target) {
  const raw = String(rawText || '');
  const sourceText = raw.trim();
  if (!sourceText) return false;
  if (target?.surface === 'terminal' || Number.isInteger(target?.sourceOffset)) {
    target = { ...target, sourceOffset: (target.sourceOffset || 0) + raw.indexOf(sourceText) };
  }
  const settings = {
    voice: preferences.voice,
    language: preferences.language,
    normalization: preferences.normalization,
    quality: Math.round(preferences.quality),
  };
  const key = speechKey(sourceText, settings);
  if (reading?.key === key && targetKey(reading.target) === targetKey(target)) {
    try { if (await api.toggleAudio?.()) return true; } catch {}
    return false;
  }
  if (reading) { reading = null; api.stopAudio?.(); }
  if (speechCache?.key === key) return toggleCached(api, key, target);
  const job = { key, target, sequence: `supertonic-${Date.now()}-${++sequence}` };
  reading = job;
  const cancelled = () => reading !== job;
  try {
    const engine = await runtime(api);
    const style = await voiceStyle(engine, settings.voice);
    if (typeof api.playAudio !== 'function') throw new Error('This CliDeck build does not provide plugin audio playback.');
    const parts = engine.helper.chunkTextRanges(sourceText, PLAYBACK_CHARS);
    const long = parts.length > 1;
    if (long && typeof api.playAudioAndWait !== 'function') throw new Error('Refresh CliDeck to enable long-document reading.');
    const prepare = (part) => {
      const task = synthesisQueue.then(async () => {
        if (cancelled()) return null;
        const text = sourceText.slice(part.start, part.end);
        const result = await synthesize(engine, text, settings, style, cancelled);
        return {
          key, sourceText: text, cues: result.cues,
          wav: engine.helper.writeWavFile(result.audio, engine.textToSpeech.sampleRate),
          target: target && {
            ...target,
            ...((Number.isInteger(target.sourceOffset) || target.surface === 'terminal')
              && { sourceOffset: (target.sourceOffset || 0) + part.start }),
          },
        };
      });
      // Prefetch errors are observed immediately, even while the previous clip is paused for hours.
      synthesisQueue = task.catch(() => {});
      return task.then(value => ({ value }), error => ({ error }));
    };
    speechCache = null;
    let pending = prepare(parts[0]);
    for (let index = 0; index < parts.length; index++) {
      const result = await pending;
      if (cancelled()) return false;
      if (result.error) throw result.error;
      const clip = result.value;
      if (!long) {
        speechCache = { ...clip, wav: clip.wav.slice(0) };
        api.playAudio(clip.wav, audioOptions(clip));
        return true;
      }
      // At most the playing clip and ONE prepared clip; never accumulate a document's audio in memory.
      if (index + 1 < parts.length) pending = prepare(parts[index + 1]);
      if (!await api.playAudioAndWait(clip.wav, { ...audioOptions(clip), sequence: job.sequence })) return false;
    }
    api.stopAudio?.();
    return true;
  } catch (error) {
    if (!cancelled()) { api.stopAudio?.(); progress(api, error?.message || String(error), 'error'); }
    return false;
  } finally {
    if (!cancelled()) reading = null;
  }
}

async function readDocument(api, context) {
  const content = context?.content;
  if (!['html', 'markdown', 'text'].includes(content?.kind)) return false;
  try {
    const viewer = await api.getActiveViewerText();
    if (viewer?.id !== content.id) return false;
    warnTruncated(api, viewer.truncated);
    return speak(api, viewer.text, {
      surface: 'viewer', sessionId: viewer.sessionId || context.session?.id, contentId: content.id, sourceOffset: 0,
    });
  } catch (error) {
    progress(api, error?.message || String(error), 'error');
    return false;
  }
}

function warnTruncated(api, truncated) {
  if (truncated) api.toast('info', {
    title: 'Supertonic Voice',
    body: 'This exceeds the preview text limit. Only the available beginning will be read.',
    duration: 10000,
  });
}

export async function activate(api) {
  const cleanups = [];
  let removeHotkey = null;
  const bindHotkey = () => {
    removeHotkey?.(); removeHotkey = null;
    if (!preferences.shortcut) return;
    removeHotkey = api.registerHotkey(preferences.shortcut, async () => {
      const viewer = await api.getActiveViewerText();
      if (viewer) {
        const selected = Boolean(String(viewer.selection || '').trim());
        const text = selected ? viewer.selection : viewer.text;
        if (!String(text || '').trim()) {
          api.toast('info', { title: 'Supertonic Voice', body: 'This document has no readable text.' });
          return;
        }
        warnTruncated(api, selected ? viewer.selectionTruncated : viewer.truncated);
        const session = await api.getActiveSession();
        await speak(api, text, {
          surface: 'viewer', sessionId: viewer.sessionId || session?.id, contentId: viewer.id,
          ...(!selected ? { sourceOffset: 0 }
            : Number.isInteger(viewer.selectionOffset) && viewer.selectionOffset >= 0 ? { sourceOffset: viewer.selectionOffset } : {}),
        });
        return;
      }
      // A refreshed worker can run beside an older page host. Anchoring is optional: a rejected host
      // request must fall back to the established selection API rather than abort the reader shortcut.
      let snapshot = null;
      try { snapshot = await api.getTerminalSelectionSnapshot?.(); } catch {}
      const selection = snapshot?.text ?? await api.getTerminalSelection();
      if (!String(selection || '').trim()) {
        if (await toggleCached(api)) return;
        api.toast('info', { title: 'Supertonic Voice', body: 'Select terminal text to read aloud.' });
        return;
      }
      const session = await api.getActiveSession();
      await speak(api, selection, {
        surface: 'terminal', sessionId: snapshot?.sessionId || session?.id, anchor: snapshot?.anchor,
      });
    });
  };
  cleanups.push(api.onMessage('settings', (value) => {
    preferences = { ...DEFAULTS, ...(value || {}) };
    bindHotkey();
  }));
  cleanups.push(api.onMessage('speak', async (value) => {
    const session = await api.getActiveSession();
    if (value?.sessionId && value.sessionId !== session?.id) return;
    await speak(api, value?.text, { surface: 'terminal', sessionId: value?.sessionId });
  }));
  cleanups.push(api.registerAction({
    id: 'read-selection',
    label: 'Read selection aloud',
    icon: 'waveform',
    description: 'Speak the selected text locally with Supertonic.',
    placements: ['terminal.context', 'viewer.context'],
    when: (context) => Boolean(context?.selection?.text?.trim()),
    run: (context) => speak(api, context?.selection?.text, context?.surface === 'terminal'
      ? { surface: 'terminal', sessionId: context?.session?.id, anchor: context?.selection?.anchor }
      : {
        surface: 'viewer', sessionId: context?.session?.id, contentId: context?.content?.id,
        ...(Number.isInteger(context?.selection?.offset) && context.selection.offset >= 0 ? { sourceOffset: context.selection.offset } : {}),
      }),
  }));
  cleanups.push(api.registerAction({
    id: 'read-document',
    label: 'Read document aloud',
    icon: '≋',
    description: 'Speak this text, Markdown, or HTML document locally with Supertonic.',
    placements: ['viewer.context'],
    when: (context) => ['html', 'markdown', 'text'].includes(context?.content?.kind),
    run: (context) => readDocument(api, context),
  }));
  api.send('ready', null);
  return () => {
    removeHotkey?.();
    reading = null;
    speechCache = null;
    for (const cleanup of cleanups) cleanup?.();
    api.stopAudio?.();
  };
}
