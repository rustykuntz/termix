import { installFakeDom } from "./fakedom.mjs";
installFakeDom();
const audios = [];
class FakeAudio {
  constructor() { this.paused = true; this.currentTime = 0; this.duration = 12; this.ended = false; this.playbackRate = 1; this._on = {}; audios.push(this); }
  _fire(type) { for (const fn of this._on[type] || []) fn(); }
  addEventListener(type, fn) { (this._on[type] || (this._on[type] = [])).push(fn); }
  async play() { this.paused = false; }
  pause() { this.paused = true; }
  removeAttribute() {} load() {}
}
globalThis.Audio = FakeAudio;
URL.createObjectURL = () => "blob:audio"; URL.revokeObjectURL = () => {};
const checks = [];
const sleep = (ms = 0) => new Promise((r) => setTimeout(r, ms));
function ok(name, pass) { checks.push([name, !!pass]); console.log((pass ? "  ok   " : "  FAIL ") + name); }

const { playPluginAudio, playPluginAudioAndWait, stopPluginAudio, togglePluginAudio, __audioStateForTest } = await import("../public/js/ui/plugin-audio.js");
const { registerReadAlongSurface } = await import("../public/js/ui/read-along.js");
await playPluginAudio("voice", new ArrayBuffer(8), { title: "Speech" });
audios[0].currentTime = 4;
ok("plugin toggle pauses the current clip without replacing it", togglePluginAudio("voice") && audios[0].paused && audios.length === 1 && audios[0].currentTime === 4);
ok("plugin toggle resumes the same clip from its position", togglePluginAudio("voice") && !audios[0].paused && audios.length === 1 && audios[0].currentTime === 4);
ok("a plugin cannot toggle another plugin's audio", togglePluginAudio("other") === false && !audios[0].paused);
const button = document.querySelector(".plugin-audio-rate");
ok("speed is a compact native keyboard button with a current-value label", button?.tag === "button" && button.type === "button" && button.textContent === "1×" && /Playback speed 1×/.test(button.getAttribute("aria-label") || ""));
for (const [label, rate] of [["1.1×", 1.1], ["1.25×", 1.25], ["1.5×", 1.5], ["1×", 1]]) {
  button._fire("click");
  ok("speed cycles to " + label + " and applies immediately", button.textContent === label && audios[0].playbackRate === rate && button.title === "Playback speed: " + label && button.getAttribute("aria-label").includes(label));
}
button._fire("click"); button._fire("click");
await playPluginAudio("voice", new ArrayBuffer(8), { title: "Next speech" });
ok("the in-page player rate carries to the next clip without global persistence", audios[1].playbackRate === 1.25 && button.textContent === "1.25×");
stopPluginAudio();

// ── Read-along rides the same player, and only ever from the clock ───────────────────────────────────────
const marks = [];
registerReadAlongSurface("terminal", (meta) => {
  marks.push(["resolve", meta.sessionId]);
  return { show: (i) => marks.push(["show", i]), clear: () => marks.push(["clear"]), dispose: () => marks.push(["dispose"]) };
});
const readAlong = { surface: "terminal", sessionId: "s1", sourceText: "one two. three four.", cues: [
  { start: 0, end: 1, textStart: 0, textEnd: 8 }, { start: 1.3, end: 2.4, textStart: 9, textEnd: 20 }] };
await playPluginAudio("voice", new ArrayBuffer(8), { title: "Speech", readAlong });
const clip = audios[audios.length - 1];
const tick = (at, event = "timeupdate") => { clip.currentTime = at; for (const fn of clip._on[event] || []) fn(); };
ok("the source is resolved once, up front, before a note plays", marks.filter(([kind]) => kind === "resolve").length === 1);
tick(0.4);
ok("the clock lights the chunk being spoken", JSON.stringify(marks.slice(-1)) === JSON.stringify([["show", 0]]));
tick(1.5);
ok("the next chunk follows the audio, not a guess", JSON.stringify(marks.slice(-1)) === JSON.stringify([["show", 1]]));
marks.length = 0; togglePluginAudio("voice");
ok("pausing the player clears the highlight", JSON.stringify(marks) === JSON.stringify([["clear"]]));
marks.length = 0; togglePluginAudio("voice"); await new Promise((r) => setTimeout(r, 0));   // resume repaints from play()'s promise
ok("resuming restores it", JSON.stringify(marks) === JSON.stringify([["show", 1]]));
marks.length = 0; tick(0.2, "seeked");
ok("scrubbing moves the highlight from audio.currentTime", JSON.stringify(marks) === JSON.stringify([["show", 0]]));
marks.length = 0; stopPluginAudio();
ok("stopping the clip retires the surface", JSON.stringify(marks) === JSON.stringify([["dispose"]]));
marks.length = 0;
await playPluginAudio("voice", new ArrayBuffer(8), { title: "Plain speech" });
for (const fn of audios[audios.length - 1]._on.timeupdate || []) fn();
ok("audio with no timeline never touches a surface", marks.length === 0);
stopPluginAudio();
ok("the player shows no read-along controls or labels of its own", !document.querySelector(".plugin-audio [class*=read-along]"));

