// Sandboxed client runtime. Plugin client.js is imported here—never into the CliDeck window. Contributions
// are declarative messages; callbacks remain in this Worker and are invoked through bounded RPC.

const params = new URL(self.location.href).searchParams;
const pluginId = params.get("id") || "";
const MAX_AUDIO_BYTES = 64 * 1024 * 1024;
const actions = new Map(), hotkeys = new Map(), messageHandlers = new Map(), settingsHandlers = new Set();
const microphoneDataHandlers = new Set(), microphoneStateHandlers = new Set(), compositionActionHandlers = new Set();
let cleanup = null, seq = 0, activated = false, settingsState = { values: {}, configured: {} };
const pending = new Map();

function post(type, fields = {}) { self.postMessage({ type, ...fields }); }
function request(method, fields = {}) {
  const requestId = "w" + (++seq);
  post("request", { requestId, method, ...fields });
  return new Promise((resolve, reject) => pending.set(requestId, { resolve, reject }));
}
const safeData = (value) => { try { structuredClone(value); return value; } catch { return null; } };
function settingsSnapshot() { return structuredClone(settingsState); }
async function applySettings(value, notify = true) {
  const previous = settingsSnapshot();
  settingsState = {
    values: value && value.values && typeof value.values === "object" ? structuredClone(value.values) : {},
    configured: value && value.configured && typeof value.configured === "object" ? structuredClone(value.configured) : {},
  };
  if (!notify) return;
  const next = settingsSnapshot();
  for (const fn of settingsHandlers) { try { await fn(next, previous); } catch (error) { post("runtime-error", { error: error && error.message || String(error) }); } }
}

const api = Object.freeze({
  id: pluginId,
  send(event, data) { post("send", { event: String(event || ""), data: safeData(data) }); },
  onMessage(event, fn) {
    event = String(event || ""); if (!event || typeof fn !== "function") return () => {};
    let set = messageHandlers.get(event); if (!set) { set = new Set(); messageHandlers.set(event, set); }
    set.add(fn); return () => { set.delete(fn); if (!set.size) messageHandlers.delete(event); };
  },
  registerAction(def) {
    if (!def || typeof def !== "object" || typeof def.run !== "function") return () => {};
    const id = String(def.id || ""); actions.set(id, def);
    post("register-action", { definition: { id, label: def.label, placements: def.placements, icon: def.icon, description: def.description, hasWhen: typeof def.when === "function" } });
    return () => { actions.delete(id); post("unregister-action", { id }); };
  },
  registerViewer(definition) {
    const registrationId = String(definition && (definition.id || definition.kind) || "default");
    post("register-viewer", { registrationId, definition: safeData(definition) });
    return () => post("unregister-viewer", { id: registrationId });
  },
  registerWorkspace(definition) { post("register-workspace", { definition: safeData(definition) }); return () => post("unregister-workspace", { id: definition && definition.id }); },
  openWorkspace(id, options) { post("open-workspace", { id: String(id || ""), options: safeData(options || {}) }); },
  registerHotkey(combo, fn) {
    combo = String(combo || ""); if (!combo || typeof fn !== "function") return () => {};
    hotkeys.set(combo, fn); post("register-hotkey", { combo });
    return () => { hotkeys.delete(combo); post("unregister-hotkey", { combo }); };
  },
  getActiveSession() { return request("get-active-session"); },
  getTerminalSelection() { return request("get-terminal-selection"); },
  // The same selection plus an opaque anchor for where it sits. Carry the anchor back verbatim (playAudio's
  // readAlong, a speech cache key); it is derived, so an unchanged selection always spells the same string.
  getTerminalSelectionSnapshot() { return request("get-terminal-selection-snapshot"); },
  getActiveViewerText() { return request("get-active-viewer-text"); },
  getViewerText(contentId) { return request("get-viewer-text", { contentId: String(contentId || "") }); },
  openPicker(options) { return request("open-picker", { options: safeData(options || {}) }); },
  getSettings() { return settingsSnapshot(); },
  onSettingsChange(fn) { if (typeof fn !== "function") return () => {}; settingsHandlers.add(fn); return () => settingsHandlers.delete(fn); },
  toast(kind, options) { post("toast", { kind: String(kind || "info"), options: safeData(options || {}) }); },
  playAudio(buffer, options) {
    if (!(buffer instanceof ArrayBuffer)) throw new TypeError("playAudio expects an ArrayBuffer.");
    if (!buffer.byteLength || buffer.byteLength > MAX_AUDIO_BYTES) throw new RangeError("Plugin audio is empty or exceeds 64 MB.");
    self.postMessage({ type: "play-audio", buffer, options: safeData(options || {}) }, [buffer]);
  },
  // Same clip, but it answers when the clip is over: true for a natural end, false for stop / replacement /
  // unload / error, and false immediately for a clip whose `playbackId` was already cancelled. Sequencing a
  // long read is then a plain loop, with no queue in the host and no timers on either side.
  playAudioAndWait(buffer, options) {
    if (!(buffer instanceof ArrayBuffer)) throw new TypeError("playAudioAndWait expects an ArrayBuffer.");
    if (!buffer.byteLength || buffer.byteLength > MAX_AUDIO_BYTES) throw new RangeError("Plugin audio is empty or exceeds 64 MB.");
    const requestId = "w" + (++seq);
    self.postMessage({ type: "request", requestId, method: "play-audio-wait", buffer, options: safeData(options || {}) }, [buffer]);
    return new Promise((resolve, reject) => pending.set(requestId, { resolve, reject }));
  },
  toggleAudio() { return request("toggle-audio"); },
  stopAudio() { post("stop-audio"); },
  startMicrophone() { return request("start-microphone"); },
  stopMicrophone() { return request("stop-microphone"); },
  onMicrophoneData(fn) { if (typeof fn !== "function") return () => {}; microphoneDataHandlers.add(fn); return () => microphoneDataHandlers.delete(fn); },
  onMicrophoneState(fn) { if (typeof fn !== "function") return () => {}; microphoneStateHandlers.add(fn); return () => microphoneStateHandlers.delete(fn); },
  openTerminalComposition(options) { return request("open-terminal-composition", { options: safeData(options || {}) }); },
  updateTerminalComposition(patch) { post("terminal-composition-update", { patch: safeData(patch || {}) }); },
  closeTerminalComposition() { post("terminal-composition-close"); },
  onTerminalCompositionAction(fn) { if (typeof fn !== "function") return () => {}; compositionActionHandlers.add(fn); return () => compositionActionHandlers.delete(fn); },
  commitTerminalDraft(text, options = {}) {
    return request("commit-terminal-draft", {
      text: String(text == null ? "" : text),
      options: { sessionId: String(options.sessionId || ""), submit: options.submit === true },
    });
  },
});

