// Working indicator — v1's bouncing-balls physics, ported verbatim (termix terminals.js:281-336, colors :85-86).
// Three balls fall under gravity, bounce off a floor, collide with each other, and respawn off the right edge.
// This is the "the agent is thinking" signal v1 was recognised for; v2's amber dot alone read as nothing at a glance.
//
// Three v2 adaptations (physics/consts/colors are untouched):
//   • ONE shared 24fps ticker drives every live instance — v1 ran a loop per row, so N working sessions meant N
//     loops. The tiny 30x14 indicator gains nothing from a 120Hz display refresh, while the cap keeps it cheap.
//     The ticker only runs while at least one instance is mounted, so an all-idle sidebar costs zero frames.
//   • Colors re-derive on a theme flip (v1 sampled the theme once, at start) — v2 flips light/dark live.
//   • prefers-reduced-motion renders the balls at rest instead of animating (matches the app's existing
//     reduced-motion handling for toasts).
import { onTheme, resolvedTheme } from "../theme.js";

const DARK_BALLS = ["#00e5ff", "#5df0d6", "#9b8cff"];    // v1 terminals.js:85-86 — verbatim
const LIGHT_BALLS = ["#0891b2", "#059669", "#7c3aed"];
const RADII = [4.5, 4, 3.5];
const FLOOR = 40, GRAVITY = 0.18, RESTITUTION = 0.7;
// v1's SVG box + viewBox, now applied by hand: 90x28 of world into 30x14 of CSS px under xMidYMid meet
// = a uniform min(30/90, 14/28) = 1/3 scale, with the spare vertical room split evenly.
const BOX_W = 30, BOX_H = 14, VB_X = 5, VB_Y = 18, VB_W = 90, VB_H = 28;
const SCALE = Math.min(BOX_W / VB_W, BOX_H / VB_H);
const OFFSET_Y = (BOX_H - VB_H * SCALE) / 2;
const FRAME_MS = 1000 / 24;

const insts = new Set();       // every mounted instance (animated or at-rest)
let timer = 0, lastFrame = 0;

const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const colors = () => (resolvedTheme() === "light" ? LIGHT_BALLS : DARK_BALLS);
function reducedMotion() {
  try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
}

// v1's spawn state, verbatim.
const spawn = (i) => ({ x: 10 + i * rand(14, 22), y: FLOOR - rand(0, 15), vx: rand(0.6, 1.3), vy: -rand(2.5, 5), r: RADII[i] });

// Mount the animation into `host` (its contents are replaced). Returns a stop() that unmounts it and
// releases the frame — ALWAYS call it when the session stops working, or the instance keeps ticking.
export function startBounce(host) {
  if (!host) return () => {};
  const cv = document.createElement("canvas");
  cv.setAttribute("aria-hidden", "true");      // decorative — the row/chip text carries the meaning
  cv.style.width = BOX_W + "px";
  cv.style.height = BOX_H + "px";
  cv.style.opacity = "0.75";
  // Backing store is sized ONCE. Resizing a canvas resets its context and dirties layout, so never touch
  // width/height per frame — that is the whole point of this renderer.
  const dpr = Math.min(3, Math.max(1, globalThis.devicePixelRatio || 1));
  cv.width = Math.round(BOX_W * dpr);
  cv.height = Math.round(BOX_H * dpr);
  const ctx = cv.getContext && cv.getContext("2d");
  if (ctx && ctx.setTransform) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const balls = RADII.map((r, i) => spawn(i));
  host.replaceChildren(cv);
  const inst = { balls, ctx, still: reducedMotion() };
  if (inst.still) balls.forEach((b, i) => { b.x = 14 + i * 22; b.y = FLOOR; });   // at rest, evenly spread
  insts.add(inst);
  draw(inst);
  if (!inst.still) startTicker();
  return () => {
    insts.delete(inst);
    host.replaceChildren();
    if (!hasMotion()) stopTicker();
  };
}

