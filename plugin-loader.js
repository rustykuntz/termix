const { readdirSync, readFileSync, existsSync, mkdirSync, cpSync, rmSync } = require('fs');
const { createHash } = require('crypto');
const { join, sep } = require('path');
const { execFile: _execFile } = require('child_process');
// Windows needs shell:true for npm (it's npm.cmd, not a binary)
const npmExec = (args, opts, cb) => _execFile('npm', args, { ...opts, shell: process.platform === 'win32' }, cb);
const { DATA_DIR } = require('./paths');
const transcript = require('./transcript');

const PLUGINS_DIR = join(DATA_DIR, 'plugins');
mkdirSync(PLUGINS_DIR, { recursive: true });

// Seed bundled plugins — copy if missing, update if bundled version is newer
const BUNDLED_DIR = join(__dirname, 'plugins');
const depsChanged = new Set(); // plugins whose install inputs changed — need reinstall
if (existsSync(BUNDLED_DIR)) {
  for (const entry of readdirSync(BUNDLED_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const target = join(PLUGINS_DIR, entry.name);
    if (!existsSync(target)) {
      cpSync(join(BUNDLED_DIR, entry.name), target, { recursive: true });
      console.log(`[plugin] seeded ${entry.name}`);
    } else {
      try {
        const bundledManifest = JSON.parse(readFileSync(join(BUNDLED_DIR, entry.name, 'clideck-plugin.json'), 'utf8'));
        const installedManifestFile = existsSync(join(target, 'clideck-plugin.json')) ? join(target, 'clideck-plugin.json') : join(target, 'termix-plugin.json');
        const installedManifest = JSON.parse(readFileSync(installedManifestFile, 'utf8'));
        if (bundledManifest.version !== installedManifest.version) {
          // Check if install inputs changed before copying
          let needsReinstall = false;
          if (bundledManifest.install) {
            const installHash = (dir) => {
              const h = createHash('sha256');
              for (const f of ['package.json', 'package-lock.json']) {
                try { h.update(readFileSync(join(dir, f))); } catch {}
              }
              return h.digest('hex');
            };
            needsReinstall = installHash(target) !== installHash(join(BUNDLED_DIR, entry.name));
          }
          cpSync(join(BUNDLED_DIR, entry.name), target, { recursive: true });
          if (needsReinstall) depsChanged.add(bundledManifest.id || entry.name);
          console.log(`[plugin] updated ${entry.name} ${installedManifest.version} → ${bundledManifest.version}`);
        }
      } catch {}
    }
  }
}

const plugins = new Map();
const uninstalledPlugins = new Map(); // id → { manifest, dir }
const inputHooks = [];
const outputHooks = [];
const statusHooks = [];
const transcriptHooks = [];
const menuHooks = [];
const configHooks = [];
const sessionStatus = new Map(); // sessionId → boolean (dedup multi-client reports)
const autoApproveMenus = new Set(); // sessionIds where menus should be auto-approved
const frontendHandlers = new Map();
let broadcastFn = null;
let sessionsFn = null;
let getConfigFn = null;
let saveConfigFn = null;
let inputFn = null;
let createSessionFn = null;
let closeSessionFn = null;
const settingsChangeHandlers = new Map(); // pluginId → [fn]
const sessionPills = new Map(); // pillId → { pluginId, id, title, projectId, working, statusText, icon, logs[] }

function removeHooks(pluginId) {
  for (const arr of [inputHooks, outputHooks, statusHooks, transcriptHooks, menuHooks, configHooks]) {
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].pluginId === pluginId) arr.splice(i, 1);
    }
  }
  for (const key of frontendHandlers.keys()) {
    if (key.startsWith(`plugin.${pluginId}.`)) frontendHandlers.delete(key);
  }
  settingsChangeHandlers.delete(pluginId);
  for (const [id, pill] of sessionPills) {
    if (pill.pluginId === pluginId) {
      sessionPills.delete(id);
      broadcastFn?.({ type: 'pill.removed', id });
    }
  }
}

