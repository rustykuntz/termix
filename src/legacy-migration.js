const { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, copyFileSync, readdirSync } = require('fs');
const { homedir } = require('os');
const { join, resolve } = require('path');
const { isValidConfigPatch, isValidCommand } = require('./config-store');
const { ensurePrivateDataDir } = require('./private-data-dir');
const { getProvider } = require('./providers');

function readJson(path, fallback) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
}

function writeJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function providerId(value) {
  return ({ 'gemini-cli': 'gemini', agy: 'antigravity' })[value] || value;
}

function piTranscript(home, token) {
  const root = join(home, '.pi', 'agent', 'sessions');
  if (!token || !existsSync(root)) return '';
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const found = readdirSync(join(root, dir.name)).find((name) => name.endsWith(`_${token}.jsonl`));
    if (found) return join(root, dir.name, found);
  }
  return '';
}

// Run under the v2 server lock, before opening its stores. Never modify v1 files.
// A marker makes this one-time; ID merges also make interrupted imports retryable.
function migrateLegacy({ dataDir, home = homedir(), legacyDir = join(home, '.clideck') }) {
  const marker = join(dataDir, 'v1-migration.json');
  if (resolve(dataDir) === resolve(legacyDir) || existsSync(marker)) return null;
  if (!existsSync(join(legacyDir, 'sessions.json')) && !existsSync(join(legacyDir, 'config.json'))) return null;
  const legacy = readJson(join(legacyDir, 'config.json'), {});
  const oldSessions = readJson(join(legacyDir, 'sessions.json'), []);
  const config = readJson(join(dataDir, 'config.json'), {});
  const sessions = existsSync(join(dataDir, 'sessions.json'))
    ? readJson(join(dataDir, 'sessions.json')) : readJson(join(dataDir, 'sessions.backup.json'), []);
  if (!Array.isArray(oldSessions) || !Array.isArray(sessions) || !isValidConfigPatch(config)
    || sessions.some((entry) => !entry || !/^[a-zA-Z0-9_-]+$/.test(entry.id || '') || !entry.provider || !entry.cwd)
    || new Set(sessions.map((entry) => entry.id)).size !== sessions.length) {
    throw new Error('Cannot migrate legacy CliDeck data: invalid config or session registry. Original files were left untouched.');
  }
  const commands = (legacy.commands || []).map((command) => {
    const id = providerId(command.presetId);
    const result = {
      id: String(command.id), label: command.label, icon: 'terminal', command: command.command,
      enabled: command.enabled !== false, isAgent: command.isAgent === true,
      canResume: command.canResume === true, env: command.env || {},
      resumeCommand: command.resumeCommand || null, sessionIdPattern: command.sessionIdPattern || null,
      ...(id && getProvider(id) && { providerId: id }),
    };
    if (!isValidCommand(result)) throw new Error(`Cannot migrate legacy command "${command.label}". Original files were left untouched.`);
    return result;
  });
  const merged = { ...config };
  const mergeById = (old, current = []) => [...current, ...old.filter((item) => !current.some((value) => value.id === item.id))];
  const commandIds = new Map();
  const customCommands = commands.filter((command) => {
    const native = command.providerId && getProvider(command.providerId);
    return !native || command.command !== native.command || Object.keys(command.env).length > 0;
  }).map((command) => {
    let id = command.id;
    while ((config.commands || []).some((value) => value.id === id && JSON.stringify(value) !== JSON.stringify({ ...command, id }))) id = `v1-${id}`;
    commandIds.set(command.id, id);
    return { ...command, id };
  });
  merged.commands = mergeById(customCommands, config.commands);
  merged.projects = mergeById((legacy.projects || []).map((project) => ({
    ...project, path: project.path || '', color: project.color || '', collapsed: project.collapsed === true,
  })), config.projects);
  merged.prompts = mergeById(legacy.prompts || [], config.prompts);
  if (!config.defaultCwd) merged.defaultCwd = legacy.defaultPath || '';
  if (!Object.hasOwn(config, 'confirmClose') && typeof legacy.confirmClose === 'boolean') merged.confirmClose = legacy.confirmClose;
  if (!config.notify) {
    merged.notify = {
      ...(typeof legacy.notifyIdle === 'boolean' && { enabled: legacy.notifyIdle }),
      ...(typeof legacy.notifySoundEnabled === 'boolean' && { sound: legacy.notifySoundEnabled }),
      ...(typeof legacy.askDispatchSoundEnabled === 'boolean' && { dispatch: legacy.askDispatchSoundEnabled }),
      ...(['default-beep', 'soft-beep', 'bold-beep-idle', 'echo-beep-idle'].includes(legacy.notifySound) && { pick: legacy.notifySound }),
      ...([0, 10, 30].includes(legacy.notifyMinWork) && { minWorkSec: legacy.notifyMinWork }),
    };
  }
  merged.sessionThemes = { ...(config.sessionThemes || {}) };
  const ids = new Set(sessions.map((session) => session.id));
  const imported = [];
  for (const old of oldSessions) {
    if (ids.has(old.id)) continue;
    if (!/^[a-zA-Z0-9_-]+$/.test(old.id || '') || typeof old.cwd !== 'string' || !old.cwd) {
      throw new Error('Cannot migrate an invalid legacy session. Original files were left untouched.');
    }
    const command = commands.find((value) => value.id === String(old.commandId));
    const provider = providerId(old.presetId || command?.providerId);
    if (!command && !(provider && getProvider(provider))) throw new Error(`Cannot find the command for legacy session "${old.name}".`);
    const token = String(old.sessionToken || '');
    const transcriptPath = old.transcriptPath || (provider === 'pi' ? piTranscript(home, token) : '');
    const entry = {
      id: old.id, name: old.name || command?.label || provider, cwd: old.cwd,
      provider: provider && getProvider(provider) ? provider : 'custom-command',
      ...(commandIds.has(command?.id) && { commandId: commandIds.get(command.id), commandLabel: command.label }),
      projectId: old.projectId || null, muted: old.muted === true,
      cols: 120, rows: 40, createdAt: old.savedAt || new Date().toISOString(),
      lastActive: old.lastActivityAt || old.savedAt || new Date().toISOString(),
      lastFinal: old.lastPreview || '', resumeHandle: token,
      ...(transcriptPath && { transcriptPath }),
    };
    sessions.push(entry);
    if (old.themeId && !merged.sessionThemes[old.id]) merged.sessionThemes[old.id] = old.themeId;
    imported.push(entry);
    ids.add(entry.id);
  }
  if (!isValidConfigPatch(merged)) throw new Error('Legacy settings could not be converted. Original files were left untouched.');
  ensurePrivateDataDir(dataDir);
  const backup = join(dataDir, 'before-v1-migration');
  mkdirSync(backup, { recursive: true, mode: 0o700 });
  for (const name of ['config.json', 'sessions.json', 'sessions.backup.json']) {
    const source = join(dataDir, name);
    if (existsSync(source) && !existsSync(join(backup, name))) copyFileSync(source, join(backup, name));
  }
  for (const name of ['config.json', 'sessions.json']) {
    const source = join(legacyDir, name);
    const destination = join(backup, `legacy-${name}`);
    if (existsSync(source) && !existsSync(destination)) copyFileSync(source, destination);
  }
  writeJson(join(dataDir, 'config.json'), merged);
  for (const entry of imported) {
    const source = join(legacyDir, 'transcripts', `${entry.id}.jsonl`);
    const destination = join(dataDir, 'transcripts', `${entry.id}.jsonl`);
    if (existsSync(source) && !existsSync(destination)) {
      mkdirSync(join(dataDir, 'transcripts'), { recursive: true, mode: 0o700 });
      copyFileSync(source, destination);
    }
  }
  writeJson(join(dataDir, 'sessions.json'), sessions);
  writeJson(join(dataDir, 'sessions.backup.json'), sessions);
  const result = { source: legacyDir, sessions: imported.length, importedAt: new Date().toISOString() };
  writeJson(marker, result);
  return result;
}

module.exports = { migrateLegacy };
