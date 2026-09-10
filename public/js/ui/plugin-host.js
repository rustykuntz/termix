// Browser plugin host. client.js runs in a module Worker, never in CliDeck's window. The host owns every
// visible surface and converts Worker registrations into action/viewer/workspace records with deterministic
// teardown on disable, failure, replacement, or reconnect.
import { store } from "../store.js";
import { sendPluginMessage } from "../ws.js";
import { terminalSelection, terminalFocusTarget, commitTerminalDraft, getTerminalSelectionSnapshot } from "./terminal.js";
import { registerHotkey, unregisterHotkey, unregisterAllForPlugin } from "./hotkeys.js";
import { registerAction, unregisterActionsForPlugin, resolveActions, runAction, onActionsChange, setActionErrorHandler } from "./action-registry.js";
import { registerPluginViewer, registerWorkspace, unregisterViewersForPlugin, workspaceFor } from "./viewer-registry.js";
import { openWorkspaceTab, closePluginTabs, getActiveViewerText, getActiveViewerTextSnapshot } from "./content-dock.js";
import { openMenu, closeMenu } from "./menu.js";
import { toast } from "./toast.js";
import { playPluginAudio, playPluginAudioAndWait, stopPluginAudio, togglePluginAudio } from "./plugin-audio.js";
import { startPluginMicrophone, stopPluginMicrophone } from "./plugin-microphone.js";
import { openPluginComposition, updatePluginComposition, closePluginComposition } from "./plugin-composition.js";
import { openPluginPicker, closePluginPicker } from "./plugin-picker.js";

const runtimes = new Map();           // pluginId -> Runtime
const errors = new Map();             // local client failures; engine worker status remains authoritative separately
const listeners = new Set();
let headerBtn = null, headerPaintSeq = 0;

function notify() { for (const fn of listeners) fn(); paintHeader(); }
function clientSettings(plugin) {
  const secret = new Set((plugin.settings || []).filter((setting) => setting.type === "secret").map((setting) => setting.key));
  for (const key of Object.keys(plugin.configured || {})) secret.add(key);
  const values = {}; for (const [key, value] of Object.entries(plugin.values || {})) if (!secret.has(key)) values[key] = value;
  const configured = {}; for (const key of secret) configured[key] = !!(plugin.configured && plugin.configured[key]);
  return { values, configured };
}
function declaredViewer(plugin, definition) {
  const id = String(definition && definition.id || ""), rawKind = String(definition && definition.kind || "");
  const kind = rawKind.includes("/") ? rawKind : plugin.id + "/" + rawKind;
  return !!id && !!rawKind && (plugin.viewers || []).some((viewer) => viewer.id === id && viewer.kind === kind);
}
function projectFor(session) { return session && session.projectId ? store.projects.find((p) => p.id === session.projectId) || null : null; }
function sessionSnapshot(session) {
  if (!session) return null;
  return { id: session.id, name: session.name || "", provider: session.provider || "", cwd: session.cwd || "", projectId: session.projectId || null, live: session.live !== false, status: session.status || "" };
}
// `selection.anchor` is an opaque token saying WHERE on the terminal those cells are — a plugin carries it
// back untouched (read-along, speech caching) and never parses it. Empty on every other surface, and empty
// when the terminal cannot place the selection; `selection.text` is unchanged either way.
export function pluginActionContext(surface, selection, extra = {}) {
  const session = store.active();
  const anchor = surface === "terminal" ? (getTerminalSelectionSnapshot() || {}).anchor || "" : "";
  return {
    surface,
    selection: { text: String(selection || ""), surface, anchor },
    session: sessionSnapshot(session),
    project: projectFor(session),
    ...extra,
  };
}