// Check if a plugin with install: "npm" has been installed.
// Config is the source of truth, but we self-correct if node_modules is missing.
function isInstalled(dir, manifest) {
  if (!manifest.install) return true; // no install step declared
  const cfg = getConfigFn?.();
  if (!cfg?.pluginInstalled?.[manifest.id]) return false;
  // Self-correct: config says installed but files are gone
  if (!existsSync(join(dir, 'node_modules'))) {
    console.log(`[plugin] ${manifest.name}: node_modules missing, resetting install state`);
    delete cfg.pluginInstalled[manifest.id];
    saveConfigFn?.(cfg);
    return false;
  }
  return true;
}

function readManifest(dir, name) {
  let manifest = { id: name, name, version: '0.0.0' };
  const manifestFile = existsSync(join(dir, 'clideck-plugin.json')) ? join(dir, 'clideck-plugin.json') : join(dir, 'termix-plugin.json');
  if (existsSync(manifestFile)) {
    try { manifest = { ...manifest, ...JSON.parse(readFileSync(manifestFile, 'utf8')) }; }
    catch (e) { console.error(`[plugin:${name}] bad manifest: ${e.message}`); return null; }
  }
  if (manifest.settings != null) {
    if (!Array.isArray(manifest.settings)) {
      console.error(`[plugin:${name}] manifest.settings must be an array, ignoring`);
      manifest.settings = [];
    } else {
      manifest.settings = manifest.settings.filter(s =>
        s && typeof s === 'object' && typeof s.key === 'string' && s.key
      );
    }
  }
  return manifest;
}

function loadPlugin(manifest, dir) {
  if (plugins.has(manifest.id)) return;
  const state = { manifest, dir, shutdownFns: [], actions: [], dynamicOptions: {} };
  plugins.set(manifest.id, state);
  try {
    const mod = require(join(dir, 'index.js'));
    if (typeof mod.init === 'function') mod.init(buildApi(manifest.id, dir, state));
    console.log(`[plugin] ${manifest.name} v${manifest.version}`);
  } catch (e) {
    console.error(`[plugin:${manifest.id}] init failed: ${e.message}`);
    removeHooks(manifest.id);
    plugins.delete(manifest.id);
  }
}

function init(broadcast, getSessions, getConfig, saveConfig, sessionInput, createProgrammatic, closeSession) {
  broadcastFn = broadcast;
  sessionsFn = getSessions;
  getConfigFn = getConfig;
  saveConfigFn = saveConfig;
  inputFn = sessionInput;
  createSessionFn = createProgrammatic;
  closeSessionFn = closeSession;

  // Clear install state only for bundled plugins whose dependencies changed
  if (depsChanged.size) {
    const cfg = getConfig();
    if (cfg?.pluginInstalled) {
      for (const id of depsChanged) {
        if (cfg.pluginInstalled[id]) {
          delete cfg.pluginInstalled[id];
          console.log(`[plugin] install inputs changed, cleared install state for ${id}`);
        }
      }
      saveConfig(cfg);
    }
  }

  for (const entry of readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(PLUGINS_DIR, entry.name);
    if (!existsSync(join(dir, 'index.js'))) continue;

    const manifest = readManifest(dir, entry.name);
    if (!manifest) continue;

    if (plugins.has(manifest.id) || uninstalledPlugins.has(manifest.id)) {
      console.error(`[plugin:${manifest.id}] duplicate ID, skipping ${dir}`);
      continue;
    }

    if (!isInstalled(dir, manifest)) {
      uninstalledPlugins.set(manifest.id, { manifest, dir });
      console.log(`[plugin] ${manifest.name} v${manifest.version} (not installed)`);
      continue;
    }

    loadPlugin(manifest, dir);
  }
}