const hasMotion = () => { for (const i of insts) if (!i.still) return true; return false; };

function startTicker() { if (!timer) { lastFrame = 0; timer = setTimeout(step, FRAME_MS); } }
function stopTicker() { if (timer) { clearTimeout(timer); timer = 0; } }

function step(now = performance.now()) {
  timer = 0;
  const dt = lastFrame ? Math.min((now - lastFrame) / 16.67, 4) : 1;   // v1's frame normalisation + 4-frame clamp
  lastFrame = now;
  for (const inst of insts) if (!inst.still) { advance(inst, dt); draw(inst); }
  if (hasMotion()) timer = setTimeout(step, FRAME_MS);
}

// v1's integrator: gravity, floor bounce with restitution, pairwise elastic exchange, respawn past x=100.
function advance({ balls }, dt) {
  for (const b of balls) {
    b.vy += GRAVITY * dt;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    if (b.y > FLOOR) { b.y = FLOOR; b.vy *= -RESTITUTION; }
  }
  for (let i = 0; i < balls.length; i++) {
    for (let j = i + 1; j < balls.length; j++) {
      const a = balls[i], b = balls[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const dist = Math.hypot(dx, dy), min = a.r + b.r;
      if (dist < min && dist > 0) {   // dist>0 guards a divide-by-zero that would NaN the balls off-screen for good
        const nx = dx / dist, ny = dy / dist;
        const p = a.vx * nx + a.vy * ny - b.vx * nx - b.vy * ny;
        a.vx -= p * nx; a.vy -= p * ny;
        b.vx += p * nx; b.vy += p * ny;
      }
    }
  }
  for (const b of balls) {
    // Recycle off EITHER edge (0 and 100 sit 5 outside the viewBox's visible 5..95, so the bounds are symmetric).
    // v1 tested only x>100: a pairwise collision above can flip vx NEGATIVE, and such a ball then drifted left out
    // of the box forever — measured escape to x < -30000, with all three gone within ~12s, which is what read as
    // "the animation decays to a stop". Re-entry is always from the left moving right, i.e. the same cycle as
    // before, so the look is unchanged. (v1 carries the same latent bug; it only masked it by tearing down and
    // remounting the whole animation on every status swap — which is exactly the rebuild we deliberately avoid.)
    if (b.x > 100 || b.x < 0) { b.x = rand(5, 15); b.y = FLOOR - rand(0, 10); b.vx = rand(0.6, 1.3); b.vy = -rand(2.5, 5); }
  }
}

// Canvas render. A 2d draw does NOT invalidate layout, unlike the SVG cx/cy writes this replaced — those cost
// ~4% of a core and forced ~120 layouts/sec with a single working row (measured: LayoutCount 2402 per 20s).
// Geometry reproduces the old SVG exactly: viewBox "5 18 90 28" into a 30x14 box under the default
// xMidYMid-meet, i.e. a uniform 1/3 scale with the shorter axis centred — so the balls land pixel-identically.
function draw({ balls, ctx }) {
  if (!ctx) return;
  ctx.clearRect(0, 0, BOX_W, BOX_H);
  const paint = colors();
  for (let i = 0; i < balls.length; i++) {
    const b = balls[i];
    ctx.fillStyle = paint[i];
    ctx.beginPath();
    ctx.arc((b.x - VB_X) * SCALE, (b.y - VB_Y) * SCALE + OFFSET_Y, b.r * SCALE, 0, Math.PI * 2);
    ctx.fill();
  }
}

// A light/dark flip re-paints every mounted instance in place (no restart — the balls keep their momentum).
// draw() reads the colours each frame, so an animating instance recolours itself; an at-rest one (reduced
// motion) is never redrawn by the ticker, so redraw it here explicitly.
onTheme(() => { for (const inst of insts) draw(inst); });

// Test seam: how many instances are mounted / whether the shared ticker is running.
export function bounceStats() { return { mounted: insts.size, ticking: timer !== 0 }; }
