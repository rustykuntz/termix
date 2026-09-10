// Generic microphone host: one owner, 16 kHz mono PCM, transferable chunks and deterministic teardown.
import { installFakeDom } from "./fakedom.mjs";
installFakeDom();

const tracks = [];
function makeTrack() {
  const listeners = new Map();
  const track = { stopped: false, stop() { this.stopped = true; }, addEventListener(type, fn) { listeners.set(type, fn); }, end() { listeners.get("ended")?.(); } };
  tracks.push(track); return track;
}
let getUserMediaError = null, lastConstraints = null;
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: { async getUserMedia(constraints) {
  lastConstraints = constraints; if (getUserMediaError) throw getUserMediaError;
  const track = makeTrack(); return { getTracks: () => [track] };
} } } });

const contexts = [], nodes = [];
let resumeError = null;
class FakeContext {
  constructor(options) { this.options = options; this.sampleRate = 16000; this.state = "suspended"; this.destination = {}; this.closed = false; contexts.push(this); this.audioWorklet = { addModule: async (url) => { this.moduleUrl = url; } }; }
  createMediaStreamSource() { return { connected: null, disconnected: false, connect: (node) => { this.sourceNode = node; }, disconnect() { this.disconnected = true; } }; }
  async resume() { if (resumeError) throw resumeError; this.resumed = true; this.state = "running"; }
  async close() { this.closed = true; }
}
class FakeWorkletNode {
  constructor(context, name, options) { this.context = context; this.name = name; this.options = options; this.port = { onmessage: null, postMessage: (event) => {
    if (event.type === "flush") queueMicrotask(() => {
      this.port.onmessage?.({ data: { type: "pcm", buffer: new ArrayBuffer(100) } });
      this.port.onmessage?.({ data: { type: "flushed" } });
    });
  } }; this.disconnected = false; nodes.push(this); }
  connect(target) { this.target = target; }
  disconnect() { this.disconnected = true; }
}
window.AudioContext = FakeContext; window.AudioWorkletNode = FakeWorkletNode;

const { startPluginMicrophone, stopPluginMicrophone, pluginMicrophoneOwner } = await import("../public/js/ui/plugin-microphone.js");
const checks = [];
const ok = (name, pass) => { checks.push([name, !!pass]); console.log((pass ? "  ok   " : "  FAIL ") + name); };

const data = [], states = [];
const info = await startPluginMicrophone("dictation-a", (buffer, meta) => data.push({ buffer, meta }), (state) => states.push(state));
ok("capture asks for one processed audio stream", lastConstraints?.audio.channelCount === 1 && lastConstraints.audio.noiseSuppression === true && lastConstraints.video === false);
ok("capture is exactly mono PCM16 at 16 kHz", info.sampleRate === 16000 && info.channels === 1 && info.format === "pcm-s16le" && contexts[0].options.sampleRate === 16000);
ok("the trusted host loads the dedicated worklet and resumes audio", contexts[0].moduleUrl === "/js/plugin-microphone-worklet.js" && contexts[0].resumed && nodes[0].name === "clideck-pcm16");
ok("listening state is explicit and owner is visible", states[0]?.state === "listening" && pluginMicrophoneOwner() === "dictation-a");

const chunk = new ArrayBuffer(3200); nodes[0].port.onmessage({ data: { type: "pcm", buffer: chunk } });
ok("bounded PCM chunks cross without transformation", data.length === 1 && data[0].buffer === chunk && data[0].meta === info);
let locked = ""; try { await startPluginMicrophone("dictation-b", () => {}); } catch (error) { locked = error.message; }
ok("a second plugin cannot take microphone ownership", /already in use/.test(locked) && pluginMicrophoneOwner() === "dictation-a");

ok("owner can stop capture", await stopPluginMicrophone("dictation-a") === true);
ok("Stop delivers the final short frame before resolving", data.length === 2 && data.at(-1).buffer.byteLength === 100);
ok("stop tears down every browser resource", tracks[0].stopped && nodes[0].disconnected && contexts[0].closed && states.at(-1)?.state === "stopped" && !pluginMicrophoneOwner());

getUserMediaError = Object.assign(new Error("blocked"), { name: "NotAllowedError" });
let denied = ""; try { await startPluginMicrophone("dictation-a", () => {}); } catch (error) { denied = error.message; }
ok("permission failure is concise and leaves no owner", /permission was denied/.test(denied) && !pluginMicrophoneOwner());
getUserMediaError = null; resumeError = new Error("resume failed");
let resumeFailed = ""; try { await startPluginMicrophone("dictation-a", () => {}); } catch (error) { resumeFailed = error.message; }
ok("a failed AudioContext resume releases microphone ownership", /resume failed/.test(resumeFailed) && !pluginMicrophoneOwner() && tracks.at(-1).stopped && contexts.at(-1).closed);
resumeError = null;

getUserMediaError = null;
let releasePermission;
navigator.mediaDevices.getUserMedia = () => new Promise((resolve) => { releasePermission = () => { const track = makeTrack(); resolve({ getTracks: () => [track] }); }; });
const late = startPluginMicrophone("dictation-a", () => {});
ok("teardown can cancel a still-pending permission prompt", await stopPluginMicrophone("dictation-a") === true);
releasePermission(); let cancelled = ""; try { await late; } catch (error) { cancelled = error.message; }
ok("a late permission grant cannot resurrect a stopped plugin", /cancelled/.test(cancelled) && !pluginMicrophoneOwner() && tracks.at(-1).stopped && contexts.at(-1).closed);

if (checks.some(([, pass]) => !pass)) process.exitCode = 1;
else console.log(`\n${checks.length}/${checks.length} microphone host checks passed`);