function buildApi(pluginId, pluginDir, state) {
  return {
    version: 1,
    pluginId,
    pluginDir,

    onSessionInput(fn) { inputHooks.push({ pluginId, fn }); },
    onSessionOutput(fn) { outputHooks.push({ pluginId, fn }); },
    onStatusChange(fn) { statusHooks.push({ pluginId, fn }); },
    onTranscriptEntry(fn) { transcriptHooks.push({ pluginId, fn }); },
    onMenuDetected(fn) { menuHooks.push({ pluginId, fn }); },
    onConfigChange(fn) { configHooks.push({ pluginId, fn }); },

    sendToFrontend(event, data = {}) {
      broadcastFn?.({ ...data, type: `plugin.${pluginId}.${event}` });
    },
    onFrontendMessage(event, fn) {
      frontendHandlers.set(`plugin.${pluginId}.${event}`, fn);
    },

    getSession(id) {
      const s = sessionsFn?.()?.get(id);
      if (!s) return null;
      const state = sessionStatus.get(id) || '';
      return { id, name: s.name, cwd: s.cwd, commandId: s.commandId, presetId: s.presetId || 'shell', themeId: s.themeId, projectId: s.projectId, roleName: s.roleName || null, working: state.startsWith('1:') };
    },
    getSessions() {
      const sessions = sessionsFn?.();
      if (!sessions) return [];
      return [...sessions].map(([id, s]) => ({
        id, name: s.name, cwd: s.cwd, commandId: s.commandId, presetId: s.presetId || 'shell', themeId: s.themeId, projectId: s.projectId, roleName: s.roleName || null, working: (sessionStatus.get(id) || '').startsWith('1:'),
      }));
    },

    createSession(opts) {
      const cfg = getConfigFn?.();
      if (!cfg || !createSessionFn) return null;
      const result = createSessionFn(opts, cfg);
      return result.error ? null : result.id;
    },
    closeSession(id) {
      const cfg = getConfigFn?.();
      if (!cfg || !closeSessionFn) return;
      closeSessionFn({ id }, cfg);
    },

    inputToSession(id, data) { inputFn?.({ id, data }); },
    setAutoApproveMenu(id, enabled) { enabled ? autoApproveMenus.add(id) : autoApproveMenus.delete(id); },

    getRoles() { return JSON.parse(JSON.stringify(getConfigFn?.()?.roles || [])); },
    getProjects() { return JSON.parse(JSON.stringify(getConfigFn?.()?.projects || [])); },
    getTranscript(id, n) { return transcript.getLastTurns(id, n || 20); },
    detectMenu(lines, presetId) { return transcript.detectMenu(lines, presetId); },

    addToolbarAction(opts) { state.actions.push({ ...opts, pluginId, slot: 'toolbar' }); },
    addProjectAction(opts) { state.actions.push({ ...opts, pluginId, slot: 'project-header' }); },

    addSessionPill(opts) {
      const pill = { pluginId, id: opts.id, title: opts.title, projectId: opts.projectId, working: false, statusText: '', icon: opts.icon || '', logs: [], startedAt: Date.now() };
      sessionPills.set(opts.id, pill);
      broadcastFn?.({ type: 'pill.added', pill: pillInfo(pill) });
    },
    updateSessionPill(id, updates) {
      const pill = sessionPills.get(id);
      if (!pill || pill.pluginId !== pluginId) return;
      if (updates.title !== undefined) pill.title = updates.title;
      if (updates.working !== undefined) pill.working = updates.working;
      if (updates.statusText !== undefined) pill.statusText = updates.statusText;
      if (updates.projectId !== undefined) pill.projectId = updates.projectId;
      broadcastFn?.({ type: 'pill.updated', pill: pillInfo(pill) });
    },
    appendPillLog(id, text) {
      const pill = sessionPills.get(id);
      if (!pill || pill.pluginId !== pluginId) return;
      const entry = { ts: Date.now(), text };
      pill.logs.push(entry);
      if (pill.logs.length > 200) pill.logs.splice(0, pill.logs.length - 200);
      broadcastFn?.({ type: 'pill.log', id, entry });
    },
    removeSessionPill(id) {
      const pill = sessionPills.get(id);
      if (!pill || pill.pluginId !== pluginId) return;
      sessionPills.delete(id);
      broadcastFn?.({ type: 'pill.removed', id });
    },

    getSetting(key) {
      const cfg = getConfigFn?.();
      const defaults = {};
      for (const s of state.manifest.settings || []) defaults[s.key] = s.default;
      return cfg?.pluginSettings?.[pluginId]?.[key] ?? defaults[key];
    },
    getSettings() {
      const cfg = getConfigFn?.();
      const result = {};
      for (const s of state.manifest.settings || []) result[s.key] = s.default;
      return { ...result, ...cfg?.pluginSettings?.[pluginId] };
    },
    onSettingsChange(fn) {
      if (!settingsChangeHandlers.has(pluginId)) settingsChangeHandlers.set(pluginId, []);
      settingsChangeHandlers.get(pluginId).push(fn);
    },

    setSettingOptions(key, options) {
      state.dynamicOptions[key] = options;
      broadcastFn?.({ type: 'plugins', list: getInfo() });
    },
    setSetting(key, value) {
      updateSetting(pluginId, key, value);
      broadcastFn?.({ type: 'plugins', list: getInfo() });
    },

    resolve(specifier) {
      // Resolve from plugin-local node_modules first, then app-level
      const parts = specifier.startsWith('@') ? specifier.split('/').slice(0, 2) : [specifier.split('/')[0]];
      for (const base of [join(pluginDir, 'node_modules'), join(__dirname, 'node_modules')]) {
        const pkgDir = join(base, ...parts);
        try {
          const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
          const entry = typeof pkg.exports === 'string' ? pkg.exports
            : pkg.exports?.['.']?.import || pkg.exports?.['.']?.default || pkg.exports?.['.']
            || pkg.module || pkg.main || 'index.js';
          return join(pkgDir, entry);
        } catch {}
      }
      return require.resolve(specifier);
    },
    onShutdown(fn) { state.shutdownFns.push(fn); },
    log(msg) { console.log(`[plugin:${pluginId}] ${msg}`); },
  };
}

