// Minimal OTLP HTTP/JSON log receiver.
// CLI agents export telemetry events here; we capture agent session IDs
// (for resume) and detect whether telemetry is configured (setup prompts).

const activity = new Map(); // termixId → has received events
const pendingSetup = new Map(); // termixId → timer (waiting for first event)
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
    const termixId = resAttrs['termix.session_id'];

    // DEBUG: log all incoming telemetry with resource attributes
    const serviceName = resAttrs['service.name'] || 'unknown';
    let resolvedId = termixId;

    // Fallback: if agent doesn't include termix.session_id (e.g. Gemini ignores
    // OTEL_RESOURCE_ATTRIBUTES), match by finding a pending session for this agent
    if (!resolvedId) {
      for (const [id, pending] of pendingSetup) {
        const sess = sessionsFn?.()?.get(id);
        if (!sess) continue;
        // Match: no activity yet, and agent type matches
        if (!activity.has(id) && pending.bin && serviceName.includes(pending.bin)) { resolvedId = id; break; }
      }
      if (resolvedId) {
        console.log(`Telemetry: matched ${serviceName} to session ${resolvedId.slice(0, 8)} (no termix.session_id — fallback match)`);
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

    // DEBUG: dump attributes if we haven't captured a session ID yet
    if (!captured && sess && !sess.sessionToken && resolvedId) {
      const allAttrs = [];
      for (const sl of rl.scopeLogs || []) {
        for (const lr of sl.logRecords || []) allAttrs.push(Object.keys(parseAttrs(lr.attributes)));
      }
      console.log(`Telemetry [${agent}]: no session.id found. Record attrs: ${JSON.stringify([...new Set(allAttrs.flat())])}`);
    }
  }

  res.writeHead(200).end('{}');
}

// Watch a newly spawned session — if no telemetry arrives, notify frontend
function watchSession(termixId, bin) {
  if (pendingSetup.has(termixId)) return;
  const timer = setTimeout(() => {
    pendingSetup.delete(termixId);
    // Don't fire if telemetry arrived between timer start and now
    if (!activity.has(termixId)) {
      broadcastFn?.({ type: 'session.needsSetup', id: termixId });
    }
  }, 10000);
  pendingSetup.set(termixId, { timer, bin });
}

function cancelPendingSetup(termixId) {
  const pending = pendingSetup.get(termixId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingSetup.delete(termixId);
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
