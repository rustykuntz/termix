// One registry for core and plugin viewers/workspaces. Core entries may carry a host build() function; plugin
// entries are declarative and always render in a sandboxed iframe supplied by content-dock.js.

const viewers = new Map();
const workspaces = new Map();
const listeners = new Set();
const safeId = (value) => /^[a-z][a-z0-9-]{0,62}$/.test(String(value || ""));
function changed() { for (const fn of listeners) fn(); }

function kindsFor(pluginId, def) {
  const raw = Array.isArray(def.kinds) ? def.kinds : def.kind ? [def.kind] : [];
  return raw.map((kind) => {
    kind = String(kind || "").trim();
    if (!kind) return "";
    return kind.includes("/") ? kind : pluginId + "/" + kind;
  }).filter((kind) => kind.startsWith(pluginId + "/") && kind.length <= 160);
}

export function registerCoreViewer(definition) {
  if (!definition || !definition.kind || typeof definition.build !== "function") return () => {};
  const key = String(definition.kind);
  viewers.set(key, { ...definition, pluginId: "core", kind: key }); changed();
  return () => { if (viewers.delete(key)) changed(); };
}

export function registerPluginViewer(pluginId, definition) {
  if (!safeId(pluginId) || !definition || typeof definition !== "object") return () => {};
  const src = String(definition.src || definition.url || "");
  const kinds = kindsFor(pluginId, definition);
  if (!src || !kinds.length) return () => {};
  const entries = kinds.map((kind) => ({
    pluginId, kind, src,
    title: String(definition.title || definition.label || kind.split("/").pop()).slice(0, 120),
    icon: String(definition.icon || "").slice(0, 24),
  }));
  for (const entry of entries) if (!viewers.has(entry.kind)) viewers.set(entry.kind, entry);
  changed();
  return () => { let any = false; for (const entry of entries) if (viewers.get(entry.kind) === entry) { viewers.delete(entry.kind); any = true; } if (any) changed(); };
}

export function registerWorkspace(pluginId, definition) {
  if (!safeId(pluginId) || !definition || !safeId(definition.id)) return () => {};
  const src = String(definition.src || definition.url || ""); if (!src) return () => {};
  const key = pluginId + "/" + definition.id;
  if (workspaces.has(key)) return () => {};
  const entry = { pluginId, id: definition.id, src, title: String(definition.title || definition.label || definition.id).slice(0, 120), icon: String(definition.icon || "").slice(0, 24) };
  workspaces.set(key, entry); changed();
  return () => { if (workspaces.get(key) === entry) { workspaces.delete(key); changed(); } };
}

export function viewerFor(kind) { return viewers.get(String(kind || "")) || null; }
export function workspaceFor(pluginId, id) { return workspaces.get(pluginId + "/" + id) || null; }
export function isRenderableKind(kind) { return viewers.has(String(kind || "")); }
// A well-formed `plugin/kind` from the engine, whether or not anything is registered to draw it. A plugin's
// content is PERSISTED, so it outlives the plugin being disabled — and the host still has to give the user a
// tab for it, or the asset is held by the engine with nothing on screen to close.
const PLUGIN_KIND = /^[a-z][a-z0-9-]{0,62}\/[a-z][a-z0-9-]{0,62}$/;
export function isPluginKind(kind) { return PLUGIN_KIND.test(String(kind || "")); }
export function iconForKind(kind) { return (viewerFor(kind) || {}).icon || ""; }

export function unregisterViewersForPlugin(pluginId) {
  let any = false;
  for (const [key, value] of viewers) if (value.pluginId === pluginId) { viewers.delete(key); any = true; }
  for (const [key, value] of workspaces) if (value.pluginId === pluginId) { workspaces.delete(key); any = true; }
  if (any) changed();
}
export function onViewersChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