// ── a long read is a run of clips, and Stop must reach the ones that have not started ───────────────────
const fire = (audio, event) => { for (const fn of audio._on[event] || []) fn(); };
const latest = () => audios[audios.length - 1];

let settled = null;
let waiting = playPluginAudioAndWait("voice", new ArrayBuffer(8), { title: "Part 1", sequence: "read-1" });
waiting.then((value) => { settled = value; });
await sleep();
ok("a waiting clip plays like any other", __audioStateForTest().clip?.pluginId === "voice" && settled === null);
fire(latest(), "ended");
await sleep();
ok("its promise answers TRUE when the clip reaches its natural end", settled === true);
// The gap: nothing is playing, but the read is not over — so the transport stays up and Stop still means stop.
ok("and the transport stays on screen between parts, with Stop still there",
  __audioStateForTest().playerHidden === false && __audioStateForTest().sequence === "read-1");

settled = null;
waiting = playPluginAudioAndWait("voice", new ArrayBuffer(8), { title: "Part 2", sequence: "read-1" });
waiting.then((value) => { settled = value; });
await sleep();
stopPluginAudio();
await sleep();
ok("stopping a part answers FALSE", settled === false);
ok("and the transport goes away with the read", __audioStateForTest().playerHidden === true && __audioStateForTest().sequence === "");

const before = audios.length;
ok("a part of a read the user already stopped is REFUSED, and never plays a note",
  (await playPluginAudioAndWait("voice", new ArrayBuffer(8), { title: "Part 3", sequence: "read-1" })) === false
  && audios.length === before);
ok("while a NEW read is never refused by the old one's cancellation",
  typeof (await Promise.race([
    playPluginAudioAndWait("voice", new ArrayBuffer(8), { title: "Fresh", sequence: "read-2" }).then(() => "settled"),
    sleep(5).then(() => "playing"),
  ])) === "string" && audios.length === before + 1);
stopPluginAudio();
await sleep();

// Stop pressed BETWEEN parts is the case a completion promise alone cannot see.
settled = null;
playPluginAudioAndWait("voice", new ArrayBuffer(8), { title: "Part 1", sequence: "read-3" }).then((v) => { settled = v; });
await sleep();
fire(latest(), "ended");
await sleep();
ok("a part that ended naturally leaves the read alive", settled === true && __audioStateForTest().sequence === "read-3");
stopPluginAudio();
const dead = () => __audioStateForTest().cancelled.map(([plugin, id]) => plugin + ":" + id);
ok("Stop in the gap cancels the read itself", __audioStateForTest().sequence === "" && dead().includes("voice:read-3"));
ok("so the part that was being prepared is refused when it arrives",
  (await playPluginAudioAndWait("voice", new ArrayBuffer(8), { title: "Part 2", sequence: "read-3" })) === false);

const last = audios.length;
settled = null;
playPluginAudioAndWait("voice", new ArrayBuffer(8), { title: "Only part", sequence: "read-4" }).then((v) => { settled = v; });
await sleep();
fire(audios[audios.length - 1], "ended");
await sleep();
ok("a natural end leaves the transport up, because only the plugin knows the read is over",
  settled === true && __audioStateForTest().playerHidden === false && __audioStateForTest().sequence === "read-4");
stopPluginAudio("voice");
ok("and the plugin closing the read puts the transport away",
  __audioStateForTest().playerHidden === true && __audioStateForTest().sequence === "");
const plain = audios.length;
await playPluginAudio("voice", new ArrayBuffer(8), { title: "One-off" });
ok("plain playAudio never joins a read: it plays, and no read outlives it",
  audios.length === plain + 1 && __audioStateForTest().sequence === "");
fire(latest(), "ended");
await sleep();
ok("and it puts the transport away by itself, exactly as before",
  __audioStateForTest().clip === null && __audioStateForTest().playerHidden === true);

