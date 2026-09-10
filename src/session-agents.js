const { sameSessionScope, sessionAddress } = require('./project-scope');
const { getProvider } = require('./providers');

function resolveLiveCaller(entries, sessions, callerSessionId) {
  const id = String(callerSessionId || '').trim();
  if (!id) return null;
  const entry = entries.find((value) => value.id === id);
  const session = entry && sessions.get(id);
  return entry && session && !session.closed ? { entry, session } : null;
}

function isSessionWorking(session, coordinator) {
  return coordinator.isActive(session.id) || session.status !== 'idle'
    || session.turnOpen || session.closeRequested || Boolean(session.menu?.length);
}

function listSessionAgents(entries, sessions, coordinator, caller, projects = [], { all = false } = {}) {
  return entries.flatMap((entry) => {
    if (!all && !sameSessionScope(entry, caller.entry)) return [];
    const session = sessions.get(entry.id);
    const live = Boolean(session && !session.closed);
    const working = live && Boolean(isSessionWorking(session, coordinator));
    const lastActive = typeof entry.lastActive === 'string' && Number.isFinite(Date.parse(entry.lastActive))
      ? new Date(entry.lastActive).toISOString() : null;
    return [{
      id: entry.id,
      name: entry.name || '',
      provider: entry.provider,
      cwd: entry.cwd,
      cwdGroup: entry.cwd,
      projectId: entry.projectId ?? null,
      projectName: projects.find((project) => project.id === entry.projectId)?.name || entry.projectId || 'No project',
      live,
      working,
      status: !live ? 'dormant' : working ? 'working' : 'idle',
      supportsAsk: getProvider(entry.provider)?.supportsAsk === true,
      // This is recorded activity, not an inferred time of shutdown. Older entries may have no valid stamp.
      lastActive,
      lastPreview: String((live && session.latestUpdate) || entry.lastFinal || '').trim().slice(0, 200),
      address: sessionAddress(entry, projects),
      caller: entry.id === caller.entry.id,
    }];
  });
}

module.exports = { isSessionWorking, listSessionAgents, resolveLiveCaller };
