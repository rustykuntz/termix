// Minimal OTLP HTTP/JSON log receiver.
// CLI agents export telemetry events here; we capture agent session IDs
// (for resume) and detect whether telemetry is configured (setup prompts).

const ioActivity = require('./activity');
const activity = new Map(); // sessionId → has received events
const lastEvent = new Map(); // sessionId → last OTEL event name (+ kind)
const pendingSetup = new Map(); // sessionId → timer (waiting for first event)
const codexMenuPoll = new Map(); // sessionId → interval (polling for menu after response.completed)
const codexPendingStop = new Map(); // sessionId → ts (notify hook arrived; wait for next response.completed)
const codexOutputDone = new Map(); // sessionId → ts (fallback if notify never fires)
const codexPendingIdle = new Map(); // sessionId → timer (tiny settle before committing idle)
const escPendingIdle = new Map(); // sessionId → timer (Esc interrupt → short grace before forcing idle)
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
    for (const sl of rl.scopeLogs || []) {
      for (const lr of sl.logRecords || []) {
        const attrs = parseAttrs(lr.attributes);
        const eventName = attrs['event.name'];

        // Debug telemetry logs — uncomment as needed, do not delete
        // if (serviceName === 'claude-code' && eventName) console.log(`[telemetry:claude] ${eventName}`);
        // if (serviceName === 'codex_cli_rs' && eventName) {
        //   const details = Object.entries(attrs)
        //     .filter(([k]) => k !== 'event.name')
        //     .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        //     .join(' ');
        //   console.log(`[telemetry:codex] ${eventName} session=${resolvedId.slice(0,8)}${details ? ' ' + details : ''}`);
        // }
        // if (serviceName === 'gemini-cli' && eventName) console.log(`[telemetry:gemini] ${eventName}`);

        // Track last event per session (used by menu detection validation)
        if (eventName) lastEvent.set(resolvedId, eventName + (attrs['event.kind'] ? ':' + attrs['event.kind'] : ''));

        // Codex can emit a brief completion between tool phases. Keep idle
        // pending for a tiny settle window and cancel it on any fresh Codex
        // activity before the idle is committed to UI/notifications.
        if (serviceName === 'codex_cli_rs' && eventName) {
          const isTrustedCompletion = eventName === 'codex.sse_event' && attrs['event.kind'] === 'response.completed';
          if (!isTrustedCompletion) cancelCodexPendingIdle(resolvedId);
        }

        // Status: Codex user_prompt → working. Claude and Gemini use hooks.
        if (eventName === 'codex.user_prompt') {
          codexPendingStop.delete(resolvedId);
          codexOutputDone.delete(resolvedId);
          broadcastFn?.({ type: 'session.status', id: resolvedId, working: true, source: 'telemetry' });
        }

        // Fallback: when notify does not fire, require an output item to finish
        // before treating the next response.completed as a real end-of-turn.
        if (eventName === 'codex.websocket_event' && attrs['event.kind'] === 'response.output_item.done') {
          codexOutputDone.set(resolvedId, Date.now());
        }

        // Codex: after notify hook arms a pending stop, the next response.completed commits idle.
        // Also poll briefly for a visible choice menu.
        if (eventName === 'codex.sse_event' && attrs['event.kind'] === 'response.completed') {
          const pendingStopAt = codexPendingStop.get(resolvedId);
          if (pendingStopAt && Date.now() - pendingStopAt <= 5000) {
            // console.log(`[codex] complete matched pending-stop session=${resolvedId.slice(0,8)} age=${Date.now() - pendingStopAt}ms`);
            codexPendingStop.delete(resolvedId);
            codexOutputDone.delete(resolvedId);
            scheduleCodexIdle(resolvedId, 'telemetry-stop');
          } else {
            const outputDoneAt = codexOutputDone.get(resolvedId);
            if (outputDoneAt && Date.now() - outputDoneAt <= 5000) {
              // console.log(`[codex] complete matched output-item.done fallback session=${resolvedId.slice(0,8)} age=${Date.now() - outputDoneAt}ms`);
              codexOutputDone.delete(resolvedId);
              scheduleCodexIdle(resolvedId, 'telemetry-fallback');
            } else {
              // console.log(`[codex] response.completed with no notify-stop and no output-item.done fallback session=${resolvedId.slice(0,8)} outputDone=${outputDoneAt ? Date.now() - outputDoneAt + 'ms' : 'none'}`);
            }
          }
          startCodexMenuPoll(resolvedId);
        }
        // Codex: tool_decision → user approved, cancel menu poll, back to working
        if (eventName === 'codex.tool_decision') {
          codexPendingStop.delete(resolvedId);
          codexOutputDone.delete(resolvedId);
          cancelCodexMenuPoll(resolvedId);
          broadcastFn?.({ type: 'session.status', id: resolvedId, working: true, source: 'telemetry' });
        }
        // Codex: user_prompt or next sse_event cancels menu poll
        if ((eventName === 'codex.user_prompt' || (eventName === 'codex.sse_event' && attrs['event.kind'] !== 'response.completed'))) {
          codexOutputDone.delete(resolvedId);
          cancelCodexMenuPoll(resolvedId);
        }

        // Codex: use conversation.id (maps to thread-id in notify hook)
        const agentSessionId = serviceName === 'codex_cli_rs'
          ? attrs['conversation.id']
          : (attrs['session.id'] || attrs['conversation.id']);
        if (agentSessionId && sess) {
          // Prefer interactive session ID (Gemini sends non-interactive init events first)
          const dominated = sess.sessionToken && attrs['interactive'] === true;
          if (!sess.sessionToken || dominated) {
            sess.sessionToken = agentSessionId;
            console.log(`Telemetry: captured session ID ${agentSessionId} for ${agent} (${resolvedId.slice(0, 8)})`);
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

// Codex: after response.completed, poll terminal capture every 500ms for up to 3s
function startCodexMenuPoll(id) {
  cancelCodexMenuPoll(id);
  const started = Date.now();
  const poll = setInterval(() => {
    if (Date.now() - started > 3000) { cancelCodexMenuPoll(id); return; }
    // console.log(`[terminal.capture] session=${id.slice(0,8)} source=codex-menu-poll`);
    broadcastFn?.({ type: 'terminal.capture', id });
  }, 500);
  codexMenuPoll.set(id, poll);
}

function cancelCodexMenuPoll(id) {
  const timer = codexMenuPoll.get(id);
  if (timer) { clearInterval(timer); codexMenuPoll.delete(id); }
}

function armCodexStop(id) {
  codexPendingStop.set(id, Date.now());
  codexOutputDone.delete(id);
  // console.log(`[codex] pending-stop armed session=${id.slice(0,8)}`);
}

function scheduleCodexIdle(id, source) {
  cancelCodexPendingIdle(id);
  const timer = setTimeout(() => {
    codexPendingIdle.delete(id);
    broadcastFn?.({ type: 'session.status', id, working: false, source });
  }, 300);
  codexPendingIdle.set(id, timer);
}

function cancelCodexPendingIdle(id) {
  const timer = codexPendingIdle.get(id);
  if (timer) { clearTimeout(timer); codexPendingIdle.delete(id); }
}

function startEscIdle(id) {
  cancelEscIdle(id);
  const timer = setTimeout(() => {
    escPendingIdle.delete(id);
    broadcastFn?.({ type: 'session.status', id, working: false, source: 'esc' });
  }, 350);
  escPendingIdle.set(id, timer);
}

function cancelEscIdle(id) {
  const timer = escPendingIdle.get(id);
  if (timer) { clearTimeout(timer); escPendingIdle.delete(id); }
}

function clear(id) {
  activity.delete(id);
  lastEvent.delete(id);
  cancelCodexMenuPoll(id);
  cancelCodexPendingIdle(id);
  codexPendingStop.delete(id);
  codexOutputDone.delete(id);
  cancelEscIdle(id);
  const pending = pendingSetup.get(id);
  if (pending) { clearTimeout(pending.timer); pendingSetup.delete(id); }
}

function getLastEvent(id) { return lastEvent.get(id) || ''; }

// Returns true if we've received telemetry events for this session
function hasEvents(id) {
  return activity.has(id);
}

module.exports = { init, handleLogs, clear, hasEvents, getLastEvent, cancelCodexMenuPoll, watchSession, startEscIdle, armCodexStop };
