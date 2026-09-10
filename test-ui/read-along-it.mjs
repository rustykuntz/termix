// Read-along coordinator. No DOM: this module is pure timeline logic, and the terminal half is gated in a
// real browser (parity/probes/cdp-gate-readalong.cjs) where cell geometry actually exists.
const checks = [];
function ok(name, pass) { checks.push([name, !!pass]); console.log((pass ? "  ok   " : "  FAIL ") + name); }

const { registerReadAlongSurface, startReadAlong, updateReadAlong, stopReadAlong, matchable, __readAlongForTest } =
  await import("../public/js/ui/read-along.js");

const SOURCE = "First chunk of the reply. Second chunk of the reply. Third and last chunk.";
const CUES = [
  { start: 0, end: 1.4, textStart: 0, textEnd: 25 },
  { start: 1.7, end: 3.1, textStart: 26, textEnd: 52 },
  { start: 3.4, end: 4.6, textStart: 53, textEnd: 74 },
];
const payload = (over = {}) => ({ surface: "terminal", sessionId: "s1", sourceText: SOURCE, cues: CUES, ...over });

let calls = [];
let resolveTo = () => ({
  show: (index) => calls.push(["show", index]),
  clear: () => calls.push(["clear"]),
  dispose: () => calls.push(["dispose"]),
});
registerReadAlongSurface("terminal", (meta) => resolveTo(meta));
const reset = () => { stopReadAlong(); calls = []; };

// ── The payload is untrusted plugin input, and a PARTIAL timeline is the dangerous case ──────────────────
let consulted = 0;
resolveTo = (meta) => { consulted++; return { show: (i) => calls.push(["show", i]), clear: () => calls.push(["clear"]), dispose: () => calls.push(["dispose"]) }; };
const rejects = [
  ["a surface we do not own", { surface: "viewer" }],
  ["no session", { sessionId: "" }],
  ["blank source text", { sourceText: "   " }],
  ["source text past the cap", { sourceText: "x".repeat(8193) }],
  ["no cues at all", { cues: [] }],
  ["more cues than the character cap could ever produce", { cues: new Array(8193).fill(CUES[0]) }],
  ["cues out of time order", { cues: [CUES[1], CUES[0]] }],
  ["a cue that ends before it starts", { cues: [{ start: 2, end: 1, textStart: 0, textEnd: 4 }] }],
  ["an empty text range", { cues: [{ start: 0, end: 1, textStart: 4, textEnd: 4 }] }],
  ["a range past the end of the source", { cues: [{ start: 0, end: 1, textStart: 0, textEnd: SOURCE.length + 1 }] }],
  ["a non-numeric time", { cues: [{ start: "soon", end: 1, textStart: 0, textEnd: 4 }] }],
  ["nothing at all", null],
];
for (const [label, over] of rejects) {
  consulted = 0;
  ok("refuses " + label, startReadAlong(over === null ? null : payload(over)) === false && consulted === 0 && !__readAlongForTest());
}

// One cue per WORD ADVANCE is the shape now, so the ceiling has to be the character cap and not a chunk
// count: 8 000 characters of speech is a few thousand windows.
let seen = null;
resolveTo = (meta) => { seen = meta; return { show: (i) => calls.push(["show", i]), clear: () => calls.push(["clear"]), dispose: () => calls.push(["dispose"]) }; };
reset();
ok("a window per word advance is within the cap",
  startReadAlong(payload({ cues: new Array(8192).fill(0).map((_, i) => ({ start: i * 0.3, end: i * 0.3 + 0.9, textStart: 0, textEnd: 5 })) })) === true
  && __readAlongForTest().cues === 8192);
reset();

// ── The metadata the surface needs, and nothing it does not ──────────────────────────────────────────────
seen = null; startReadAlong(payload());
ok("timing is MEASURED unless the plugin says otherwise", seen.timing === "measured" && seen.anchor === "");
reset(); seen = null; startReadAlong(payload({ timing: "estimated", anchor: "ra1.0.s1.4.0.4.20" }));
ok("an estimated clock and a selection anchor reach the surface", seen.timing === "estimated" && seen.anchor === "ra1.0.s1.4.0.4.20");
reset(); seen = null; startReadAlong(payload({ timing: "exact", anchor: 42 }));
ok("a timing word we do not know is treated as measured, and a non-string anchor as none",
  seen.timing === "measured" && seen.anchor === "");
