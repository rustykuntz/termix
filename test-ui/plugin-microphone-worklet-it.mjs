// Drive the real AudioWorklet processor: stereo floats become one little-endian PCM16 100 ms chunk.
let Processor = null, posted = null; const messages = [];
globalThis.AudioWorkletProcessor = class { constructor() { this.port = { postMessage(message, transfer) { posted = { message, transfer }; messages.push(posted); } }; } };
globalThis.registerProcessor = (name, type) => { if (name === "clideck-pcm16") Processor = type; };
await import("../public/js/plugin-microphone-worklet.js?test=" + Date.now());

const p = new Processor();
for (let frame = 0; frame < 13; frame++) {
  const size = frame === 12 ? 64 : 128;
  p.process([[new Float32Array(size).fill(1), new Float32Array(size).fill(0)]]);
}
const pcm = posted && new Int16Array(posted.message.buffer);
const checks = [
  ["worklet registered under the host contract", typeof Processor === "function"],
  ["100 ms becomes one 1600-sample transferable chunk", pcm?.length === 1600 && posted.transfer?.[0] === posted.message.buffer],
  ["channels are averaged and encoded as signed PCM16", pcm?.[0] === 16384 && pcm?.[1599] === 16384],
];
p.process([[new Float32Array(128).fill(-0.5)]]);
p.port.onmessage({ data: { type: "flush" } });
const tail = messages.at(-2);
checks.push(["Stop delivers the last short frame before acknowledging flush", tail.message.type === "pcm" && new Int16Array(tail.message.buffer).length === 128 && new Int16Array(tail.message.buffer)[127] === -16384 && messages.at(-1).message.type === "flushed"]);
const count = messages.length;
p.process([[new Float32Array(1600).fill(0.5)]]);
checks.push(["no additional recording follows the flush", messages.length === count]);
for (const [name, pass] of checks) console.log((pass ? "  ok   " : "  FAIL ") + name);
if (checks.some(([, pass]) => !pass)) process.exitCode = 1;
else console.log(`\n${checks.length}/${checks.length} microphone worklet checks passed`);