// ── the reviewer's three: ownership in the GAP, where a read owns the channel with nothing playing ───────
// 1. A ends naturally, B starts while A is between parts, then a clip of A that was already in flight
//    arrives. It must not come back and replace B.
let aDone = null, bDone = null;
playPluginAudioAndWait("voice", new ArrayBuffer(8), { title: "A1", sequence: "A" }).then((v) => { aDone = v; });
await sleep();
fire(latest(), "ended");
await sleep();
ok("read A is alive in the gap", aDone === true && __audioStateForTest().sequence === "A");
playPluginAudioAndWait("voice", new ArrayBuffer(8), { title: "B1", sequence: "B" }).then((v) => { bDone = v; });
await sleep();
ok("starting read B in that gap takes the channel from A", __audioStateForTest().sequence === "B" && dead().includes("voice:A"));
const during = audios.length;
ok("and a late part of A is refused rather than replacing what is playing",
  (await playPluginAudioAndWait("voice", new ArrayBuffer(8), { title: "A2", sequence: "A" })) === false
  && audios.length === during && __audioStateForTest().clip !== null && bDone === null);

// 2. Two plugins may mint the same id, and neither may silence the other.
playPluginAudioAndWait("other", new ArrayBuffer(8), { title: "other A1", sequence: "A" }).then(() => {});
await sleep();
ok("a DIFFERENT plugin's read of the same name is not refused by A's tombstone",
  __audioStateForTest().clip?.pluginId === "other" && __audioStateForTest().sequence === "A");
stopPluginAudio("other");
await sleep();

// 3. Two ownership changes must not lose the first read's tombstone.
playPluginAudioAndWait("voice", new ArrayBuffer(8), { title: "C1", sequence: "C" }).then(() => {});
await sleep();
fire(latest(), "ended");
await sleep();
playPluginAudioAndWait("voice", new ArrayBuffer(8), { title: "D1", sequence: "D" }).then(() => {});
await sleep();
const settledCount = audios.length;
ok("after two more reads, a late part of the FIRST one is still refused",
  (await playPluginAudioAndWait("voice", new ArrayBuffer(8), { title: "A3", sequence: "A" })) === false
  && audios.length === settledCount);
ok("and the lineage stays bounded", __audioStateForTest().cancelled.length <= 16);
stopPluginAudio();

// ── ONE TIMELINE FOR A WHOLE READING ─────────────────────────────────────────────────────────────────────
// Reported: the slider restarts at every part of a long reading, so a document reads as if it keeps starting
// over. The timeline makes the READING the unit. Its scale is CHARACTERS of the source, because the number of
// seconds is unknown until the last part exists — a seconds-based slider would have to rescale as parts
// arrive, which is the same jump by another name.
stopPluginAudio();
audios.length = 0;
const DOC = 3000;
// A FRESH sequence id: "read-1" above was cancelled, and its tombstone would refuse every part of this one
// before a single element was created. (It did, and the failure looked like the player being broken.)
let readingId = "reading-timeline";
const part = (start, end, seconds, last = false) => ({
  sequence: readingId, title: "Reading",
  timeline: { sourceStart: start, sourceEnd: end, sourceTotal: DOC, seconds, last },
});
const state = () => __audioStateForTest().timeline;
const seek = document.querySelector(".plugin-audio-seek");
const clock = () => document.querySelector(".plugin-audio-copy span").textContent;
// A part arrives, its metadata loads, and it plays — the shape of a real clip.
const arrive = async (options, wait = false) => {
  const promise = wait
    ? playPluginAudioAndWait("voice", new ArrayBuffer(8), options)
    : playPluginAudio("voice", new ArrayBuffer(8), options);
  await sleep();
  const clip = audios[audios.length - 1];
  clip.duration = options.timeline.seconds;
  clip._fire("loadedmetadata");
  return { promise, clip };
};
const finish = async (clip) => { clip.currentTime = clip.duration; clip.ended = true; clip._fire("ended"); await sleep(); };

// The REAL protocol: the plugin awaits each part and only hands over the next once that one has ENDED. A
// test that sends part two while part one is still playing is testing a sequence that cannot happen — and
// would be told, correctly, that the new part is buffered behind the listener.
const one = await arrive(part(0, 1000, 80), true);
let oneDone = null; one.promise.then((value) => { oneDone = value; });
ok("a reading with timeline metadata opens one timeline", state()?.segments.length === 1 && state().playing === 0);
one.clip.currentTime = 40; one.clip._fire("timeupdate");
ok("the slider measures the DOCUMENT, not the clip — half of part one is a sixth of the text",
  Math.abs(Number(seek.value) - 167) <= 2, );