class Runtime {
  constructor(plugin) {
    this.plugin = plugin; this.cleanups = new Map(); this.pending = new Map(); this.seq = 0; this.ready = false;
    const workerUrl = "/js/plugin-client-worker.js?id=" + encodeURIComponent(plugin.id);
    this.worker = new Worker(workerUrl, { type: "module", name: "clideck-plugin-" + plugin.id });
    this.worker.onmessage = (event) => this.message(event.data || {});
    this.worker.onerror = (event) => this.fail(event.message || "Plugin client worker crashed.");
    const settings = clientSettings(plugin);
    this.settingsSignature = JSON.stringify(settings);
    this.worker.postMessage({ type: "init", clientUrl: plugin.clientUrl + "?v=" + encodeURIComponent(plugin.version || "0"), settings });
  }
  signature() { return this.plugin.clientUrl + "|" + this.plugin.version; }
  update(plugin) {
    this.plugin = plugin;
    const settings = clientSettings(plugin), signature = JSON.stringify(settings);
    if (signature !== this.settingsSignature) { this.settingsSignature = signature; this.worker.postMessage({ type: "settings", settings }); }
  }
  invoke(method, id, context) {
    const requestId = "h" + (++this.seq);
    return new Promise((resolve, reject) => {
      const predicate = method === "match-action";
      const timer = predicate ? setTimeout(() => {
        this.pending.delete(requestId);
        resolve(false);
      }, 120) : null;
      this.pending.set(requestId, { resolve, reject, timer });
      this.worker.postMessage({ type: "invoke", requestId, method, id, context });
    });
  }
  response(requestId, success, value, error) { this.worker.postMessage({ type: "response", requestId, success, value, error }); }
  async request(message) {
    const id = this.plugin.id;
    try {
      let value;
      if (message.method === "get-active-session") value = sessionSnapshot(store.active());
      else if (message.method === "get-terminal-selection") value = terminalSelection();
      else if (message.method === "get-terminal-selection-snapshot") value = getTerminalSelectionSnapshot();
      else if (message.method === "get-active-viewer-text") value = await getActiveViewerTextSnapshot();
      else if (message.method === "get-viewer-text") value = await getActiveViewerText(message.contentId);
      else if (message.method === "open-picker") value = await openPluginPicker(id, message.options);
      else if (message.method === "toggle-audio") value = togglePluginAudio(id);
      else if (message.method === "play-audio-wait") value = await playPluginAudioAndWait(id, message.buffer, message.options || {});
      else if (message.method === "start-microphone") {
        value = await startPluginMicrophone(id,
          (buffer, info) => this.worker.postMessage({ type: "microphone-data", buffer, info }, [buffer]),
          (state) => this.worker.postMessage({ type: "microphone-state", state }));
      }
      else if (message.method === "stop-microphone") value = await stopPluginMicrophone(id);
      else if (message.method === "open-terminal-composition") {
        value = openPluginComposition(id, message.options, (action) => this.worker.postMessage({ type: "terminal-composition-action", action }));
      }
      else if (message.method === "commit-terminal-draft") value = commitTerminalDraft(message.text, message.options);
      else { this.response(message.requestId, false, null, "Unknown host request."); return; }
      this.response(message.requestId, true, value);
    } catch (error) { this.response(message.requestId, false, null, error && error.message || String(error)); }
  }
  setCleanup(key, cleanup) { const prev = this.cleanups.get(key); if (prev) prev(); this.cleanups.set(key, cleanup); }
  dropCleanup(key) { const cleanup = this.cleanups.get(key); if (cleanup) cleanup(); this.cleanups.delete(key); }
  message(message) {
    const id = this.plugin.id;
    if (message.type === "ready") { this.ready = true; errors.delete(id); notify(); return; }
    if (message.type === "failed") { this.fail(message.error || "Plugin client failed to load."); return; }
    if (message.type === "runtime-error") { clientError(id, message.error || "Plugin client action failed."); return; }
    if (message.type === "invoke-result") {
      const pending = this.pending.get(message.requestId); if (!pending) return;
      this.pending.delete(message.requestId); clearTimeout(pending.timer);
      if (message.success) pending.resolve(message.value); else pending.reject(new Error(message.error || "Plugin action failed."));
      return;
    }
    if (message.type === "register-action") this.setCleanup("action:" + message.definition.id, registerAction(id, message.definition, (...args) => this.invoke(...args)));
    else if (message.type === "unregister-action") this.dropCleanup("action:" + message.id);
    else if (message.type === "register-viewer") {
      if (!declaredViewer(this.plugin, message.definition)) { clientError(id, "Client viewer is not declared in the plugin manifest."); return; }
      this.setCleanup("viewer:" + String(message.registrationId || "default"), registerPluginViewer(id, message.definition));
    }
    else if (message.type === "unregister-viewer") this.dropCleanup("viewer:" + String(message.id || "default"));
    else if (message.type === "register-workspace") this.setCleanup("workspace:" + String(message.definition && message.definition.id || ""), registerWorkspace(id, message.definition));
    else if (message.type === "unregister-workspace") this.dropCleanup("workspace:" + String(message.id || ""));
    else if (message.type === "open-workspace") {
      const def = workspaceFor(id, message.id); if (def) openWorkspaceTab(id, def, message.options || {});
    } else if (message.type === "register-hotkey") {
      const combo = String(message.combo || "");
      if (registerHotkey(id, combo, (event) => this.invoke("hotkey", combo, { key: event.key, code: event.code }))) this.setCleanup("hotkey:" + combo, () => unregisterHotkey(id, combo));
    } else if (message.type === "unregister-hotkey") this.dropCleanup("hotkey:" + String(message.combo || ""));
    else if (message.type === "send") sendPluginMessage(id, message.event, message.data);
    else if (message.type === "play-audio") playPluginAudio(id, message.buffer, message.options || {}).catch((error) => clientError(id, error.message));
    else if (message.type === "stop-audio") stopPluginAudio(id);
    else if (message.type === "terminal-composition-update") updatePluginComposition(id, message.patch);
    else if (message.type === "terminal-composition-close") closePluginComposition(id);
    else if (message.type === "toast") {
      const kind = ["success", "warn", "error"].includes(message.kind) ? message.kind : "info";
      toast[kind]({ ...(message.options || {}), title: (message.options && message.options.title) || this.plugin.name });
    } else if (message.type === "request") this.request(message);
  }
  deliver(event, data, requestId) { try { this.worker.postMessage({ type: "plugin-message", event, data, requestId }); } catch {} }
  fail(reason) { clientError(this.plugin.id, reason); this.stop(); }
  stop() {
    for (const cleanup of this.cleanups.values()) { try { cleanup(); } catch {} }
    this.cleanups.clear(); stopPluginAudio(this.plugin.id); stopPluginMicrophone(this.plugin.id); closePluginComposition(this.plugin.id); closePluginPicker(this.plugin.id); closePluginTabs(this.plugin.id); unregisterActionsForPlugin(this.plugin.id); unregisterViewersForPlugin(this.plugin.id); unregisterAllForPlugin(this.plugin.id);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Plugin client stopped.")); }
    this.pending.clear();
    try { this.worker.postMessage({ type: "shutdown" }); setTimeout(() => this.worker.terminate(), 250); } catch {}
  }
}