function transformInput(id, data) {
  if (!inputHooks.length) return data;
  let result = data;
  for (const h of inputHooks) {
    try {
      const out = h.fn(id, result);
      if (typeof out === 'string') result = out;
    } catch (e) { console.error(`[plugin:${h.pluginId}] input error: ${e.message}`); }
  }
  return result;
}

function notifyOutput(id, data) {
  for (const h of outputHooks) {
    try { h.fn(id, data); }
    catch (e) { console.error(`[plugin:${h.pluginId}] output error: ${e.message}`); }
  }
}

function notifyStatus(id, working, source) {
  const next = `${working ? 1 : 0}:${source || ''}`;
  if (sessionStatus.get(id) === next) return;
  sessionStatus.set(id, next);
  for (const h of statusHooks) {
    try { h.fn(id, working, source); }
    catch (e) { console.error(`[plugin:${h.pluginId}] status error: ${e.message}`); }
  }
}

function notifyTranscript(id, role, text) {
  for (const h of transcriptHooks) {
    try { h.fn(id, role, text); }
    catch (e) { console.error(`[plugin:${h.pluginId}] transcript error: ${e.message}`); }
  }
}

function notifyMenu(id, choices) {
  for (const h of menuHooks) {
    try { h.fn(id, choices); }
    catch (e) { console.error(`[plugin:${h.pluginId}] menu error: ${e.message}`); }
  }
}

function notifyConfig(cfg) {
  for (const h of configHooks) {
    try { h.fn(cfg); }
    catch (e) { console.error(`[plugin:${h.pluginId}] config error: ${e.message}`); }
  }
}


