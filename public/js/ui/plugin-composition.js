// A single host-owned terminal composition surface for sandboxed plugin Workers. Plugins provide plain state
// and draft text; CliDeck owns markup, focus, accessibility, actions, responsive layout and session binding.
import { store } from "../store.js";
import { h } from "../util.js";

const STATES = new Set(["listening", "processing", "ready", "error"]);
const LABELS = { listening: "Listening", processing: "Processing", ready: "Draft ready", error: "Needs attention" };
let current = null, initialized = false;
const listeners = new Set();

function notify() { const state = current ? { pluginId: current.pluginId, sessionId: current.sessionId, state: current.options.state } : null; for (const fn of listeners) fn(state); }
function clean(options, previous = {}) {
  options = options && typeof options === "object" ? options : {};
  const state = STATES.has(options.state) ? options.state : (previous.state || "listening");
  return {
    state,
    title: String(options.title != null ? options.title : previous.title || "Voice input").slice(0, 80),
    draft: String(options.draft != null ? options.draft : previous.draft || "").slice(0, 16000),
    hint: String(options.hint != null ? options.hint : previous.hint || "").slice(0, 240),
    canSend: typeof options.canSend === "boolean" ? options.canSend : previous.canSend,
    canStop: typeof options.canStop === "boolean" ? options.canStop : previous.canStop,
  };
}
function button(cls, label, tip, action, icon) {
  const el = h("button", cls); el.type = "button"; el.innerHTML = icon;
  el.setAttribute("aria-label", label); el.setAttribute("title", tip); el.setAttribute("data-tip", tip);
  el.addEventListener("click", () => fire(action)); return el;
}
function build(record) {
  const shell = h("aside", "plugin-composition"); shell.setAttribute("role", "region"); shell.setAttribute("aria-label", record.options.title);
  const signal = h("div", "pc-signal"); signal.setAttribute("aria-hidden", "true"); for (let i = 0; i < 5; i++) signal.appendChild(h("i"));
  const content = h("div", "pc-content");
  const top = h("div", "pc-top"); const title = h("strong", "pc-title"); const state = h("span", "pc-state"); state.setAttribute("aria-live", "polite"); top.append(title, state);
  const draft = h("div", "pc-draft"); draft.setAttribute("role", "textbox"); draft.setAttribute("aria-readonly", "true"); draft.setAttribute("aria-label", "Dictation draft");
  const hint = h("div", "pc-hint"); content.append(top, draft, hint);
  const controls = h("div", "pc-controls"); controls.setAttribute("role", "group"); controls.setAttribute("aria-label", "Dictation controls");
  const cancel = button("pc-button pc-cancel", "Cancel dictation", "Cancel — discard draft", "cancel",
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M6 6l12 12"/></svg>');
  const stop = button("pc-button pc-stop", "Stop dictation", "Stop — paste draft without sending", "stop",
    '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>');
  const send = button("pc-button pc-send", "Send dictation", "Send — paste and submit", "send",
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 3L9.7 14.3"/><path d="M21 3l-7.2 18-4.1-6.7L3 10.2 21 3z"/></svg>');
  controls.append(cancel, stop, send); shell.append(signal, content, controls);
  record.elements = { shell, title, state, draft, hint, stop, send }; paint(record);
  (document.getElementById("term-panel") || document.body).appendChild(shell);
}
function paint(record) {
  const { options, elements } = record, state = options.state;
  elements.shell.className = "plugin-composition pc-" + state;
  elements.shell.setAttribute("aria-label", options.title);
  elements.title.textContent = options.title;
  elements.state.textContent = LABELS[state];
  elements.draft.textContent = options.draft || (state === "listening" ? "Start speaking…" : "No draft yet");
  elements.draft.classList.toggle("empty", !options.draft);
  elements.hint.textContent = options.hint || (state === "listening" ? "Your voice stays on this device until the plugin transcribes it." : "");
  elements.hint.hidden = !elements.hint.textContent;
  elements.stop.disabled = typeof options.canStop === "boolean" ? !options.canStop : state !== "listening";
  elements.send.disabled = typeof options.canSend === "boolean" ? !options.canSend : !options.draft.trim();
  notify();
}
function fire(type, reason) {
  if (!current) return;
  try { current.onAction({ type, sessionId: current.sessionId, ...(reason ? { reason } : {}) }); } catch {}
}
function closeRecord(record, reason) {
  if (!record || current !== record) return false;
  current = null; record.elements.shell.remove();
  if (reason) { try { record.onAction({ type: "cancel", sessionId: record.sessionId, reason }); } catch {} }
  notify(); return true;
}
function initialize() {
  if (initialized) return; initialized = true;
  store.on("active", (id) => { if (current && id !== current.sessionId) closeRecord(current, "session-changed"); });
  store.on("session:update", (id) => {
    if (!current || id !== current.sessionId) return;
    const session = store.sessions.get(id);
    if (!session || session.live === false) closeRecord(current, "session-ended");
  });
  store.on("reset", () => { if (current) closeRecord(current, "session-changed"); });
}

export function openPluginComposition(pluginId, options, onAction) {
  initialize(); pluginId = String(pluginId || "");
  const session = store.active();
  if (!session || session.live === false) throw new Error("A live terminal session is required.");
  if (current && current.pluginId !== pluginId) throw new Error("Another plugin is already using the terminal composition surface.");
  if (current) { current.options = clean(options, current.options); current.onAction = typeof onAction === "function" ? onAction : current.onAction; paint(current); return { sessionId: current.sessionId }; }
  current = { pluginId, sessionId: session.id, options: clean(options), onAction: typeof onAction === "function" ? onAction : () => {}, elements: null };
  build(current); return { sessionId: current.sessionId };
}
export function updatePluginComposition(pluginId, patch) {
  if (!current || current.pluginId !== pluginId) return false;
  current.options = clean(patch, current.options); paint(current); return true;
}
export function closePluginComposition(pluginId) { return !current || (pluginId && current.pluginId !== pluginId) ? false : closeRecord(current); }
export function pluginCompositionState() { return current ? { pluginId: current.pluginId, sessionId: current.sessionId, state: current.options.state } : null; }
export function onPluginCompositionChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
