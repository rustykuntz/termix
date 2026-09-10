// Host-owned microphone encoder: the AudioContext is fixed at 16 kHz, so each input sample maps directly
// to one little-endian signed PCM16 sample. Channels are averaged to mono and emitted in bounded 100ms chunks.
const CHUNK_SAMPLES = 1600;

class CliDeckPcm16Processor extends AudioWorkletProcessor {
  constructor() {
    super(); this.chunk = new Int16Array(CHUNK_SAMPLES); this.offset = 0; this.finished = false;
    this.port.onmessage = (event) => {
      if (event.data?.type !== "flush") return;
      this.finished = true;
      if (this.offset) {
        const buffer = this.chunk.slice(0, this.offset).buffer;
        this.port.postMessage({ type: "pcm", buffer }, [buffer]);
        this.offset = 0;
      }
      this.port.postMessage({ type: "flushed" });
    };
  }
  process(inputs) {
    if (this.finished) return true;
    const channels = inputs[0];
    if (!channels || !channels.length || !channels[0]) return true;
    const length = channels[0].length;
    for (let i = 0; i < length; i++) {
      let sample = 0;
      for (let channel = 0; channel < channels.length; channel++) sample += channels[channel][i] || 0;
      sample = Math.max(-1, Math.min(1, sample / channels.length));
      this.chunk[this.offset++] = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);
      if (this.offset === CHUNK_SAMPLES) {
        const buffer = this.chunk.buffer;
        this.port.postMessage({ type: "pcm", buffer }, [buffer]);
        this.chunk = new Int16Array(CHUNK_SAMPLES); this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor("clideck-pcm16", CliDeckPcm16Processor);
