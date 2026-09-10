const { MAX_CONTROL_TEXT } = require('./control');
const { getProvider } = require('./providers');
const { cwdGroupName, sameSessionScope, sessionAddress } = require('./project-scope');

const DEFAULT_ASK_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_ASK_TIMEOUT_MS = 60 * 60 * 1000;
const MIN_SESSION_ID_PREFIX = 6;

function parseAskRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const target = typeof value.target === 'string' ? value.target.trim() : '';
  const text = typeof value.text === 'string' ? value.text.trim() : '';
  const callerSessionId = value.callerSessionId === undefined
    ? '' : typeof value.callerSessionId === 'string' ? value.callerSessionId.trim() : null;
  const steer = value.steer === undefined ? false : value.steer;
  const timeoutMs = value.timeoutMs === undefined ? DEFAULT_ASK_TIMEOUT_MS : value.timeoutMs;
  if (!target || target.length > 200 || target.includes('\0')) return null;
  if (!text || text.length > MAX_CONTROL_TEXT || text.includes('\0')) return null;
  if (callerSessionId === null || callerSessionId.length > 200 || callerSessionId.includes('\0')) {
    return null;
  }
  if (typeof steer !== 'boolean') return null;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_ASK_TIMEOUT_MS) return null;
  return {
    target,
    text,
    timeoutMs,
    ...(callerSessionId && { callerSessionId }),
    ...(steer && { steer: true }),
  };
}

function matchingSessions(entries, target) {
  const byId = entries.find((entry) => entry.id === target);
  if (byId) return { entry: byId };
  const wanted = target.toLowerCase();
  const byName = entries.filter((entry) => String(entry.name || '').toLowerCase() === wanted);
  if (byName.length === 1) return { entry: byName[0] };
  if (byName.length > 1) {
    return { error: 'ambiguous_target', candidateIds: byName.map((entry) => entry.id) };
  }
  if (target.length >= MIN_SESSION_ID_PREFIX) {
    const byPrefix = entries.filter((entry) => entry.id.startsWith(target));
    if (byPrefix.length === 1) return { entry: byPrefix[0] };
    if (byPrefix.length > 1) {
      return { error: 'ambiguous_target', candidateIds: byPrefix.map((entry) => entry.id) };
    }
  }
  return { error: 'unknown_target' };
}

function resolveProject(projects, target) {
  const byId = projects.filter((project) => project.id === target);
  if (byId.length === 1) return { project: byId[0] };
  const wanted = target.toLowerCase();
  const byName = projects.filter((project) => String(project.name || '').toLowerCase() === wanted);
  if (byName.length === 1) return { project: byName[0] };
  if (byName.length > 1) {
    return {
      error: 'ambiguous_project',
      candidateProjectIds: byName.map((project) => project.id),
      message: `Multiple projects named "${target}". Use the project id.`,
    };
  }
  return { error: 'unknown_project', message: `No project named "${target}" was found.` };
}

function resolveAskTarget(entries, target, options = {}) {
  const value = String(target || '').trim();
  const projects = options.projects || [];
  if (value.startsWith('@')) {
    const slash = value.indexOf('/');
    if (slash <= 1 || slash === value.length - 1) {
      return {
        error: 'invalid_target',
        message: 'Cross-project targets must use @project/session.',
      };
    }
    const projectTarget = value.slice(1, slash).trim();
    const sessionTarget = value.slice(slash + 1).trim();
    if (!projectTarget || !sessionTarget) {
      return {
        error: 'invalid_target',
        message: 'Cross-project targets must use @project/session.',
      };
    }
    const resolvedProject = resolveProject(projects, projectTarget);
    if (!resolvedProject.error) {
      return matchingSessions(
        entries.filter((entry) => entry.projectId === resolvedProject.project.id),
        sessionTarget,
      );
    }
    if (resolvedProject.error !== 'unknown_project') return resolvedProject;
    const wanted = projectTarget.toLowerCase();
    const cwdGroup = entries.filter((entry) => !entry.projectId
      && cwdGroupName(entry.cwd).toLowerCase() === wanted);
    return cwdGroup.length ? matchingSessions(cwdGroup, sessionTarget) : resolvedProject;
  }

  const byId = entries.find((entry) => entry.id === value);
  if (byId) return { entry: byId };
  if (options.caller) {
    const local = matchingSessions(
      entries.filter((entry) => sameSessionScope(entry, options.caller)),
      value,
    );
    if (local.error !== 'unknown_target') return local;
  }
  return matchingSessions(entries, value);
}

