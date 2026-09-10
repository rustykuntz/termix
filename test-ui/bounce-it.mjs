// IT — the working indicator (v1's bouncing balls, ported). Drives the REAL bounce.js physics and the REAL
// sidebar rows over the fake DOM, so the mount/unmount lifecycle is proven where it actually runs.
//
// What matters here: (1) working rows animate and idle/attention/dormant ones don't, (2) the animation is never
// restarted by an ordinary re-render (that would stutter it forever, since agent.update fires constantly while
// working), and (3) every teardown path releases the shared ticker — a leaked instance ticks for the whole session.
import { installFakeDom } from "./fakedom.mjs";
const dom = installFakeDom();
function mkEl(id) { const e = document.createElement("div"); e.id = id; return e; }
const list = mkEl("list"); list.appendChild(mkEl("list-empty")); document.body.appendChild(list);
for (const id of ["tab-all", "tab-unread", "search", "search-clear", "notify-btn", "prompts-btn", "settings-btn", "proj-btn", "unread-cnt", "conn", "conn-text", "save-ind", "new-btn"]) document.body.appendChild(mkEl(id));
const sideHead = document.createElement("div"); sideHead.className = "side-head"; const nw = document.createElement("div"); nw.className = "new-wrap"; sideHead.appendChild(nw); document.body.appendChild(sideHead);

const { store } = await import("../public/js/store.js");
const { startBounce, bounceStats } = await import("../public/js/ui/bounce.js");
const { initSidebar } = await import("../public/js/ui/sidebar.js");

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const live = (id, extra = {}) => store.applyEvent({ type: "session.created", sessionId: id, protocol: 1, provider: "claude-code", name: id, pid: 1, cwd: "/w", cols: 80, rows: 24, live: true, projectId: null, ...extra });
const status = (id, state) => store.applyEvent({ type: "status", sessionId: id, state });
const row = (id) => dom.all("row").find((r) => r.dataset.id === id) || null;
const childOf = (el, cls) => { const out = []; (function w(n) { for (const c of n.children) { if (c._cls && c._cls.has(cls)) out.push(c); w(c); } })(el); return out; };
// The renderer is a canvas now: read what was PAINTED (fakedom's recording 2d context) instead of SVG attrs.
const canvasOf = (el) => (el && el.children[0] && el.children[0].tag === "canvas" ? el.children[0] : null);
const rowCanvas = (id) => { const r = row(id); if (!r) return null; return canvasOf(childOf(r, "r-bounce")[0]); };
const balls = (id) => { const c = rowCanvas(id); return c ? c._ctx._arcs : []; };
const cxOf = (id) => balls(id).map((b) => b.x.toFixed(3)).join(",");
const WORLD = (drawnX) => drawnX / (30 / 90) + 5;   // invert the viewBox mapping back to world x