function clientError(pluginId, reason) {
  const message = String(reason || "Plugin client failed.").split("\n")[0];
  errors.set(pluginId, message); notify();
  toast.error({ id: "plugin-client:" + pluginId, title: "Plugin client stopped", body: message });
}

function reconcile(plugins) {
  const wanted = new Map((plugins || []).map((plugin) => [plugin.id, plugin]));
  for (const [id, runtime] of [...runtimes]) {
    const plugin = wanted.get(id);
    const shouldRun = plugin && plugin.enabled && plugin.status === "ready" && plugin.clientUrl;
    if (!shouldRun || runtime.signature() !== plugin.clientUrl + "|" + plugin.version) { runtime.stop(); runtimes.delete(id); }
    else runtime.update(plugin);
  }
  for (const plugin of wanted.values()) {
    if (!plugin.enabled || plugin.status !== "ready" || !plugin.clientUrl || runtimes.has(plugin.id)) continue;
    try { runtimes.set(plugin.id, new Runtime(plugin)); }
    catch (error) { clientError(plugin.id, error.message); }
  }
  for (const id of [...errors.keys()]) if (!wanted.has(id)) errors.delete(id);
  notify();
}

async function paintHeader() {
  if (!headerBtn) return;
  const seq = ++headerPaintSeq;
  const [terminal, toolbar] = await Promise.all([
    resolveActions("terminal.header", pluginActionContext("terminal", "")),
    resolveActions("toolbar", pluginActionContext("toolbar", "")),
  ]);
  const actions = [...terminal, ...toolbar];
  if (seq !== headerPaintSeq) return;
  headerBtn.hidden = !actions.length;
  headerBtn._actions = actions;
}

