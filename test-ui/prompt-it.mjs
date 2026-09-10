// R2 IT — prompt surfaces: the question CARD (options → buttons, none → text+send), the ANNOTATE modal (draw a
// box → marks JSON in image-natural pixels), the prompt.answer control frame, dismiss-on-prompt.resolved (another
// client answered), and the other-session switch toast. Drives the ACTUAL store + prompt.js + annotate.js + ws.js
// over a fake WebSocket, on a .term-frame mount.
import { installFakeDom, installFakeWs } from "./fakedom.mjs";
const dom = installFakeDom();
const ws = installFakeWs();
// mounts prompt.js needs
const main = document.createElement("div"); main.className = "main"; document.body.appendChild(main);
const frame = document.createElement("div"); frame.className = "term-frame"; main.appendChild(frame);

const { store } = await import("../public/js/store.js");
const { connectWs } = await import("../public/js/ws.js");
const { initPrompt } = await import("../public/js/ui/prompt.js");

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const show = (o) => store.applyEvent({ type: "prompt.show", ...o });
const resolved = (promptId) => store.applyEvent({ type: "prompt.resolved", promptId });
const card = () => document.querySelector(".pcard");
const overlay = () => document.querySelector(".an-overlay");

try {
  connectWs(); await sleep(5);                         // fake socket opens → store.reset() fires first
  store.applyEvent({ type: "session.created", sessionId: "A", cwd: "/a", name: "alpha", live: true, pid: 1 });
  store.applyEvent({ type: "session.created", sessionId: "B", cwd: "/b", name: "beta", live: true, pid: 2 });
  initPrompt();
  ok("A active, no card at rest", store.activeId === "A" && !card());

  // ── options card → buttons → prompt.answer ──
  show({ sessionId: "A", promptId: "p1", question: "Deploy to prod?", options: ["Yes", "No"] });
  ok("options prompt → card shown", !!card() && card()._cls.has("show"));
  ok("card shows the question", document.querySelector(".pcard-q").textContent === "Deploy to prod?");
  ok("one button per option", document.querySelectorAll(".pcard-opt").length === 2);
  ws.clear();
  document.querySelectorAll(".pcard-opt")[0]._fire("click");
  ok("clicking an option sent prompt.answer with its value", (() => { const m = ws.last("prompt.answer"); return m && m.promptId === "p1" && m.value === "Yes"; })());
  ok("card dismissed after answering", !card());

  // ── text card (no options) → typed value → prompt.answer ──
  show({ sessionId: "A", promptId: "p2", question: "Name the branch" });
  const input = document.querySelector(".pcard-input");
  ok("no-options prompt → text input + Send", !!input && !!document.querySelector(".pcard-send"));
  input.value = "feature/x"; ws.clear();
  document.querySelector(".pcard-send")._fire("click");
  ok("Send sent prompt.answer with the typed value", (() => { const m = ws.last("prompt.answer"); return m && m.promptId === "p2" && m.value === "feature/x"; })());

  // ── dismiss on prompt.resolved (another client answered first) ──
  show({ sessionId: "A", promptId: "p3", question: "Pick one", options: ["a", "b"] });
  ok("card present before external resolve", !!card());
  resolved("p3");
  ok("prompt.resolved dismissed the card (no answer sent by us)", !card() && !ws.sent.some((m) => m.type === "prompt.answer" && m.promptId === "p3"));

  // ── other-session prompt → sticky toast, no card; switching reveals the card ──
  show({ sessionId: "B", promptId: "p4", question: "Merge?", options: ["Merge"] });
  ok("other-session prompt does NOT show a card on A", !card());
  ok("other-session prompt raised a toast", !!document.querySelector(".toast"));
  store.select("B"); await sleep(0);
  ok("switching to B reveals its card", !!card() && document.querySelector(".pcard-q").textContent === "Merge?");
  resolved("p4"); store.select("A"); await sleep(0);

  // ── annotate flavor → modal + marks JSON in natural pixels ──
  show({ sessionId: "A", promptId: "p5", annotate: { contentId: "c1", url: "/content/c1", name: "shot.png" } });
  ok("annotate prompt → modal (not a card)", !!overlay() && !card());
  ok("annotate modal shows the image", document.querySelector(".an-img").src === "/content/c1");
  // simulate a drawn box: layer 400x300 displayed, image natural 800x600 (2x)
  const layer = document.querySelector(".an-layer");
  layer._rect = { left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300 };
  const img = document.querySelector(".an-img"); img.naturalWidth = 800; img.naturalHeight = 600;
  ws.clear();
  layer._fire("pointerdown", { button: 0, clientX: 100, clientY: 60 });
  dom.winFire("pointermove", { clientX: 200, clientY: 160 });   // pointermove/up live on window
  dom.winFire("pointerup", {});
  ok("a box was drawn", document.querySelectorAll(".an-rect").length === 1);
  document.querySelector(".an-send")._fire("click");
  const ans = ws.last("prompt.answer");
  const marks = ans && JSON.parse(ans.value);
  ok("Send sent prompt.answer for the annotate prompt", !!ans && ans.promptId === "p5");
  ok("marks JSON carries image natural size", marks && marks.image.w === 800 && marks.image.h === 600);
  ok("rect converted to natural pixels (2x)", marks && marks.marks.length === 1 && marks.marks[0].x === 200 && marks.marks[0].y === 120 && marks.marks[0].w === 200 && marks.marks[0].h === 200);
  await sleep(200);   // let the 180ms animate-out remove the node
  ok("annotate modal closed after send", !overlay());

  // ── annotate Skip → empty marks (still unblocks the agent) ──
  show({ sessionId: "A", promptId: "p6", annotate: { contentId: "c2", url: "/content/c2", name: "x.png" } });
  ws.clear();
  document.querySelector(".an-skip")._fire("click");
  const skipAns = ws.last("prompt.answer");
  ok("Skip sends prompt.answer with empty marks", skipAns && skipAns.promptId === "p6" && JSON.parse(skipAns.value).marks.length === 0);

  console.log(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
} catch (e) { console.log("THREW", e && e.stack || e); fail++; }
process.exit(fail === 0 ? 0 : 1);