ok("no total is claimed while the reading is still arriving", clock() === "0:40" && state().total === 0);
ok("and the retained extent is marked on the track", seek.style["--buffered"] === "33.33%");

await finish(one.clip);
ok("finishing part one resolves exactly the part the plugin was awaiting", oneDone === true);
ok("and the transport stays up in the gap, holding at the frontier", __audioStateForTest().playerHidden === false);

const two = await arrive(part(1000, 2000, 80), true);
let twoDone = null; two.promise.then((value) => { twoDone = value; });
ok("part two joins the same timeline rather than starting a new one",
  state().segments.length === 2 && state().playing === 1 && state().segments[1].awaited === true);
two.clip.currentTime = 40; two.clip._fire("timeupdate");
ok("ELAPSED IS CUMULATIVE — it does not reset at a part boundary", clock() === "2:00");
ok("and the slider does not restart either: half of part two is half the document",
  Math.abs(Number(seek.value) - 500) <= 2);
await finish(two.clip);
ok("part two resolves in its turn", twoDone === true);

const three = await arrive(part(2000, 3000, 80, true), true);
let threeDone = null; three.promise.then((value) => { threeDone = value; });
ok("the total is known as soon as the LAST part has arrived", state().total === 240 && clock().endsWith("/ 4:00"));

// ── the awkward one: seeking BACK while the plugin is awaiting a later part ─────────────────────────────
seek.value = "80"; seek._fire("input");           // drag to 8% of the document — inside part one
await sleep();
ok("seeking backwards moves to the part holding that character", state().playing === 0);
const backClip = audios[audios.length - 1];
backClip.duration = 80; backClip._fire("loadedmetadata");
ok("and lands proportionally inside it, not at its start", Math.abs(backClip.currentTime - 19.2) < 0.6);
ok("the part still being awaited is NOT resolved by a seek", threeDone === null);
backClip.currentTime = 30; backClip._fire("timeupdate");
ok("elapsed follows the listener backwards, because it belongs to the reading", clock().startsWith("0:30"));

// Finishing an earlier part must traverse forward through what is retained, resolving nobody on the way.
await finish(backClip);
ok("finishing an earlier part advances to the next retained one", state().playing === 1);
ok("and does not resolve the promise of the part being awaited", threeDone === null);
const twoAgain = audios[audios.length - 1]; twoAgain.duration = 80; twoAgain._fire("loadedmetadata");
await finish(twoAgain);
ok("it keeps traversing, still resolving nobody", state().playing === 2 && threeDone === null);
const threeAgain = audios[audios.length - 1]; threeAgain.duration = 80; threeAgain._fire("loadedmetadata");
await finish(threeAgain);
ok("and only the part actually being awaited resolves, once, true", threeDone === true);

// ── eviction keeps the clock honest ────────────────────────────────────────────────────────────────────
ok("nothing was evicted at this size", (state()?.segments || []).every((segment) => !segment.evicted));
stopPluginAudio();
ok("stopping clears the timeline", __audioStateForTest().timeline === null);

// A reading that is stopped mid-flight must ANSWER the part the plugin is waiting on, or its loop hangs.
audios.length = 0;
readingId = "reading-stopped";       // the one above was cancelled; its tombstone would refuse this outright
const solo = await arrive(part(0, 1000, 80), true);
let soloDone = null; solo.promise.then((value) => { soloDone = value; });
stopPluginAudio();
await sleep();
ok("stopping a reading answers the awaited part with false rather than leaving it hanging", soloDone === false);