function listAskTargets(entries, sessions, projects = []) {
  return entries.map((entry) => ({
    id: entry.id,
    name: entry.name,
    provider: entry.provider,
    projectId: entry.projectId ?? null,
    address: sessionAddress(entry, projects),
    supportsAsk: getProvider(entry.provider)?.supportsAsk === true,
    live: Boolean(sessions.get(entry.id) && !sessions.get(entry.id).closed),
  }));
}

function availableAskSession(entry, sessions, coordinator) {
  if (getProvider(entry.provider)?.supportsAsk !== true) return { error: 'unsupported_target' };
  const session = sessions.get(entry.id);
  if (!session || session.closed) return { error: 'dormant' };
  if (coordinator.isActive(entry.id) || session.status !== 'idle'
    || session.turnOpen || session.closeRequested || session.menu.length) {
    const steerable = !session.closeRequested && !session.menu.length
      && (coordinator.isActive(entry.id) || session.status === 'working' || session.turnOpen);
    return { error: 'busy', ...(steerable && { steerable: true }) };
  }
  return { session };
}

function availableSteerSession(entry, sessions, coordinator) {
  if (getProvider(entry.provider)?.supportsAsk !== true) return { error: 'unsupported_target' };
  const session = sessions.get(entry.id);
  if (!session || session.closed) return { error: 'dormant' };
  if (session.closeRequested || session.menu.length) return { error: 'busy' };
  if (session.status !== 'working' && !session.turnOpen && !coordinator.isActive(entry.id)) {
    return { error: 'not_working' };
  }
  return { session };
}

class AskCoordinator {
  constructor(onDispatch = () => {}) {
    this.active = new Map();
    this.onDispatch = onDispatch;
  }

  isActive(sessionId) {
    return this.active.has(sessionId);
  }

  dispatch(session, source = {}) {
    try {
      this.onDispatch({
        type: 'session.dispatch',
        fromId: String(source.fromId || ''),
        fromName: String(source.fromName || ''),
        toId: session.id,
        toName: String(session.name || ''),
      });
    } catch {}
  }

  steer(session, text, source = {}) {
    if (!session.steerPrompt(text)) return { ok: false, error: 'unavailable' };
    this.dispatch(session, source);
    return { ok: true, steered: true };
  }

  ask(session, text, timeoutMs, source = {}) {
    if (this.isActive(session.id)) return Promise.resolve({ ok: false, error: 'busy' });
    return new Promise((resolve) => {
      let responded = false;
      const finishResponse = (result) => {
        if (responded) return;
        responded = true;
        resolve(result);
      };
      const release = () => {
        clearTimeout(timer);
        session.off('event', onEvent);
        this.active.delete(session.id);
      };
      const onEvent = (event) => {
        if (event.type === 'agent.final') {
          release();
          finishResponse({ ok: true, answer: event.text });
        } else if (event.type === 'session.closed') {
          release();
          finishResponse({ ok: false, error: 'target_closed' });
        }
      };
      const timer = setTimeout(() => {
        finishResponse({ ok: false, error: 'timeout' });
      }, timeoutMs);

      this.active.set(session.id, true);
      session.on('event', onEvent);
      if (!session.sendPrompt(text)) {
        release();
        finishResponse({ ok: false, error: 'unavailable' });
      } else {
        this.dispatch(session, source);
      }
    });
  }
}

module.exports = {
  AskCoordinator,
  DEFAULT_ASK_TIMEOUT_MS,
  MAX_ASK_TIMEOUT_MS,
  availableAskSession,
  availableSteerSession,
  listAskTargets,
  parseAskRequest,
  resolveProject,
  resolveAskTarget,
};
