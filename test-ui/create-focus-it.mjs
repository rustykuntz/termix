// IT — opening a NEW session selects + focuses THIS client's new session, and ONLY this client's.
// Drives the REAL ws.createSession + REAL store over a fake WebSocket/DOM. Focus is proven at its true
// seam: terminal.js binds `store.on("active", id => focusSession(id))` → term.focus(), so the store
// emitting "active" for a session IS the focus signal — the spy below mirrors that exact binding.
//
// Guardrail under test (the subtle part): focus switches ONLY for a session this client initiated via
// createSession (which arms a one-shot). A session.created from replay/reconnect or another client/agent
// must NOT steal the user's place. The one-shot is cleared on reset() (reconnect wipes it before the replay
// burst) and on a create-error snapshot (our create bounced).
import { installFakeDom, installFakeWs } from "./fakedom.mjs";
installFakeDom();
installFakeWs();

const { store } = await import("../public/js/store.js");
const { connectWs, createSession } = await import("../public/js/ws.js");

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// mirror terminal.js's focus wiring exactly: "active" → focus the newly-active session's terminal.
const focused = [];
store.on("active", (id) => focused.push(id));
const lastFocus = () => (focused.length ? focused[focused.length - 1] : null);

// a well-formed engine session.created broadcast (what ws.onmessage feeds store.applyEvent).
const created = (id, extra = {}) => store.applyEvent({
  type: "session.created", sessionId: id, protocol: 1, provider: "claude-code",
  name: "", pid: 1234, cwd: "/x", cols: 120, rows: 40, live: true, projectId: null, ...extra,
});

try {
  connectWs(); await sleep(5);   // fake socket opens → store.reset() + connected

  // ── (a) LOCAL create switches focus away from wherever we were ──
  created("A");                                          // first live session auto-opens (pre-existing behavior)
  ok("first session auto-opens (baseline, no arm)", store.activeId === "A" && lastFocus() === "A");

  createSession("claude-code", "/x", "new-b");           // the local New-Session action (arms the one-shot)
  created("B");                                          // engine broadcasts our new session
  ok("local create → new session selected", store.activeId === "B");
  ok("local create → new session focused (active emitted for it)", lastFocus() === "B");

  // ── (b) a REMOTE / other-client session.created does NOT steal focus ──
  created("C");                                          // no local createSession preceded this
  ok("remote create → selection unchanged", store.activeId === "B");
  ok("remote create → NOT focused", !focused.includes("C"));

  // one-shot is truly one-shot: after B was adopted, a further remote create stays put (already covered by C).

  // ── (c) a reconnect + REPLAY burst opens only the first live session — a pending local create does not over-steal ──
  // (Observable replay safety comes from reset() nulling activeId + the one-shot; the reset() disarm is belt-and-suspenders.)
  createSession("claude-code", "/x", "dropped");         // arm, but its broadcast never arrives (socket drops)…
  store.reset();                                         // …reconnect wipes state (and cancels the pending create intent)
  focused.length = 0;
  created("R1");                                         // replay: first live session auto-opens (correct, not a steal)
  created("R2");                                         // replay: activeId already R1 → must NOT be stolen
  ok("reconnect + replay opens only the first live session (no over-steal)", store.activeId === "R1" && !focused.includes("R2"));

  // ── (d) a create-error snapshot disarms → a later remote spawn is not adopted ──
  store.select("R2");                                     // put focus on R2 (non-null active, so an arm would be visible)
  createSession("claude-code", "/x", "conflict");        // arm…
  created("R2", { pid: 1234, error: { code: "name_conflict", operation: "session.create", value: "conflict", message: "taken" } });  // …engine bounces our create
  ok("create-error routed as createRejected (no new row)", !store.sessions.has("conflict") && store.activeId === "R2");
  focused.length = 0;
  created("Z");                                          // a remote spawn after the bounce
  ok("create-error disarmed → remote spawn not adopted", store.activeId === "R2" && !focused.includes("Z"));

  console.log(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
} catch (e) { console.log("THREW", e && e.stack || e); fail++; }
process.exit(fail === 0 ? 0 : 1);