reset(); seen = null; startReadAlong(payload({ anchor: "x".repeat(257) }));
ok("an anchor past the cap is dropped rather than carried", seen.anchor === "");
reset();

// ── Overlapping windows: the sliding shape ───────────────────────────────────────────────────────────────
// "Item 3 is" → "3 is now" → "is now your": one cue per advance, three words wide, so consecutive cues
// SHARE most of their range. Ordering is on `start` alone; the ranges themselves may overlap freely.
const SLIDE = "Item 3 is now your fourth reply.";
const WINDOWS = [
  { start: 0, end: 0.4, textStart: 0, textEnd: 9 },
  { start: 0.4, end: 0.8, textStart: 5, textEnd: 12 },
  { start: 0.8, end: 1.2, textStart: 7, textEnd: 17 },
];
reset();
ok("overlapping windows are a valid timeline", startReadAlong(payload({ sourceText: SLIDE, cues: WINDOWS })) === true);
calls = []; updateReadAlong(0.1, true); updateReadAlong(0.5, true); updateReadAlong(0.9, true);
ok("each advance moves the window on exactly once",
  JSON.stringify(calls) === JSON.stringify([["show", 0], ["show", 1], ["show", 2]]));
calls = []; updateReadAlong(0.95, true); updateReadAlong(1.4, true);
ok("and a clock still inside the last window that started repaints nothing", calls.length === 0);
calls = []; updateReadAlong(0.5, true);
ok("scrubbing back lands on the window that was current then", JSON.stringify(calls) === JSON.stringify([["show", 1]]));
reset();

// ── Fail closed: the surface could not map the source ────────────────────────────────────────────────────
resolveTo = () => null;
ok("no highlight when the surface cannot map the source", startReadAlong(payload()) === false && !__readAlongForTest());
resolveTo = () => { throw new Error("boom"); };
ok("a surface that throws is the same as one that declines", startReadAlong(payload()) === false && !__readAlongForTest());

// ── Following the clock ──────────────────────────────────────────────────────────────────────────────────
resolveTo = () => ({ show: (i) => calls.push(["show", i]), clear: () => calls.push(["clear"]), dispose: () => calls.push(["dispose"]) });
reset();
ok("a complete timeline starts", startReadAlong(payload()) === true && __readAlongForTest().cues === 3);
updateReadAlong(0.2, true);
ok("the first chunk lights while it is being spoken", JSON.stringify(calls) === JSON.stringify([["show", 0]]));
calls = []; updateReadAlong(0.9, true); updateReadAlong(1.3, true);
ok("staying inside a chunk repaints nothing", calls.length === 0);
calls = []; updateReadAlong(1.55, true);
ok("the chunk HOLDS through the silence between chunks", calls.length === 0 && __readAlongForTest().index === 0);
calls = []; updateReadAlong(1.8, true);
ok("the next chunk takes over on its real audio boundary", JSON.stringify(calls) === JSON.stringify([["show", 1]]));
calls = []; updateReadAlong(4.4, true);
ok("the last chunk stays lit to the end of the clip", JSON.stringify(calls) === JSON.stringify([["show", 2]]));

// ── Seeking is just another clock reading ────────────────────────────────────────────────────────────────
calls = []; updateReadAlong(0.5, true);
ok("scrubbing backwards re-lights the earlier chunk", JSON.stringify(calls) === JSON.stringify([["show", 0]]));
calls = []; updateReadAlong(1.9, true);
ok("scrubbing forwards jumps straight to the right chunk", JSON.stringify(calls) === JSON.stringify([["show", 1]]));

