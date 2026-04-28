const transcript = require('./transcript');

const MAX_BODY = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > MAX_BODY) {
        req.destroy();
        reject(new Error('Request too large'));
      }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function jsonError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function isLoopback(req) {
  const addr = req.socket?.remoteAddress || '';
  return addr === '::1' || addr === '127.0.0.1' || addr.startsWith('127.') || addr.startsWith('::ffff:127.');
}

function normalizeTimeout(ms) {
  const n = Number(ms || DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.round(n), MAX_TIMEOUT_MS);
}

function sameProject(a, b) {
  return (a.projectId || null) === (b.projectId || null);
}

function findTarget(sessions, callerId, caller, target) {
  const trimmed = String(target || '').trim();
  if (!trimmed) throw jsonError('Target session is required');

  const byId = sessions.get(trimmed);
  if (byId) {
    if (trimmed === callerId) throw jsonError('Target session cannot be the caller session');
    if (!sameProject(caller, byId)) throw jsonError('Target session is not in the caller project', 404);
    return [trimmed, byId];
  }

  const sameProjectSessions = [...sessions]
    .filter(([id, s]) => id !== callerId && sameProject(caller, s));
  const exact = sameProjectSessions.filter(([, s]) => s.name === trimmed);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw jsonError(`Multiple sessions named "${trimmed}" in this project. Use the session id.`);

  const lower = trimmed.toLowerCase();
  const insensitive = sameProjectSessions.filter(([, s]) => String(s.name || '').toLowerCase() === lower);
  if (insensitive.length === 1) return insensitive[0];
  if (insensitive.length > 1) throw jsonError(`Multiple sessions named "${trimmed}" in this project. Use the session id.`);
  throw jsonError(`No session named "${trimmed}" in this project`, 404);
}

function latestAgentTextSince(sessionId, sinceTs) {
  const entries = transcript.getEntriesSince(sessionId, sinceTs)
    .filter(e => e.role === 'agent' && String(e.text || '').trim());
  return entries.length ? entries[entries.length - 1].text : '';
}

function waitForAnswer({ sessionsApi, targetId, sinceTs, timeoutMs }) {
  const sessions = sessionsApi.getSessions();
  const target = sessions.get(targetId);
  let sawWorking = !!target?.working;
  let settled = false;
  let quietTimer = null;
  let removeListener = null;
  let timeout = null;

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      if (quietTimer) clearTimeout(quietTimer);
      if (removeListener) removeListener();
    };
    const finish = () => {
      if (settled) return;
      const response = latestAgentTextSince(targetId, sinceTs);
      if (!response) return;
      settled = true;
      cleanup();
      resolve(response);
    };
    timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(jsonError('Timed out waiting for target session response', 504));
    }, timeoutMs);

    removeListener = sessionsApi.addBroadcastListener((msg) => {
      if (msg.id !== targetId) return;
      if (msg.type === 'session.status') {
        if (msg.working) {
          sawWorking = true;
          return;
        }
        if (sawWorking) {
          sessionsApi.broadcast({ type: 'terminal.capture', id: targetId });
          setTimeout(finish, 700);
        }
      } else if (msg.type === 'output') {
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = setTimeout(() => {
          if (!sessions.get(targetId)?.working) {
            sessionsApi.broadcast({ type: 'terminal.capture', id: targetId });
            setTimeout(finish, 700);
          }
        }, 2500);
      }
    });
  });
}

async function askSession(payload, sessionsApi) {
  const sessions = sessionsApi.getSessions();
  const callerId = String(payload.callerSessionId || '').trim();
  const caller = sessions.get(callerId);
  if (!caller) throw jsonError('Caller session is not active', 404);

  const [targetId, target] = findTarget(sessions, callerId, caller, payload.target);
  if (target.working) throw jsonError(`Target session "${target.name}" is already working`, 409);

  const message = String(payload.message || '').trim();
  if (!message) throw jsonError('Message is required');

  const timeoutMs = normalizeTimeout(payload.timeoutMs);
  const sinceTs = Date.now();
  const injected = `[CliDeck ask from ${caller.name || callerId.slice(0, 8)}]\n\n${message}`;

  console.log(`[ask] ${caller.name || callerId.slice(0, 8)} -> ${target.name || targetId.slice(0, 8)} (${timeoutMs}ms timeout)`);
  sessionsApi.input({ id: targetId, data: injected });
  setTimeout(() => sessionsApi.input({ id: targetId, data: '\r' }), 150);

  const response = await waitForAnswer({ sessionsApi, targetId, sinceTs, timeoutMs });
  console.log(`[ask] completed ${target.name || targetId.slice(0, 8)} -> ${caller.name || callerId.slice(0, 8)}`);
  return { targetSessionId: targetId, targetName: target.name, response };
}

async function handleHttp(req, res, sessionsApi) {
  try {
    if (!isLoopback(req)) throw jsonError('CliDeck ask only accepts local requests', 403);
    const payload = await readJson(req);
    const result = await askSession(payload, sessionsApi);
    sendJson(res, 200, result);
  } catch (e) {
    sendJson(res, e.status || 500, { error: e.message || 'CliDeck ask failed' });
  }
}

module.exports = { handleHttp, askSession };
