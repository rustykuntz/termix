// IT — closing a document is DURABLE, including across the reconnect that races it. Drives the real store +
// ws.js + content-dock.js over a fake socket.
//
// The original bug: closing a tab only spliced the client's in-memory array and told the engine nothing, so
// the engine — which holds shown assets in the session record and replays them on every connect — brought the
// document back. Sending content.close fixed that, and opened a narrower race the reviewer caught:
//
//   the engine starts replaying the instant the socket opens, BEFORE it has read the close we flush on that
//   same event. The replayed content.show re-adds the tab; the engine then drops the asset and (today) says
//   nothing about it. Everything is individually correct and the tab is still on screen.
//
// So a tombstone is set before the control is sent or queued, survives the store.reset() that every connect
// performs, and suppresses a matching content.show. It is retired by the engine's content.closed, or with the
// session — it is a reconciliation set, never a record of what the user has closed.
//
// The ORDER of those two frames is not ours to choose, so both are covered. A test that only walks the lucky
// order is how the race got through the first time.
import { installFakeDom, installFakeWs } from "./fakedom.mjs";
const dom = installFakeDom();
const ws = installFakeWs();
// Capture the socket instances so a disconnect can be simulated the way ws.js sees one.
const BaseWS = globalThis.WebSocket;
const sockets = [];
globalThis.WebSocket = class extends BaseWS { constructor(u) { super(u); sockets.push(this); } };
globalThis.WebSocket.OPEN = BaseWS.OPEN;

for (const id of ["pane-tabs", "pane-body", "term-panel"]) {
  const e = document.createElement("div"); e.id = id; document.body.appendChild(e);
}

const { store } = await import("../public/js/store.js");
const { connectWs, pendingQueue } = await import("../public/js/ws.js");
const { initContentDock, __pendingClosesForTest } = await import("../public/js/ui/content-dock.js");
const { initContentViewer } = await import("../public/js/ui/content-viewer.js");

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tabs = () => [...document.querySelectorAll(".cd-tab")].map((t) => {
  const n = t.querySelector(".cd-tab-name"); return n ? n.textContent : t.textContent; }).join(",");
const closeBtn = (name) => {
  const tab = [...document.querySelectorAll(".cd-tab")].find((t) => (t.textContent || "").includes(name));
  return tab ? tab.querySelector(".cd-tab-x") : null;
};
const closesSent = () => ws.sent.filter((m) => m && m.type === "content.close");
const SID = "S1";
// The REAL inbound path: ws → store.applyEvent → emit("content:show") → content-viewer → presentInDock.
// Feeding the store is exactly what a replayed frame does, which is what makes the ordering cases honest.
const replayShow = (contentId, name) => store.applyEvent({ type: "content.show", sessionId: SID, contentId, kind: "markdown", name, url: "/content/" + contentId });
const serverClosed = (contentId) => store.applyEvent({ type: "content.closed", sessionId: SID, contentId });
const bringUpSession = () => {
  store.applyEvent({ type: "session.created", sessionId: SID, provider: "shell", name: "one", cwd: "/w", live: true, pid: 1 });
  store.select(SID);
};
// A reconnect as the client actually experiences it: the store is reset, then the engine's snapshot replays.
const reconnectReplay = (ids) => { store.reset(); bringUpSession(); for (const [id, name] of ids) replayShow(id, name); };
const A = ["c-alpha", "alpha.md"], B = ["c-beta", "beta.md"], G = ["c-gamma", "gamma.md"];