try {
  initSidebar();

  // ── the physics module in isolation ──
  const host = document.createElement("span");
  const stop = startBounce(host);
  const cv = host.children[0];
  ok("mounts a 30x14 CSS-px CANVAS (no per-frame DOM writes)", cv && cv.tag === "canvas" && cv.style.width === "30px" && cv.style.height === "14px");
  ok("paints exactly 3 balls per frame", cv._ctx._arcs.length === 3);
  // v1 radii 4.5/4/3.5 through the 1/3 viewBox scale
  ok("radii are v1's 4.5 / 4 / 3.5 (scaled by the viewBox)", cv._ctx._arcs.map((a) => (a.r * 3).toFixed(1)).join(",") === "4.5,4.0,3.5");
  ok("ticker runs while mounted", bounceStats().mounted === 1 && bounceStats().ticking);
  const before = cv._ctx._arcs.map((a) => a.y).join(",");
  await sleep(60);
  ok("balls actually move (gravity integrates across frames)", cv._ctx._arcs.map((a) => a.y).join(",") !== before);
  stop();
  ok("stop() unmounts the canvas and releases the shared ticker", host.children.length === 0 && bounceStats().mounted === 0 && !bounceStats().ticking);

  // ── mounted per-row by real session state ──
  live("A"); live("B");
  status("A", "working");
  ok("working row mounts the balls", balls("A").length === 3);
  ok("idle row does not", balls("B").length === 0);

  // a re-render while still working must NOT restart the animation (the stutter bug)
  const moved = cxOf("A");
  await sleep(60);
  const advanced = cxOf("A");
  store.applyEvent({ type: "agent.update", sessionId: "A", text: "still thinking" });   // ordinary re-render
  ok("re-render keeps the SAME instance (no restart)", bounceStats().mounted === 1 && cxOf("A") === advanced && advanced !== moved);

  status("A", "idle");
  ok("working → idle unmounts", balls("A").length === 0 && bounceStats().mounted === 0);

  // ── needs-you is blocked, not thinking → no balls ──
  status("B", "working");
  store.applyEvent({ type: "menu", sessionId: "B", choices: ["1", "2"], context: "Approve?" });
  status("B", "idle");                                    // idle + menu ⇒ attention
  ok("needs-you (attention) shows no balls", store.sessions.get("B").attention && balls("B").length === 0);

  // ── teardown paths all release the frame ──
  store.applyEvent({ type: "menu", sessionId: "B", choices: [], context: "" });
  status("B", "working");
  ok("re-armed for the teardown checks", bounceStats().mounted === 1);
  store.applyEvent({ type: "session.closed", sessionId: "B" });
  ok("row removal releases the ticker", bounceStats().mounted === 0 && !bounceStats().ticking);

  live("C"); status("C", "working");
  ok("mounted again before reset", bounceStats().mounted === 1);
  store.reset();                                          // reconnect wipe
  ok("store reset releases the ticker (no orphaned animation)", bounceStats().mounted === 0 && !bounceStats().ticking);

  // ── preview text still works around the new slot ──
  live("D"); status("D", "working");
  store.applyEvent({ type: "agent.update", sessionId: "D", text: "Reading files" });
  const rd = row("D");
  ok("preview text lives in .r-ptext beside the balls", childOf(rd, "r-ptext")[0].textContent === "Reading files" && balls("D").length === 3);
  ok("preview keeps its amber live class", childOf(rd, "r-preview")[0].className.includes("live"));

  // ── prefers-reduced-motion: the balls still render (the state stays legible) but never animate ──
  store.applyEvent({ type: "session.closed", sessionId: "D" });   // clear the board so the counts below are unambiguous
  const realMM = globalThis.matchMedia;
  globalThis.matchMedia = (q) => ({ matches: /reduced-motion/.test(q), addEventListener() {}, removeEventListener() {} });
  const quietHost = document.createElement("span");
  const quietStop = startBounce(quietHost);
  const quiet = quietHost.children[0];
  const at = quiet._ctx._arcs.map((a) => a.x + ":" + a.y).join(",");
  ok("reduced motion still renders the 3 balls", quiet._ctx._arcs.length === 3);
  // Geometry must reproduce the old SVG exactly (viewBox "5 18 90 28" into 30x14 under xMidYMid meet = 1/3
  // scale, spare vertical room split evenly). At-rest positions are deterministic, so check them precisely.
  const exp = [0, 1, 2].map((i) => ({ x: (14 + i * 22 - 5) / 3, y: (40 - 18) / 3 + (14 - 28 / 3) / 2 }));
  ok("canvas geometry is pixel-identical to the old SVG mapping",
     quiet._ctx._arcs.every((a, i) => Math.abs(a.x - exp[i].x) < 1e-9 && Math.abs(a.y - exp[i].y) < 1e-9));
  ok("reduced motion does NOT start the shared ticker", bounceStats().mounted === 1 && !bounceStats().ticking);
  await sleep(60);
  ok("reduced motion leaves them at rest", quiet._ctx._arcs.map((a) => a.x + ":" + a.y).join(",") === at);
  quietStop();
  globalThis.matchMedia = realMM;

  // ══ LONG RUN — no ball may ever leave the box ══
  // Or: the animation "decays to almost stopped" after a while. It is not energy decay (mean |v| holds); it is BALL
  // LOSS. A pairwise collision can flip a ball's vx negative, and the recycle rule only tested x>100 — so that ball
  // drifted left out of the viewBox forever. Measured before the fix: <3 balls visible within ~1s, zero within ~12s.
  // Driven frame-by-frame through the REAL ticker (timer stubbed) so 10 simulated minutes cost no wall-clock time.
  ok("clean slate before the long run", bounceStats().mounted === 0);
  const realTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
  let frame = null;
  globalThis.setTimeout = (fn) => { frame = fn; return 1; };
  globalThis.clearTimeout = () => { frame = null; };
  const runHost = document.createElement("span");
  const runStop = startBounce(runHost);
  const runCtx = runHost.children[0]._ctx;
  const FRAMES = 14400;                    // 10 minutes at 24fps
  let minX = Infinity, maxX = -Infinity, visibleSum = 0, t = 0, driven = 0;
  for (let i = 0; i < FRAMES && frame; i++) {
    const fn = frame; frame = null; t += 1000 / 24; fn(t); driven++;
    for (const a of runCtx._arcs) {
      const x = WORLD(a.x);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (x >= 5 && x <= 95) visibleSum++;   // the viewBox's visible x window
    }
  }
  // Steady-state occupancy is the metric that matters (the arch measured 0.9/3 on the broken code). Instantaneous
  // dips are EXPECTED and not a defect: a ball crossing the 0..5 or 95..100 gap is mid-cycle, briefly out of frame.
  const meanVisible = visibleSum / driven;
  ok("the real ticker drove all 14.4k frames (10 simulated minutes)", driven === FRAMES && t > 500000);
  ok("no ball ever escapes LEFT of the recycle bound (the regression)", minX >= 0);
  ok("no ball ever escapes RIGHT of the recycle bound", maxX <= 100);
  ok("all 3 balls still in the box after 10 simulated minutes", runCtx._arcs.length === 3 && runCtx._arcs.every((a) => WORLD(a.x) >= 0 && WORLD(a.x) <= 100));
  ok("steady-state occupancy stays near 3/3 (was 0.9/3 when balls escaped)", meanVisible >= 2.5);
  console.log(`      minX=${minX.toFixed(1)} maxX=${maxX.toFixed(1)} mean-visible=${meanVisible.toFixed(2)}/3`);
  runStop();
  globalThis.setTimeout = realTimeout; globalThis.clearTimeout = realClearTimeout;

  console.log(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
} catch (e) { console.log("THREW", e && e.stack || e); fail++; }
process.exit(fail === 0 ? 0 : 1);
