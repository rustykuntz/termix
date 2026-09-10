// Canonical conversation history UI: requester-only paging, chronological prepend, lazy top-scroll load,
// and pointer/keyboard focus restoration. Runs the actual store + ws + history module in the fake DOM.
import { installFakeDom, installFakeWs } from "./fakedom.mjs";
const dom = installFakeDom();
const ws = installFakeWs();

const trigger = document.createElement("button"); trigger.id = "th-history"; document.body.appendChild(trigger);
const terminal = document.createElement("textarea"); terminal.id = "term-focus"; document.body.appendChild(terminal);

const { store } = await import("../public/js/store.js");
const { connectWs } = await import("../public/js/ws.js");
const { initHistory } = await import("../public/js/ui/history.js");

let pass = 0, fail = 0;
const ok = (name, condition) => {
  if (condition) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name); }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  connectWs(); await sleep(5);
  store.applyEvent({ type: "session.created", sessionId: "A", cwd: "/a", name: "Codex", live: true, pid: 1 });
  initHistory(() => terminal);

  ws.clear(); trigger._fire("click", { detail: 1 });
  ok("opening history requests only the newest page", (() => {
    const m = ws.last("transcript.page");
    return m && m.sessionId === "A" && m.limit === 30 && m.before === undefined;
  })());
  store.applyEvent({
    type: "transcript.page.result", sessionId: "A", before: null, success: true, cursor: 50, hasMore: true,
    turns: [
      { ts: 2, role: "user", text: "second question" },
      { ts: 3, role: "agent", text: "second answer" },
    ],
  });
  await sleep(5);
  ok("newest page renders in chronological order", (() => {
    const rows = document.querySelectorAll(".hist-turn");
    return rows.length === 2
      && rows[0].querySelector(".hist-text").textContent === "second question"
      && rows[1].querySelector(".hist-text").textContent === "second answer";
  })());

  ws.clear();
  const list = document.querySelector(".hist-list"); list.scrollTop = 0; list._fire("scroll");
  ok("scrolling to the top requests the previous cursor", (() => {
    const m = ws.last("transcript.page"); return m && m.before === 50 && m.limit === 30;
  })());
  store.applyEvent({
    type: "transcript.page.result", sessionId: "A", before: 50, success: true, cursor: null, hasMore: false,
    turns: [{ ts: 1, role: "user", text: "first question" }],
  });
  await sleep(5);
  ok("older page prepends without duplicating newer turns", (() => {
    const rows = document.querySelectorAll(".hist-turn");
    return rows.length === 3
      && rows[0].querySelector(".hist-text").textContent === "first question"
      && rows[2].querySelector(".hist-text").textContent === "second answer";
  })());
  ok("end of history is explicit", document.querySelector(".hist-more").textContent === "Beginning of conversation");

  dom.docFire("keydown", { key: "Escape", preventDefault() {}, stopPropagation() {} });
  ok("pointer-opened history returns focus to the terminal", document.activeElement === terminal);
  await sleep(200);

  trigger._fire("click", { detail: 0 });
  store.applyEvent({ type: "transcript.page.result", sessionId: "A", before: null, success: true, cursor: null, hasMore: false, turns: [] });
  document.querySelector(".hist-close")._fire("click");
  ok("keyboard-opened history returns focus to its trigger", document.activeElement === trigger);

  // ══ scroll-driven lazy loading — there is NO button; scrolling is the only affordance ══
  // reopen (the focus test above closed it) and seed a page that still has older history behind it
  await sleep(220);                       // let the previous overlay finish its close animation and detach
  ws.clear(); trigger._fire("click", { detail: 1 });
  store.applyEvent({ type: "transcript.page.result", sessionId: "A", before: null, success: true, cursor: 50,
    hasMore: true, turns: [{ ts: 9, role: "user", text: "newest" }] });
  await sleep(5);
  const strip = () => [...document.querySelectorAll(".hist-more")].pop();   // always the LIVE modal's status
  const status = strip();
  ok("the strip is passive status, not a control", status.tag === "div" && status.textContent.indexOf("Load older") === -1);
  ok("resting copy tells you to scroll, it doesn't offer a click", /Scroll up|Beginning of conversation|No saved/.test(status.textContent));

  // scrolling near the top pulls the next page in on its own
  const listEl = [...document.querySelectorAll(".hist-list")].pop();
  ws.clear();
  listEl.scrollTop = 10; listEl._fire("scroll");
  ok("scrolling near the top auto-requests older turns", !!ws.last("transcript.page"));
  ok("status switches to loading while in flight", /Loading older/.test(strip().textContent));

  // a failed page must not dead-end: scrolling again retries
  store.applyEvent({ type: "transcript.page.result", sessionId: "A", before: 50, success: false, error: "" });
  await sleep(5);
  ok("a failed page explains itself and points at scrolling", /scroll up to retry/i.test(strip().textContent));
  ws.clear();
  listEl.scrollTop = 5; listEl._fire("scroll");
  ok("scrolling again RETRIES after a failure (no dead end)", !!ws.last("transcript.page"));

  console.log(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
} catch (error) {
  console.log("THREW", error && error.stack || error); fail++;
}
process.exit(fail === 0 ? 0 : 1);