// ── Pause / resume / stop ────────────────────────────────────────────────────────────────────────────────
calls = []; updateReadAlong(1.9, false);
ok("pausing clears the highlight", JSON.stringify(calls) === JSON.stringify([["clear"]]));
calls = []; updateReadAlong(1.9, false);
ok("staying paused does not keep clearing", calls.length === 0);
calls = []; updateReadAlong(1.9, true);
ok("resuming brings the same chunk back", JSON.stringify(calls) === JSON.stringify([["show", 1]]));
calls = []; updateReadAlong(-1, true);
ok("a clock before the first chunk shows nothing", JSON.stringify(calls) === JSON.stringify([["clear"]]));
calls = []; stopReadAlong();
ok("stopping disposes the surface once", JSON.stringify(calls) === JSON.stringify([["dispose"]]) && !__readAlongForTest());
calls = []; updateReadAlong(2, true); stopReadAlong();
ok("nothing survives a stop", calls.length === 0);

calls = []; startReadAlong(payload()); startReadAlong(payload({ sessionId: "s2" }));
ok("a second clip retires the first one's surface", calls.filter(([kind]) => kind === "dispose").length === 1);
stopReadAlong();

// ── Whitespace and rendered-away markdown are the ONLY latitude the matcher gets ─────────────────────────
const collapsed = matchable("  Hello   there\n  world  ");
ok("runs of whitespace collapse to one space, ends trimmed", collapsed.text === "Hello there world");
ok("every kept character maps back to where it came from", collapsed.at.length === collapsed.text.length
  && "Hello   there".slice(0, 5).split("").every((ch, i) => "  Hello   there\n  world  "[collapsed.at[i]] === ch));
ok("a source offset maps forward to the reduced text", collapsed.to[2] === 0 && collapsed.to[18] === 12 && collapsed.to[0] === -1);
ok("reducing never invents a leading or trailing space", matchable("\n\n  x  \n").text === "x");

// Claude's canonical final message is raw markdown; the terminal holds what Claude's renderer PRINTED. The
// delimiters exist on one side only — but only ACTUAL delimiters may go, or two different strings reduce to
// the same one and a match can land on cells holding other words.
const canonical = "## Plan\n\nThe **build** is `green` and ~~ready~~, see *docs*.";
const rendered = "Plan\n\nThe build is green and ready, see docs.";
ok("a heading, bold, code, strikethrough and italic reduce to the rendered text",
  matchable(canonical, true).text === matchable(rendered, true).text);
ok("and the reduced text is the words themselves", matchable(canonical, true).text === "Plan The build is green and ready, see docs.");
ok("an offset inside a real delimiter simply has no cell", matchable("**hi**", true).to[0] === -1 && matchable("**hi**", true).to[2] === 0);

// The three the reviewer named, plus their neighbours. Each is ORDINARY TEXT in a terminal, and each must
// survive the reduction intact — otherwise it would collide with a different string on the screen.
for (const [literal, collides] of [
  ["foo_bar", "foobar"],
  ["a*b", "ab"],
  ["issue#12", "issue12"],
  ["snake_case_name", "snakecasename"],
  ["2 * 3 = 6", "2 3 = 6"],
  ["run --flag=*.js now", "run --flag=.js now"],
  ["a lone ` backtick", "a lone backtick"],
  ["~ home", " home"],
]) {
  ok(`${JSON.stringify(literal)} is text, not syntax, and never collides with ${JSON.stringify(collides)}`,
    matchable(literal, true).text === matchable(literal).text && matchable(literal, true).text !== matchable(collides, true).text);
}
ok("a heading is only a heading at the start of its line",
  matchable("see issue#12 today", true).text === "see issue#12 today" && matchable("# Title", true).text === "Title");
ok("a hash run with no space after it is not a heading", matchable("#hashtag", true).text === "#hashtag");
ok("an emphasis run with no partner on its line stays put", matchable("*args and **kwargs", true).text === "*args and **kwargs");
ok("emphasis pairs across a line break do not pair", matchable("*one\ntwo*", true).text === "*one two*");
ok("the exact reading never removes anything but whitespace", matchable(canonical).text.includes("**build**"));

if (checks.some(([, pass]) => !pass)) process.exitCode = 1;
else console.log(`\n${checks.length}/${checks.length} read-along checks passed`);
