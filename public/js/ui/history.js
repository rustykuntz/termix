// Read-only canonical conversation history. The terminal remains a bounded live surface; older user/agent
// turns are fetched from the append-only transcript JSONL in small pages as this list is scrolled upward.
import { store } from "../store.js";
import { requestTranscriptPage } from "../ws.js";
import { h, shortId } from "../util.js";

const PAGE_SIZE = 30;
const NEAR_TOP = 64;          // px from the top that pulls the next page in
const CLOSE_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

let overlay = null;
let list = null;
let more = null;
let sessionId = null;
let cursor;
let requestedBefore = null;
let loading = false;
let hasMore = true;
let failed = false;           // last page errored; cleared by scrolling up again (no retry button)
let lastError = "";
let returnFocus = null;
let offPage = null;
let offActive = null;
let offRemove = null;

export function initHistory(terminalFocusTarget) {
  const trigger = document.getElementById("th-history");
  if (!trigger) return;
  trigger.addEventListener("click", (event) => {
    const focus = event.detail === 0 ? trigger : terminalFocusTarget && terminalFocusTarget();
    openHistory(focus || trigger);
  });
}

function openHistory(focusTarget) {
  const session = store.active();
  if (!session) return;
  closeHistory(false);
  sessionId = session.id;
  cursor = undefined;
  loading = false;
  hasMore = true;
  failed = false; lastError = "";
  returnFocus = focusTarget;

  overlay = h("div", "hist-overlay");
  const modal = h("div", "hist-modal");
  const head = h("div", "hist-head");
  const heading = h("div", "hist-heading");
  heading.append(h("div", "hist-title", "Conversation history"));
  const subtitle = h("div", "hist-subtitle");
  subtitle.textContent = session.name || shortId(session.id);
  heading.append(subtitle);
  const close = h("button", "hist-close", CLOSE_ICON);
  close.type = "button"; close.title = "Close"; close.setAttribute("aria-label", "Close");
  close.onclick = () => closeHistory();
  head.append(heading, close);

  list = h("div", "hist-list");
  // Status strip, NOT a control: older turns arrive by scrolling, the way image lazy-loading works. There is
  // nothing to click here — it only ever reports loading / end-of-history / a failed page.
  more = h("div", "hist-more");
  more.setAttribute("aria-live", "polite");
  list.append(more);
  list.addEventListener("scroll", onScroll);
  modal.append(head, list);
  overlay.append(modal);
  overlay.addEventListener("mousedown", (event) => {
    event.stopPropagation();
    if (event.target === overlay) closeHistory();
  });
  overlay.addEventListener("click", (event) => event.stopPropagation());
  document.body.append(overlay);
  document.body.classList.add("cd-modal-open");
  document.addEventListener("keydown", onKey, true);
  offPage = store.on("transcript:page", onPage);
  offActive = store.on("active", (id) => { if (id !== sessionId) closeHistory(); });
  offRemove = store.on("session:remove", (id) => { if (id === sessionId) closeHistory(); });
  requestAnimationFrame(() => overlay && overlay.classList.add("show"));
  loadOlder();
}

// Nearing the top pulls the next page in. A failed page is not a dead end: `failed` is cleared here, so simply
// scrolling up again retries — no retry button, no backoff machinery.
function onScroll() {
  if (!list || list.scrollTop >= NEAR_TOP) return;
  if (failed) { failed = false; renderMore(); }
  loadOlder();
}

function loadOlder() {
  if (!overlay || loading || !hasMore || failed) return;
  loading = true;
  requestedBefore = Number.isSafeInteger(cursor) ? cursor : null;
  renderMore();
  requestTranscriptPage(sessionId, cursor, PAGE_SIZE);
}

// Lazy loading needs something to scroll. If a page doesn't overflow the panel there is no scrollbar and no
// scroll event will ever fire, so keep pulling until the list is actually scrollable or history runs out.
function fillViewport() {
  if (!list || loading || !hasMore || failed) return;
  if (list.scrollHeight <= list.clientHeight + NEAR_TOP) loadOlder();
}

function onPage(result) {
  if (!overlay || result.sessionId !== sessionId || !loading
    || (result.before ?? null) !== requestedBefore) return;
  loading = false;
  if (!result.success) {
    failed = true;                       // scrolling up again clears this and retries (onScroll)
    lastError = result.error || "";
    renderMore();
    more.classList.add("error");
    return;
  }

  const initial = cursor === undefined;
  const oldHeight = Number(list.scrollHeight) || 0;
  const turns = Array.isArray(result.turns) ? result.turns : [];
  // `children` is an HTMLCollection in a real browser — it has no indexOf, so the old lookup threw here on
  // EVERY page and nothing ever rendered. The status strip is always first, so older turns insert right after it.
  const anchor = more.nextSibling || null;
  for (const turn of turns) list.insertBefore(turnElement(turn), anchor);
  cursor = Number.isSafeInteger(result.cursor) ? result.cursor : null;
  hasMore = result.hasMore === true;
  renderMore(turns.length === 0 && initial);
  requestAnimationFrame(() => {
    if (!list) return;
    // Anchor the reader: on the first page land at the newest turn, afterwards keep the turn they were looking
    // at exactly where it was while older content is prepended above it.
    if (initial) list.scrollTop = list.scrollHeight;
    else list.scrollTop += Math.max(0, (Number(list.scrollHeight) || 0) - oldHeight);
    fillViewport();                      // a short page leaves nothing to scroll — keep pulling until it does
  });
}

function turnElement(turn) {
  const role = turn.role === "user" ? "user" : "agent";
  const row = h("article", "hist-turn " + role);
  const meta = h("div", "hist-turn-meta");
  meta.append(h("span", "hist-role", role === "user" ? "You" : "Agent"));
  if (turn.ts) {
    const time = h("time", "hist-time");
    const date = new Date(turn.ts);
    if (!Number.isNaN(date.getTime())) time.textContent = date.toLocaleString();
    if (time.textContent) meta.append(time);
  }
  const text = h("pre", "hist-text");
  text.textContent = String(turn.text || "");
  row.append(meta, text);
  return row;
}

function renderMore(empty = false) {
  if (!more) return;
  more.classList.remove("error");
  // Pure status. "Load older messages" is gone — scrolling is the affordance, so the resting state says what
  // to do rather than offering a control.
  if (loading) more.textContent = "Loading older messages…";
  else if (failed) more.textContent = lastError || "Couldn't load older messages — scroll up to retry";
  else if (empty) more.textContent = "No saved conversation yet";
  else if (hasMore) more.textContent = "Scroll up for older messages";
  else more.textContent = "Beginning of conversation";
}

function onKey(event) {
  if (event.key !== "Escape") return;
  event.preventDefault(); event.stopPropagation(); closeHistory();
}

function closeHistory(restore = true) {
  if (!overlay) return;
  document.removeEventListener("keydown", onKey, true);
  if (offPage) offPage(); if (offActive) offActive(); if (offRemove) offRemove();
  offPage = offActive = offRemove = null;
  const node = overlay;
  const focus = returnFocus;
  overlay = list = more = null;
  sessionId = null; cursor = undefined; requestedBefore = null;
  loading = false; hasMore = true; failed = false; lastError = ""; returnFocus = null;
  node.classList.remove("show");
  setTimeout(() => { node.remove(); if (!overlay) document.body.classList.remove("cd-modal-open"); }, 180);
  if (restore && focus && focus.focus) focus.focus();
}