try {
  connectWs(); await sleep(5);
  bringUpSession();
  initContentDock();
  initContentViewer();
  for (const [id, name] of [A, B, G]) replayShow(id, name);
  ok("three documents open beside the terminal", tabs().includes("alpha.md") && tabs().includes("beta.md") && tabs().includes("gamma.md"));

  // ── 1. a manual close goes on the wire with BOTH ids right ──
  ws.clear();
  const b = closeBtn("beta.md");
  ok("the close control exists on the tab", !!b);
  b._fire("click", { stopPropagation() {} });
  const msg = ws.last("content.close");
  ok("closing sends content.close", !!msg);
  ok("...for the right session", msg && msg.sessionId === SID);
  ok("...naming the closed document, not its neighbour or its index", msg && msg.contentId === "c-beta");
  ok("...exactly once", closesSent().length === 1);
  ok("the tab is gone at once, without waiting for the engine", !tabs().includes("beta.md"));
  ok("the siblings are untouched", tabs().includes("alpha.md") && tabs().includes("gamma.md"));
  ok("no close was sent for a document the user did not close",
     !closesSent().some((m) => m.contentId !== "c-beta"));
  ok("the close is tombstoned while it is unconfirmed", __pendingClosesForTest(SID).includes("c-beta"));

  // ── 2. CLOSE-BEFORE-REPLAY: the close is already out, then the in-flight replay lands ──
  ws.clear();
  reconnectReplay([A, B, G]);
  ok("close-before-replay: the closed document does NOT come back", !tabs().includes("beta.md"));
  ok("close-before-replay: siblings restore", tabs().includes("alpha.md") && tabs().includes("gamma.md"));
  ok("close-before-replay: suppressing a replay sends nothing (no close loop)", closesSent().length === 0);

  // ── 3. the acknowledgement retires the tombstone, removes locally, and is answered with silence ──
  ws.clear();
  serverClosed("c-beta");
  ok("content.closed retires the tombstone", !__pendingClosesForTest(SID).includes("c-beta"));
  ok("content.closed is never echoed back as a close", closesSent().length === 0);
  serverClosed("c-beta");
  ok("a repeated content.closed is an idempotent no-op", closesSent().length === 0 && !tabs().includes("beta.md"));

  // a server-driven close for a document THIS client still shows (another window closed it) retires the tab
  ws.clear();
  serverClosed("c-gamma");
  ok("a server-driven close retires the tab locally", !tabs().includes("gamma.md"));
  ok("...without answering", closesSent().length === 0);
  ok("...and alpha, untouched throughout, is still open", tabs().includes("alpha.md"));

  // ── 4. REPLAY-BEFORE-CLOSE, the reviewer's order: offline close, then the replay beats the flush ──
  reconnectReplay([A, B, G]);   // fresh ground: alpha, beta, gamma open again
  ok("reset for the offline case: three documents open", tabs().includes("alpha.md") && tabs().includes("beta.md") && tabs().includes("gamma.md"));
  ws.clear();
  sockets[sockets.length - 1].close();       // ordinary disconnect, not the stale-engine state
  await sleep(5);
  closeBtn("beta.md")._fire("click", { stopPropagation() {} });
  ok("offline: the tab closes locally", !tabs().includes("beta.md"));
  ok("offline: nothing reached the wire", closesSent().length === 0);
  ok("offline: the close is QUEUED rather than dropped", pendingQueue().filter((m) => m.type === "content.close").length === 1);
  ok("offline: the queued close names the right document",
     pendingQueue().find((m) => m.type === "content.close").contentId === "c-beta");
  ok("offline: the tombstone is armed BEFORE the flush, not after it",
     __pendingClosesForTest(SID).includes("c-beta"));

  // the replay arrives FIRST, exactly as it does when the engine starts pushing before reading our close
  reconnectReplay([A, B, G]);
  ok("replay-before-close: the closed document does NOT reappear", !tabs().includes("beta.md"));
  ok("replay-before-close: siblings restore", tabs().includes("alpha.md") && tabs().includes("gamma.md"));
  ok("replay-before-close: the tombstone survived the store.reset the reconnect performs",
     __pendingClosesForTest(SID).includes("c-beta"));

  await sleep(1700);                          // ws.js reconnects on its own timer and flushes the queue
  ok("the queued close is flushed to the engine on reconnect", (() => {
    const m = ws.last("content.close"); return m && m.contentId === "c-beta"; })());
  ok("it is flushed once, not once per replayed frame", closesSent().length === 1);
  ok("the queue is empty afterwards", !pendingQueue().some((m) => m.type === "content.close"));
  ok("the document is still gone after the whole exchange", !tabs().includes("beta.md"));

  // ── 5. tombstones are reconciliation, not history ──
  serverClosed("c-beta");
  ok("once acknowledged, nothing is left recorded for the session", __pendingClosesForTest(SID).length === 0);
  reconnectReplay([A, B]);
  ok("and with the tombstone retired, the engine is the authority again", tabs().includes("beta.md"));
  closeBtn("beta.md")._fire("click", { stopPropagation() {} });
  store.applyEvent({ type: "session.closed", sessionId: SID });
  ok("a removed session takes its tombstones with it", __pendingClosesForTest(SID).length === 0);

  console.log(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
} catch (e) { console.log("THREW", e && e.stack || e); fail++; }
process.exit(fail === 0 ? 0 : 1);
