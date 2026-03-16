// Minimal OTLP HTTP/JSON log receiver.
// CLI agents export telemetry events here; we capture agent session IDs
// (for resume) and detect whether telemetry is configured (setup prompts).

const activity = new Map(); // sessionId → has received events
const pendingSetup = new Map(); // sessionId → timer (waiting for first event)
let broadcastFn = null;
let sessionsFn = null;

function init(broadcast, getSessions) {
  broadcastFn = broadcast;
  sessionsFn = getSessions;
}

// Flatten OTLP attribute arrays into plain objects
function parseAttrs(attrs) {
  const out = {};
  if (!attrs) return out;
  for (const a of attrs) {
    const v = a.value;
    out[a.key] = v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue ?? '';
  }
  return out;
}

// Express-compatible handler for POST /v1/logs
function handleLogs(req, res) {
  const body = req.body;
  if (!body?.resourceLogs) return res.writeHead(200).end('{}');

  for (const rl of body.resourceLogs) {
    const resAttrs = parseAttrs(rl.resource?.attributes);
    const sessionId = resAttrs['clideck.session_id'];

    // service.name values: claude-code, codex_cli_rs, gemini-cli
    const serviceName = resAttrs['service.name'] || 'unknown';
    let resolvedId = sessionId;

    // Fallback: if agent doesn't include clideck.session_id (e.g. Gemini ignores
    // OTEL_RESOURCE_ATTRIBUTES), match by finding a pending session for this agent
    if (!resolvedId) {
      for (const [id, pending] of pendingSetup) {
        const sess = sessionsFn?.()?.get(id);
        if (!sess) continue;
        // Match: no activity yet, and agent type matches
        if (!activity.has(id) && pending.bin && serviceName.includes(pending.bin)) { resolvedId = id; break; }
      }
      if (resolvedId) {
        console.log(`Telemetry: matched ${serviceName} to session ${resolvedId.slice(0, 8)} (no clideck.session_id — fallback match)`);
      } else {
        continue;
      }
    }

    // Any log record for this session means telemetry is working
    const firstEvent = !activity.has(resolvedId);
    cancelPendingSetup(resolvedId);
    activity.set(resolvedId, true);

    const sess = sessionsFn?.()?.get(resolvedId);
    const agent = resAttrs['service.name'] || sess?.name || resolvedId.slice(0, 8);

    if (firstEvent) console.log(`Telemetry: first event from ${agent} (${resolvedId.slice(0, 8)})`);

    // Process each log record — capture session ID for resume
    let captured = false;
    for (const sl of rl.scopeLogs || []) {
      for (const lr of sl.logRecords || []) {
        const attrs = parseAttrs(lr.attributes);

        const eventName = attrs['event.name'];
        // if (serviceName === 'codex_cli_rs' && eventName) console.log(`[telemetry:codex] ${eventName}`);
        // if (serviceName === 'gemini-cli' && eventName) console.log(`[telemetry:gemini] ${eventName}`);

        // Telemetry-based status
        const startEvents = new Set(['user_prompt', 'gemini_cli.user_prompt', 'codex.user_prompt']);
        if (startEvents.has(eventName)) {
          broadcastFn?.({ type: 'session.status', id: resolvedId, working: true, source: 'telemetry' });
        }
        // Claude: telemetry-only status. user_prompt/any event → working, api_request → idle.
        if (serviceName === 'claude-code' && eventName) {
          if (eventName === 'api_request') {
            broadcastFn?.({ type: 'session.status', id: resolvedId, working: false, source: 'telemetry' });
          } else if (eventName !== 'user_prompt') {
            broadcastFn?.({ type: 'session.status', id: resolvedId, working: true, source: 'telemetry' });
          }
        }
        // Codex: telemetry-only status. codex.user_prompt/any event → working, codex.sse_event → idle.
        if (serviceName === 'codex_cli_rs' && eventName) {
          if (eventName === 'codex.sse_event') {
            broadcastFn?.({ type: 'session.status', id: resolvedId, working: false, source: 'telemetry' });
          } else if (eventName !== 'codex.user_prompt') {
            broadcastFn?.({ type: 'session.status', id: resolvedId, working: true, source: 'telemetry' });
          }
        }
        // Gemini: telemetry-only status. Whitelisted events → working, api_response (role=main) → idle.
        if (serviceName === 'gemini-cli' && eventName) {
          if (eventName === 'gemini_cli.api_response' && attrs['role'] === 'main') {
            broadcastFn?.({ type: 'session.status', id: resolvedId, working: false, source: 'telemetry' });
          } else if (eventName === 'gemini_cli.api_request' || eventName === 'gemini_cli.model_routing'
            || (eventName === 'gemini_cli.api_response' && attrs['role'] !== 'main')) {
            broadcastFn?.({ type: 'session.status', id: resolvedId, working: true, source: 'telemetry' });
          }
        }

        const agentSessionId = attrs['session.id'] || attrs['conversation.id'];
        if (agentSessionId && sess) {
          // Prefer interactive session ID (Gemini sends non-interactive init events first)
          const dominated = sess.sessionToken && attrs['interactive'] === true;
          if (!sess.sessionToken || dominated) {
            sess.sessionToken = agentSessionId;
            console.log(`Telemetry: captured session ID ${agentSessionId} for ${agent} (${resolvedId.slice(0, 8)})`);
            captured = true;
          }
        }
      }
    }

  }

  res.writeHead(200).end('{}');
}

// Watch a newly spawned session — if no telemetry arrives, notify frontend
function watchSession(sessionId, bin) {
  if (pendingSetup.has(sessionId)) return;
  const timer = setTimeout(() => {
    pendingSetup.delete(sessionId);
    // Don't fire if telemetry arrived between timer start and now
    if (!activity.has(sessionId)) {
      broadcastFn?.({ type: 'session.needsSetup', id: sessionId });
    }
  }, 10000);
  pendingSetup.set(sessionId, { timer, bin });
}

function cancelPendingSetup(sessionId) {
  const pending = pendingSetup.get(sessionId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingSetup.delete(sessionId);
  }
}

function clear(id) {
  activity.delete(id);
  const pending = pendingSetup.get(id);
  if (pending) { clearTimeout(pending.timer); pendingSetup.delete(id); }
}

// Returns true if we've received telemetry events for this session
function hasEvents(id) {
  return activity.has(id);
}

module.exports = { init, handleLogs, clear, hasEvents, watchSession };