// ── OVER THE RETENTION BUDGET ────────────────────────────────────────────────────────────────────────────
// Eviction runs as a part is APPENDED, while `playing` still names the part that just ended. Without
// protecting the newest one, the frontier could evict ITSELF: playSegment would decline to play a part with
// no audio, and the promise the plugin is waiting on would never be settled — a reading stalled forever.
audios.length = 0;
readingId = "reading-evict";
const BIG = 40 * 1024 * 1024;                       // two of these exceed the 64MiB budget
const bigPart = (start, end, last = false) => ({ ...part(start, end, 80, last) });
const bigArrive = async (options) => {
  const promise = playPluginAudioAndWait("voice", new ArrayBuffer(BIG), options);
  await sleep();
  const clip = audios[audios.length - 1];
  clip.duration = options.timeline.seconds; clip._fire("loadedmetadata");
  return { promise, clip };
};
const bigOne = await bigArrive(bigPart(0, 1000));
let bigOneDone = null; bigOne.promise.then((value) => { bigOneDone = value; });
await finish(bigOne.clip);
ok("the first large part resolves normally", bigOneDone === true);
const bigTwo = await bigArrive(bigPart(1000, 2000, true));
let bigTwoDone = null; bigTwo.promise.then((value) => { bigTwoDone = value; });
const evicted = state();
ok("going over budget evicts the ENDED part, never the one just handed over",
  evicted.segments[0].evicted === true && evicted.segments[1].evicted === false,
  JSON.stringify(evicted.segments.map((seg) => seg.evicted)));
ok("so the newest part is playable and is the one playing", evicted.playing === 1);
ok("and its measured duration survives eviction, so elapsed stays true", evicted.segments[0].duration === 80);
await finish(audios[audios.length - 1]);
ok("its promise settles — a reading over budget does not stall", bigTwoDone === true);
ok("seeking into an evicted part clamps to retained audio instead of going silent",
  (() => { seek.value = "10"; seek._fire("input"); return __audioStateForTest().timeline === null || __audioStateForTest().timeline.playing === 1; })());
stopPluginAudio();

// ── A LATE REJECTION MUST NOT STOP WHOEVER TOOK OVER ─────────────────────────────────────────────────────
// A refused play() can settle long after the user moved on. Tearing down what is playing NOW because an
// abandoned element refused would settle the wrong promise and stop the wrong read.
audios.length = 0;
let hold = null;
FakeAudio.prototype.play = function () { return new Promise((_, reject) => { hold = reject; }); };
readingId = "reading-late-a";
const lateA = playPluginAudioAndWait("voice", new ArrayBuffer(8), part(0, 1000, 80));
let lateADone = "pending"; lateA.then((v) => { lateADone = "resolved:" + v; }, () => { lateADone = "rejected"; });
await sleep();
FakeAudio.prototype.play = async function () { this.paused = false; };
readingId = "reading-late-b";
const takeover = await arrive(part(0, 1000, 80), true);
let takeoverDone = "pending"; takeover.promise.then((v) => { takeoverDone = "resolved:" + v; }, () => { takeoverDone = "rejected"; });
const bBefore = state();
hold(new Error("NotAllowedError"));                 // A's refusal lands AFTER B took the channel
await sleep(); await sleep();
ok("a late rejection from an abandoned reading does not stop the one that replaced it",
  takeoverDone === "pending" && state() !== null && state().segments.length === bBefore.segments.length,
  `${takeoverDone} · ${JSON.stringify(state() && state().playing)}`);
ok("and the abandoned reading still answers its own plugin", lateADone !== "pending", lateADone);
stopPluginAudio();

// A refused play() must REJECT the part the plugin is waiting on, never leave it hanging. Autoplay policies
// refuse; the single-clip path has always thrown, and the timeline path has more callers, so it is the one
// that could quietly swallow it.
audios.length = 0;
readingId = "reading-refused";
FakeAudio.prototype.play = async function () { throw new Error("NotAllowedError"); };
let refusedSettled = "pending";
playPluginAudioAndWait("voice", new ArrayBuffer(8), part(0, 1000, 80))
  .then((value) => { refusedSettled = "resolved:" + value; }, () => { refusedSettled = "rejected"; });
await sleep(); await sleep();
ok("a reading whose audio is refused settles rather than hanging the plugin", refusedSettled !== "pending", refusedSettled);
ok("and the timeline is not left behind with a transport nobody can use", __audioStateForTest().timeline === null);
FakeAudio.prototype.play = async function () { this.paused = false; };

// ── a plugin that sends no timeline is untouched ────────────────────────────────────────────────────────
audios.length = 0;
await playPluginAudio("voice", new ArrayBuffer(8), { title: "Plain" });
ok("a clip with no timeline metadata opens no timeline at all", __audioStateForTest().timeline === null);
audios[0].currentTime = 6; audios[0]._fire("timeupdate");
ok("and its slider is still the clip's own, exactly as before", Number(seek.value) === 500 && clock() === "0:06 / 0:12");
stopPluginAudio();

if (checks.some(([, pass]) => !pass)) process.exitCode = 1;
else console.log(`\n${checks.length}/${checks.length} plugin audio checks passed`);