function updateSetting(pluginId, key, value) {
  // Validate plugin exists (also prevents __proto__ pollution — Map lookup returns undefined)
  const plugin = plugins.get(pluginId);
  if (!plugin) return;
  // Validate key is declared in manifest
  const settingDef = (plugin.manifest.settings || []).find(s => s.key === key);
  if (!settingDef) return;
  // Type-coerce/validate value against manifest type
  const dynOpts = settingDef.type === 'dynamic-select' ? plugin.dynamicOptions?.[key] : null;
  const coerced = coerceSetting(settingDef, value, dynOpts);
  if (coerced === undefined) return;

  const cfg = getConfigFn?.();
  if (!cfg) return;
  if (!cfg.pluginSettings) cfg.pluginSettings = Object.create(null);
  if (!cfg.pluginSettings[pluginId]) cfg.pluginSettings[pluginId] = Object.create(null);
  cfg.pluginSettings[pluginId][key] = coerced;
  saveConfigFn?.(cfg);
  const fns = settingsChangeHandlers.get(pluginId) || [];
  for (const fn of fns) {
    try { fn(key, coerced); }
    catch (e) { console.error(`[plugin:${pluginId}] settings handler error: ${e.message}`); }
  }
}

function coerceSetting(def, value, dynOpts) {
  switch (def.type) {
    case 'toggle': return !!value;
    case 'number': {
      const n = Number(value);
      if (!Number.isFinite(n)) return undefined;
      if (def.min != null && n < def.min) return undefined;
      if (def.max != null && n > def.max) return undefined;
      return n;
    }
    case 'select': {
      const opts = (def.options || []).map(o => String(typeof o === 'object' ? o.value : o));
      const s = String(value);
      return opts.includes(s) ? s : undefined;
    }
    case 'dynamic-select': {
      const s = String(value);
      if (!dynOpts?.length) return s; // options not loaded yet — accept
      const opts = dynOpts.map(o => String(typeof o === 'object' ? o.value : o));
      return opts.includes(s) ? s : undefined;
    }
    default: return String(value);
  }
}

function handleMessage(msg) {
  const fn = frontendHandlers.get(msg.type);
  if (!fn) return false;
  try { fn(msg); }
  catch (e) { console.error(`[plugin] handler error for ${msg.type}: ${e.message}`); }
  return true;
}

function getInfo() {
  const cfg = getConfigFn?.();
  const installed = [...plugins.values()].map(p => ({
    id: p.manifest.id,
    name: p.manifest.name,
    version: p.manifest.version,
    author: p.manifest.author || '',
    description: p.manifest.description || '',
    icon: p.manifest.icon || '',
    settings: p.manifest.settings || [],
    settingValues: cfg?.pluginSettings?.[p.manifest.id] || {},
    dynamicOptions: p.dynamicOptions || {},
    actions: p.actions,
    hasClient: existsSync(join(p.dir, 'client.js')),
    bundled: BUNDLED_IDS.has(p.manifest.id),
    installed: true,
  }));
  const pending = [...uninstalledPlugins.values()].map(u => ({
    id: u.manifest.id,
    name: u.manifest.name,
    version: u.manifest.version,
    author: u.manifest.author || '',
    description: u.manifest.description || '',
    icon: u.manifest.icon || '',
    settings: [],
    settingValues: {},
    dynamicOptions: {},
    actions: [],
    hasClient: false,
    bundled: BUNDLED_IDS.has(u.manifest.id),
    installed: false,
  }));
  return [...installed, ...pending];
}

function resolveFile(urlPath) {
  const m = urlPath.match(/^\/plugins\/([^/]+)\/(.+)$/);
  if (!m) return null;
  const [, id, rest] = m;
  const plugin = plugins.get(id);
  if (!plugin) return null;
  let file, allowed;
  if (rest === 'client.js') {
    file = join(plugin.dir, 'client.js');
    allowed = plugin.dir;
  } else {
    allowed = join(plugin.dir, 'public');
    file = join(allowed, rest);
  }
  if (!file.startsWith(allowed + sep)) return null;
  if (!existsSync(file)) return null;
  return file;
}