async function invoke(message) {
  const id = String(message.id || ""), context = message.context || {};
  if (message.method === "match-action") { const a = actions.get(id); return a && typeof a.when === "function" ? !!(await a.when(context)) : !!a; }
  if (message.method === "run-action") { const a = actions.get(id); if (!a) throw new Error("Action is unavailable."); return a.run(context); }
  if (message.method === "hotkey") { const fn = hotkeys.get(id); if (!fn) throw new Error("Hotkey is unavailable."); return fn(context); }
  throw new Error("Unknown client invocation.");
}

self.onmessage = async (event) => {
  const message = event.data || {};
  if (message.type === "init") {
    if (activated) return; activated = true; await applySettings(message.settings, false);
    try {
      const module = await import(String(message.clientUrl || ""));
      if (typeof module.activate !== "function") throw new Error("client.js must export activate(api).");
      cleanup = await module.activate(api); post("ready");
    } catch (error) { post("failed", { error: error && error.message || String(error) }); }
  } else if (message.type === "settings") {
    await applySettings(message.settings);
  } else if (message.type === "invoke") {
    try { post("invoke-result", { requestId: message.requestId, success: true, value: safeData(await invoke(message)) }); }
    catch (error) { post("invoke-result", { requestId: message.requestId, success: false, error: error && error.message || String(error) }); }
  } else if (message.type === "plugin-message") {
    const meta = Object.freeze({ requestId: String(message.requestId || "") });
    for (const fn of messageHandlers.get(String(message.event || "")) || []) { try { await fn(message.data, meta); } catch (error) { post("runtime-error", { error: error && error.message || String(error) }); } }
  } else if (message.type === "microphone-data") {
    for (const fn of microphoneDataHandlers) { try { await fn(message.buffer, message.info || {}); } catch (error) { post("runtime-error", { error: error && error.message || String(error) }); } }
  } else if (message.type === "microphone-state") {
    for (const fn of microphoneStateHandlers) { try { await fn(message.state || {}); } catch (error) { post("runtime-error", { error: error && error.message || String(error) }); } }
  } else if (message.type === "terminal-composition-action") {
    for (const fn of compositionActionHandlers) { try { await fn(message.action || {}); } catch (error) { post("runtime-error", { error: error && error.message || String(error) }); } }
  } else if (message.type === "response") {
    const p = pending.get(message.requestId); if (!p) return; pending.delete(message.requestId);
    if (message.success) p.resolve(message.value); else p.reject(new Error(message.error || "Host request failed."));
  } else if (message.type === "shutdown") {
    try { if (typeof cleanup === "function") await cleanup(); } catch {}
    post("stopped"); self.close();
  }
};