// A plugin declares `icon` as a SHORT STRING, never markup: either one of the deck's named marks below, or a
// single glyph it draws itself. Anything else falls back to the plugin mark, so an unknown name degrades to a
// row that still lines up rather than to the literal word "waveform" sitting where an icon belongs.
const NAMED_ICONS = {
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><line x1="12" y1="18" x2="12" y2="21"/>',
  waveform: '<path d="M3 12h2"/><path d="M8 7v10"/><path d="M12 4v16"/><path d="M16 8v8"/><path d="M20 11v2"/>',
  speaker: '<path d="M11 5L6 9H3v6h3l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>',
  text: '<path d="M4 7V5h16v2"/><path d="M12 5v14"/><path d="M9 19h6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  terminal: '<path d="M5 7l4 4-4 4"/><path d="M12 17h7"/>',
  plugin: '<rect x="4" y="4" width="6" height="6" rx="1.5"/><rect x="14" y="4" width="6" height="6" rx="1.5"/><rect x="4" y="14" width="6" height="6" rx="1.5"/><rect x="14" y="14" width="6" height="6" rx="1.5"/>',
};
function actionIcon(icon) {
  const name = String(icon || "");
  const node = document.createElement("span");
  if (name && !NAMED_ICONS[name] && [...name].length <= 2 && !/^[\w-]+$/.test(name)) { node.textContent = name; return node; }
  node.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">'
    + (NAMED_ICONS[name] || NAMED_ICONS.plugin) + "</svg>";
  return node;
}

function openHeaderMenu(event) {
  const actions = headerBtn && headerBtn._actions || []; if (!actions.length) return;
  headerBtn.setAttribute("aria-expanded", "true");
  openMenu(headerBtn, actions.map((action) => ({ label: action.label, icon: actionIcon(action.icon), onSelect: (ctl) => { ctl.close(); runAction(action, action.context); } })), {
    align: "end", returnFocus: headerBtn, pointerReturnFocus: terminalFocusTarget(), sourceEvent: event,
    onClose: () => headerBtn && headerBtn.setAttribute("aria-expanded", "false"),
  });
}

export function initPluginHost() {
  headerBtn = document.getElementById("plugin-actions");
  if (headerBtn) headerBtn.addEventListener("click", (event) => { if (headerBtn.getAttribute("aria-expanded") === "true") closeMenu(); else openHeaderMenu(event); });
  setActionErrorHandler((id, error) => clientError(id, error && error.message || error));
  onActionsChange(paintHeader);
  store.on("plugins", reconcile);
  store.on("plugin:message", (message) => runtimes.get(message.pluginId)?.deliver(message.event, message.data, message.requestId));
  store.on("active", paintHeader); store.on("session:update", (id) => { if (id === store.activeId) paintHeader(); });
  reconcile(store.plugins);
}

export function pluginClientError(pluginId) { return errors.get(pluginId) || ""; }
export function onPluginHostChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function __runtimeCountForTest() { return runtimes.size; }