function shutdown() {
  for (const [id, p] of plugins) {
    for (const fn of p.shutdownFns) {
      try { fn(); }
      catch (e) { console.error(`[plugin:${id}] shutdown error: ${e.message}`); }
    }
  }
}

function pillInfo(pill) {
  return { id: pill.id, pluginId: pill.pluginId, title: pill.title, projectId: pill.projectId, working: pill.working, statusText: pill.statusText, icon: pill.icon, startedAt: pill.startedAt };
}

function getPills() { return [...sessionPills.values()].map(pillInfo); }
function getPillLogs(id) { return sessionPills.get(id)?.logs || []; }

function clearStatus(id) { sessionStatus.delete(id); autoApproveMenus.delete(id); }
function isWorking(id) { return !!sessionStatus.get(id); }
function shouldAutoApproveMenu(id) { return autoApproveMenus.has(id); }

// Bundled plugin IDs — these ship with CliDeck and must not be deleted
const BUNDLED_IDS = new Set(
  existsSync(BUNDLED_DIR)
    ? readdirSync(BUNDLED_DIR, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)
    : []
);

function installPlugin(pluginId, callback) {
  const entry = uninstalledPlugins.get(pluginId);
  if (!entry) return callback(new Error('Plugin not found or already installed'));
  const { manifest, dir } = entry;
  if (manifest.install !== 'npm') return callback(new Error(`Unknown install type: ${manifest.install}`));
  console.log(`[plugin] installing ${manifest.name}...`);
  npmExec(['install', '--production'], { cwd: dir, timeout: 120000 }, (err) => {
    if (err) {
      console.error(`[plugin:${pluginId}] install failed: ${err.message}`);
      return callback(err);
    }
    uninstalledPlugins.delete(pluginId);
    loadPlugin(manifest, dir);
    // Only persist install state if plugin actually loaded
    if (!plugins.has(pluginId)) {
      uninstalledPlugins.set(pluginId, { manifest, dir });
      return callback(new Error('Plugin installed but failed to load'));
    }
    const cfg = getConfigFn?.();
    if (cfg) {
      if (!cfg.pluginInstalled) cfg.pluginInstalled = {};
      cfg.pluginInstalled[pluginId] = true;
      saveConfigFn?.(cfg);
    }
    console.log(`[plugin] ${manifest.name} installed`);
    callback(null);
  });
}

function removePlugin(pluginId) {
  if (BUNDLED_IDS.has(pluginId)) return { success: false, message: 'Cannot remove a built-in plugin' };
  const state = plugins.get(pluginId);
  if (!state) return { success: false, message: 'Plugin not found' };
  // Delete plugin directory first — if this fails, runtime state stays intact
  try {
    rmSync(state.dir, { recursive: true, force: true });
  } catch (e) {
    return { success: false, message: e.message };
  }
  // Filesystem gone — now clean up runtime state
  for (const fn of state.shutdownFns) { try { fn(); } catch {} }
  removeHooks(pluginId);
  plugins.delete(pluginId);
  // Clear persisted install state
  const cfg = getConfigFn?.();
  if (cfg?.pluginInstalled?.[pluginId]) {
    delete cfg.pluginInstalled[pluginId];
    saveConfigFn?.(cfg);
  }
  console.log(`[plugin] removed ${pluginId}`);
  return { success: true };
}

module.exports = {
  PLUGINS_DIR, BUNDLED_IDS,
  init, shutdown,
  transformInput, notifyOutput, notifyStatus, notifyTranscript, notifyMenu, notifyConfig, clearStatus, isWorking, shouldAutoApproveMenu,
  handleMessage, updateSetting, getInfo, resolveFile, installPlugin, removePlugin,
  getPills, getPillLogs,
};
