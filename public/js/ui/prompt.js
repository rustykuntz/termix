// R2 prompt surfaces: a blocked agent asks the user via prompt.show. Two flavors:
//  • question card — options[] → real buttons, else a text input + Send; shown prominently at the foot of the
//    terminal for the OPEN session (pulsing "waiting" state — the agent is blocked); other session → switch toast.
//  • annotate — an image + a drawing surface (annotate.js); Send → marks JSON.
// Either way the answer goes out as prompt.answer {promptId, value}. prompt.resolved {promptId} ALWAYS dismisses
// the card in every client (another client may answer first; it also fires on timeout / session close).
import { store } from "../store.js";
import { answerPrompt } from "../ws.js";
import { toast } from "./toast.js";
import { h, shortId } from "../util.js";
import { openAnnotate, closeAnnotate, annotateOpenFor } from "./annotate.js";

const ASK_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.2 9a2.8 2.8 0 0 1 5.5.8c0 1.9-2.8 2.5-2.8 2.5"/><path d="M12 17h.01"/></svg>';
const pending = new Map();        // sessionId -> ev (the full prompt.show)
const promptSession = new Map();  // promptId  -> sessionId
let card = null;

export function initPrompt() {
  store.on("prompt:show", onShow);
  store.on("prompt:resolved", onResolved);
  store.on("active", renderActive);
  store.on("session:remove", (id) => { const ev = pending.get(id); if (ev) { promptSession.delete(ev.promptId); pending.delete(id); if (id === store.activeId) renderActive(); } });
  store.on("reset", () => { pending.clear(); promptSession.clear(); renderActive(); });
}

function label(sid) { const s = store.sessions.get(sid); return (s && (s.name || shortId(sid))) || shortId(sid) || "a session"; }

function onShow(ev) {
  if (!ev || !ev.promptId) return;
  pending.set(ev.sessionId, ev);
  promptSession.set(ev.promptId, ev.sessionId);
  if (ev.sessionId === store.activeId) renderActive();
  else toast.info({
    id: "prompt:" + ev.promptId,
    title: label(ev.sessionId),
    body: ev.annotate ? "wants you to annotate an image" : "is asking a question",
    iconHtml: ASK_ICON,
    duration: 0,   // sticky — a blocked agent shouldn't time its ask off the screen
    onClick: () => store.select(ev.sessionId),
  });
}

function onResolved(ev) {
  const sid = ev && ev.promptId != null ? promptSession.get(ev.promptId) : null;
  if (sid == null) { if (ev && annotateOpenFor() === ev.promptId) closeAnnotate(); return; }
  promptSession.delete(ev.promptId);
  pending.delete(sid);
  if (sid === store.activeId) renderActive();
  if (annotateOpenFor() === ev.promptId) closeAnnotate();
}

function answer(promptId, value) {
  const sid = promptSession.get(promptId);
  answerPrompt(promptId, value);
  if (sid != null) { promptSession.delete(promptId); pending.delete(sid); }   // optimistic dismiss; prompt.resolved re-affirms
  renderActive();
  if (annotateOpenFor() === promptId) closeAnnotate();
}

// Reconcile the surfaces to the ACTIVE session's pending prompt.
function renderActive() {
  const ev = pending.get(store.activeId);
  if (!ev) { hideCard(); if (annotateOpenFor()) closeAnnotate(); return; }
  if (ev.annotate) {
    hideCard();
    if (annotateOpenFor() !== ev.promptId) openAnnotate(ev, (value) => answer(ev.promptId, value));
    return;
  }
  if (annotateOpenFor()) closeAnnotate();
  showCard(ev);
}

function showCard(ev) {
  const frame = document.querySelector(".term-frame");
  if (!frame) return;
  if (!card) { card = h("div", "pcard"); }
  card.replaceChildren();
  card.appendChild(h("div", "pcard-glow"));
  const q = h("div", "pcard-q"); q.textContent = ev.question || "The agent is waiting for your input"; card.appendChild(q);
  const actions = h("div", "pcard-actions");
  const opts = Array.isArray(ev.options) ? ev.options.filter((o) => o != null && String(o) !== "") : [];
  if (opts.length) {
    for (const opt of opts) { const b = h("button", "pcard-opt"); b.type = "button"; b.textContent = String(opt); b.addEventListener("click", () => answer(ev.promptId, String(opt))); actions.appendChild(b); }
  } else {
    const input = h("input", "pcard-input"); input.type = "text"; input.placeholder = "Type your answer…"; input.spellcheck = false; input.autocomplete = "off";
    const send = h("button", "pcard-send"); send.type = "button"; send.textContent = "Send";
    const go = () => { answer(ev.promptId, input.value); };
    send.addEventListener("click", go);
    input.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); go(); } });
    actions.append(input, send);
    setTimeout(() => input.focus(), 0);
  }
  card.appendChild(actions);
  if (card.parentNode !== frame) frame.appendChild(card);
  card.classList.add("show");
}

function hideCard() { if (card && card.parentNode) { card.classList.remove("show"); card.remove(); } }
