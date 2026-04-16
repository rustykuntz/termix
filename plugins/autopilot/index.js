'use strict';

const { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync, unlinkSync } = require('fs');
const { join } = require('path');
const crypto = require('crypto');

const DATA_DIR = join(require('os').homedir(), '.clideck', 'autopilot');
const GOALS_DIR = join(DATA_DIR, 'goals');
const GOAL_PREFIX = 'AUTOPILOT GOAL:';
const FIRST_USER_MESSAGES = 3;
const FIRST_TURN_SCAN = 50;
const GOAL_SEARCH_TURNS = 2000;
const MAX_GOAL_MESSAGE_CHARS = 100000;

// --- State ---
const projects = new Map();   // projectId → Project
const tokenUsage = new Map(); // projectId → { input, output }
const menuPending = new Set(); // sessionIds with a menu awaiting auto-approve
const idleCaptureTimers = new Map(); // sessionId → timeout id for deferred idle capture
let api = null;
let piAi = null;

function enabled() { return api.getSetting('enabled') !== false; }
function safeId(id) { return String(id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64); }
function pillId(pid) { return `autopilot-${pid}`; }

function outputId(text) {
  const normalized = (text || '').trim().replace(/\s+/g, ' ');
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 12);
}

// --- pi-ai (lazy, ESM) ---

async function ai() {
  if (piAi) return piAi;
  piAi = await import(api.resolve('@mariozechner/pi-ai'));
  return piAi;
}

// --- KB (routing history) ---

function kbPath(pid) { return join(DATA_DIR, `${safeId(pid)}.jsonl`); }
function goalPath(pid) { return join(GOALS_DIR, `${safeId(pid)}.json`); }

function appendKB(pid, entry) {
  mkdirSync(DATA_DIR, { recursive: true });
  appendFileSync(kbPath(pid), JSON.stringify({ ts: Date.now(), ...entry }) + '\n');
}

function readKB(pid, n) {
  const p = kbPath(pid);
  if (!existsSync(p)) return [];
  try {
    const lines = readFileSync(p, 'utf8').trim().split('\n').filter(Boolean);
    const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    return n ? entries.slice(-n) : entries;
  } catch { return []; }
}

function loadGoal(pid) {
  const p = goalPath(pid);
  if (!existsSync(p)) return null;
  try {
    const goal = JSON.parse(readFileSync(p, 'utf8'));
    return goal?.text ? goal : null;
  } catch { return null; }
}

function saveGoal(pid, goal) {
  if (!goal?.text) return;
  mkdirSync(GOALS_DIR, { recursive: true });
  writeFileSync(goalPath(pid), JSON.stringify(goal, null, 2));
}

// --- Token usage ---

function usagePath() { return join(DATA_DIR, 'usage.json'); }

function loadUsage() {
  try {
    for (const [k, v] of Object.entries(JSON.parse(readFileSync(usagePath(), 'utf8')))) {
      tokenUsage.set(k, v);
    }
  } catch {}
}

function saveUsage() {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(usagePath(), JSON.stringify(Object.fromEntries(tokenUsage)));
}

function addTokens(pid, usage) {
  if (!usage) return;
  const u = tokenUsage.get(pid) || { input: 0, output: 0 };
  u.input += usage.input || 0;
  u.output += usage.output || 0;
  tokenUsage.set(pid, u);
  saveUsage();
  api.sendToFrontend('tokens', { projectId: pid, ...u });
}

function latestAgentOutput(id) {
  const turns = api.getTranscript(id, 20);
  const last = [...turns].reverse().find(t => t.role === 'agent');
  return last?.text?.trim().slice(0, 8000) || null;
}

function usageTotals(usage) {
  const input = usage?.input || 0;
  const output = usage?.output || 0;
  return { input, output, total: input + output };
}

function formatTokenLog(label, usage, source) {
  const t = usageTotals(usage);
  return `${label} tokens (${source}): in ${t.input}, out ${t.output}, total ${t.total}`;
}

function firstUserMessages(id, n) {
  return api.getTranscript(id, FIRST_TURN_SCAN, 'start')
    .filter(t => t.role === 'user')
    .slice(0, n)
    .map(t => String(t.text || '').trim())
    .filter(Boolean);
}

function extractExplicitGoal(text) {
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed.toUpperCase().startsWith(GOAL_PREFIX)) continue;
    const first = trimmed.slice(GOAL_PREFIX.length).trim();
    const rest = lines.slice(i + 1).join('\n').trim();
    return [first, rest].filter(Boolean).join('\n').replace(/\s+/g, ' ').trim();
  }
  return '';
}

function isUnclearGoal(text) {
  const normalized = String(text || '').trim().replace(/^["'\s]+|["'\s]+$/g, '').toLowerCase();
  return normalized === 'unclear_goal';
}

function findExplicitGoal(proj) {
  const found = [];
  for (const [sid, w] of proj.workers) {
    const turns = api.getTranscript(sid, GOAL_SEARCH_TURNS, 'start');
    for (const turn of turns) {
      if (turn.role !== 'user') continue;
      const goal = extractExplicitGoal(turn.text);
      if (!goal) continue;
      found.push({ goal, worker: w.label, sessionId: sid });
    }
  }
  const unique = [...new Set(found.map(x => x.goal))];
  if (!unique.length) return { goal: null };
  if (unique.length > 1) {
    return {
      error: `Found multiple explicit project goals. Keep one \`${GOAL_PREFIX}\` message in an existing worker session and restart Autopilot.`,
    };
  }
  return {
    goal: {
      text: unique[0],
      builtAt: new Date().toISOString(),
      source: 'explicit-message',
    },
  };
}

function goalSourceContext(proj) {
  const sections = [];
  for (const [sid, w] of proj.workers) {
    const messages = firstUserMessages(sid, FIRST_USER_MESSAGES);
    if (!messages.length) continue;
    const body = messages.map((text, idx) => {
      const clipped = text.length > MAX_GOAL_MESSAGE_CHARS ? text.slice(0, MAX_GOAL_MESSAGE_CHARS) : text;
      return `Message ${idx + 1}:\n${clipped}`;
    }).join('\n\n');
    sections.push(`${w.name}: ${(w.role || 'Session')} first user messages:\n${body}`);
  }
  return sections.join('\n\n');
}

function candidateSessions(pid) {
  return api.getSessions().filter(s => s.projectId === pid && s.presetId !== 'shell');
}

function hasUserMessage(id) {
  return firstUserMessages(id, 1).length > 0;
}

function sessionDisplayName(session) {
  return String(session?.name || '').trim() || `Session ${String(session?.id || '').slice(0, 6)}`;
}

function buildRouteLabel(session, taken) {
  const base = sessionDisplayName(session);
  if (!taken.has(base.toLowerCase())) return base;
  return `${base} [${String(session.id).slice(0, 6)}]`;
}

function unpromptedSessionsMessage(sessions) {
  const names = (sessions || []).map(sessionDisplayName).filter(Boolean);
  const suffix = names.length ? ` Missing a first prompt: ${names.join(', ')}.` : '';
  return `Autopilot only steers sessions after you have already told each one what to do. Give every session in this project an initial user prompt first, then start Autopilot again.${suffix}`;
}

function parseJsonObject(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  const cleaned = trimmed.replace(/^```json\s*|^```\s*|\s*```$/g, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch {}
  }
  return null;
}

// --- Consumed state (persisted per-project: role → boolean) ---

function captureIdleOutput(id, pid, proj) {
  idleCaptureTimers.delete(id);
  if (!projects.has(pid)) return;
  if (proj.status.get(id)) return;
  const w = proj.workers.get(id);
  if (w) {
    const out = latestAgentOutput(id);
    if (out) {
      const oid = outputId(out);
      const prev = proj.lastOutput.get(id);
      const isNew = !prev || prev.outputId !== oid;
      proj.lastOutput.set(id, { text: out, capturedAt: Date.now(), outputId: oid });
      appendKB(pid, { from: w.label, msg: out.slice(0, 4000), outputId: oid });
      // Clear waitingOn when the awaited worker delivers new output
      if (isNew && proj.waitingOn?.toLowerCase() === w.label.toLowerCase()) {
        proj.waitingOn = null;
        proj.staleSince = null;
      }
    }
  }
  if (proj.paused) return;
  const allIdle = [...proj.workers.keys()].every(sid => !proj.status.get(sid));
  if (allIdle) {
    // Track staleness: if no new output arrived since last consult, mark stale
    if (proj.lastAction && !proj.staleSince) {
      const anyNew = [...proj.lastOutput.values()].some(o => o.capturedAt > proj.lastAction.at);
      if (!anyNew) proj.staleSince = Date.now();
    }
    triggerConsult(pid, proj);
  }
}

function clearIdleCaptureTimer(id) {
  const timer = idleCaptureTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    idleCaptureTimers.delete(id);
  }
}

function scheduleIdleCapture(id, pid, proj) {
  clearIdleCaptureTimer(id);
  idleCaptureTimers.set(id, setTimeout(() => captureIdleOutput(id, pid, proj), 5000));
}

function resetProjectState(pid) {
  try { unlinkSync(kbPath(pid)); } catch {}
}

// --- Debug logging ---

const LOGS_DIR = join(DATA_DIR, 'logs');
const debugCounters = new Map(); // pid → turn counter

function debugLog(pid, label, content) {
  if (api.getSetting('debugging') !== true) return;
  mkdirSync(LOGS_DIR, { recursive: true });
  const n = (debugCounters.get(pid) || 0) + 1;
  debugCounters.set(pid, n);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(LOGS_DIR, `${safeId(pid)}_${String(n).padStart(3, '0')}_${label}_${ts}.md`);
  writeFileSync(file, content);
}

function resetDebugLogs(pid) {
  debugCounters.set(pid, 0);
}

// --- Helpers ---

function projectFor(sid) {
  for (const [pid, proj] of projects) {
    if (proj.workers.has(sid)) return [pid, proj];
  }
  return [null, null];
}

function workerByLabel(proj, label) {
  for (const [sid, w] of proj.workers) {
    if (w.label.toLowerCase() === String(label || '').toLowerCase()) return sid;
  }
  return null;
}

function isAutopilotWorkerSession(s) {
  return s.projectId && s.presetId !== 'shell';
}

async function inferWorkerRole(pid, session, label, goal, model, provider, apiKey) {
  const messages = firstUserMessages(session.id, FIRST_USER_MESSAGES);
  if (!messages.length) {
    return {
      error: unpromptedSessionsMessage([session]),
    };
  }

  const context = messages.map((text, idx) => {
    const clipped = text.length > MAX_GOAL_MESSAGE_CHARS ? text.slice(0, MAX_GOAL_MESSAGE_CHARS) : text;
    return `Message ${idx + 1}:\n${clipped}`;
  }).join('\n\n');

  const prompt = [
    'Hi,',
    'Your task is to infer a role name and a concise summary of that role\'s responsibilities based on what the user has said so far to the agent. This is a crucial step for Autopilot to understand what this agent session is about and route work correctly.',
    '',
    'This is the project goal:',
    '<project_goal>',
    goalText(goal) || 'No project goal available.',
    '</project_goal>',
    '',
    'Read the project goal and the user\'s messages carefully and understand the context of the project and the agent\'s role in it.',
    'This role will be used by Autopilot to understand what this session is for and route work correctly.',
    '',
    'ROLE SCOPE RULES',
    '- Do not write a plan. Do not explain your reasoning.',
    '- Infer what this agent session is mainly responsible for in the project, its main focus, responsibilities, and what it should do or not do.',
    '- The project can be anything: software, research, writing, design, operations, brainstorming, etc.',
    '- If the role is unclear from the user\'s messages, return {"role":"unclear_role","summary":"unclear_role"} only.',
    '',
    'FORMAT RULES',
    '- Return JSON only',
    '- Use exactly this shape: {"role":"...","summary":"..."}',
    '- "role" is short, like a job title or a one- or two-word label for the agent\'s main focus. e.g. "backend developer", "UX researcher", "marketing strategist", "data analyst", "project manager", "content writer", etc.',
    '- "summary" must be a short paragraph, usually 2-5 sentences',
    '- "summary" must explain what the agent is responsible for, what it should do, and what it should not do in this project, based on the user\'s messages and the project goal.',
    '',
    'EXAMPLES',
    'Example 1 input:',
    'You are the docs writer for this project.',
    'Your job is to write the documentation the project needs, such as the README, setup guides, usage docs, and other project documents.',
    'First, review the codebase, structure, and existing docs so your writing matches the real project. Do not invent behavior or features.',
    'Write clear, accurate, concise, well-structured docs with a professional and consistent tone and style.',
    'You do not write code unless documentation examples are needed.',
    '',
    'Example 1 output:',
    '{"role":"Documentation writer","summary":"This agent is the Documentation Writer. Its role is to create the project documentation needed to help users and contributors understand, use, and work with the project clearly and correctly. It should review the codebase, structure, and existing docs before writing so the documentation matches the real project state, and it should produce clear, accurate, concise, and well-structured documents in the requested tone and style. It should not invent features or behavior, and it should not write code except when documentation examples are necessary."}',
    '',
    'Example 2 input:',
    'You are the Product Manager for this project.',
    'Your job is to understand the product deeply: what it does, why it exists, who it serves, and what the best user experience should be.',
    'You focus on product quality above all else. Technical limitations, implementation preferences, and engineering convenience are secondary.',
    'You never write code.',
    'First, review the existing project if there is one. Read the codebase, documentation, and README to understand what the product is, why it was built, and what good execution should look like.',
    '',
    'Example 2 output:',
    '{"role":"Product manager","summary":"This agent is the Product Manager. Its role is to understand the product end to end, define what best-in-class user experience looks like, and guide the team toward polished, high-quality outcomes with strong UI/UX standards. It should review the existing project to understand the product, its purpose, and its users, and it should evaluate decisions through the lens of user value, clarity, trust, and quality. It should not write code or optimize for engineering convenience over product quality."}',
    '',
    'SESSION',
    `Label: ${label}`,
    `Name: ${sessionDisplayName(session)}`,
    '',
    'SOURCE CONTEXT',
    context,
  ].join('\n');

  const res = await (await ai()).complete(model, {
    systemPrompt: 'You infer concise neutral worker roles for workflow routing. Output JSON only.',
    messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
  }, { apiKey, reasoning: 'minimal' });

  addTokens(pid, res.usage);
  const raw = res.content?.find(b => b.type === 'text')?.text?.trim() || '';
  const parsed = parseJsonObject(raw);
  const role = String(parsed?.role || '').replace(/\s+/g, ' ').trim();
  const summary = String(parsed?.summary || '').replace(/\s+/g, ' ').trim();
  const unclear = role.toLowerCase() === 'unclear_role' || summary.toLowerCase() === 'unclear_role';
  if (!parsed || unclear || !role || !summary) {
    return {
      unclear: true,
      usage: res.usage,
      notifyReason: `Autopilot could not infer a clear role for session "${label}". Add one or more user messages that make its mission clear, then start Autopilot again.`,
      raw,
      context,
    };
  }

  return {
    role,
    summary,
    usage: res.usage,
    raw,
    context,
  };
}

function bootstrapWorkers(pid) {
  const sessions = candidateSessions(pid);
  if (!sessions.length) return { error: 'No project sessions found for Autopilot' };

  const empty = sessions.filter(s => !hasUserMessage(s.id));
  if (empty.length) {
    return {
      error: unpromptedSessionsMessage(empty),
    };
  }

  const workers = new Map();
  const status = new Map();
  const takenLabels = new Set();

  for (const session of sessions) {
    const label = buildRouteLabel(session, takenLabels);
    takenLabels.add(label.toLowerCase());
    workers.set(session.id, {
      name: sessionDisplayName(session),
      label,
      role: null,
      summary: null,
      presetId: session.presetId,
    });
    status.set(session.id, session.working === true);
  }
  return { workers, status };
}

async function inferRolesForWorkers(pid, proj, model, provider, apiKey) {
  const roleUsage = { input: 0, output: 0 };
  for (const [sid, worker] of proj.workers) {
    const session = api.getSessions().find(s => s.id === sid);
    if (!session) continue;
    const inferred = await inferWorkerRole(pid, session, worker.label, proj.goal, model, provider, apiKey);
    roleUsage.input += inferred.usage?.input || 0;
    roleUsage.output += inferred.usage?.output || 0;
    if (inferred.error) return { error: inferred.error, usage: roleUsage };
    if (inferred.unclear) return { unclear: true, notifyReason: inferred.notifyReason, usage: roleUsage };
    worker.role = inferred.role;
    worker.summary = inferred.summary;
    appendKB(pid, { type: 'worker-role', worker: worker.label, role: inferred.role, summary: inferred.summary });
    api.appendPillLog(pillId(pid), `Role: ${worker.label} → ${inferred.role}`);
  }

  debugLog(pid, 'roles', [
    `# Worker Roles — ${new Date().toISOString()}`,
    `Provider: ${provider}`,
    `Project goal: ${goalText(proj.goal) || '(none)'}`,
    `Tokens: in=${roleUsage.input} out=${roleUsage.output} total=${roleUsage.input + roleUsage.output}`,
    '',
    ...[...proj.workers.values()].map(w => `- ${w.label}: ${w.role} — ${w.summary}`),
  ].join('\n'));

  return { usage: roleUsage };
}

// Returns null on success, or an error string (caller must stop autopilot).
async function refreshWorkers(pid, proj, model, provider, apiKey) {
  const liveSessions = candidateSessions(pid);
  const live = new Map();
  const liveStatus = new Map();
  const empty = liveSessions.filter(s => !hasUserMessage(s.id));
  if (empty.length) {
    return unpromptedSessionsMessage(empty);
  }

  for (const s of liveSessions) {
    live.set(s.id, s);
    liveStatus.set(s.id, s.working === true);
  }
  // Remove dead sessions
  for (const sid of [...proj.workers.keys()]) {
    if (!live.has(sid)) {
      proj.workers.delete(sid);
      proj.status.delete(sid);
      proj.lastOutput.delete(sid);
      api.setAutoApproveMenu(sid, false);
    }
  }
  // Add new sessions
  const takenLabels = new Set([...proj.workers.values()].map(w => w.label.toLowerCase()));
  for (const [sid, session] of live) {
    if (!proj.workers.has(sid)) {
      const label = buildRouteLabel(session, takenLabels);
      takenLabels.add(label.toLowerCase());
      const inferred = await inferWorkerRole(pid, session, label, proj.goal, model, provider, apiKey);
      if (inferred.error) return inferred.error;
      if (inferred.unclear) return inferred.notifyReason;
      proj.workers.set(sid, {
        name: sessionDisplayName(session),
        label,
        role: inferred.role,
        summary: inferred.summary,
        presetId: session.presetId,
      });
      proj.status.set(sid, liveStatus.get(sid));
      appendKB(pid, { type: 'worker-role', worker: label, role: inferred.role, summary: inferred.summary, added: true });
      api.setAutoApproveMenu(sid, true);
      if (!liveStatus.get(sid)) {
        const text = latestAgentOutput(sid);
        if (text) proj.lastOutput.set(sid, { text, capturedAt: Date.now(), outputId: outputId(text) });
      }
      const pillId = `autopilot-${pid}`;
      api.appendPillLog(pillId, `Role: ${label} → ${inferred.role}`);
    }
  }
  for (const [sid, session] of live) {
    const w = proj.workers.get(sid);
    if (!w) continue;
    w.name = sessionDisplayName(session);
    proj.status.set(sid, liveStatus.get(sid));
  }
  return null;
}

// --- Model management ---

function filterModels(all) {
  // pi-ai model objects have no alias/canonical metadata — the display name is
  // the only signal. Canonical models get "(latest)" appended, dated snapshots
  // get "(YYYY-MM-DD)". We drop qualified variants when the clean base exists.
  const baseNames = new Set();
  for (const m of all) {
    const base = m.name.replace(/\s*\((?:latest|\d{4}-\d{2}-\d{2})\)$/, '');
    if (base !== m.name) baseNames.add(base);
  }
  const filtered = all.filter(m => {
    // Drop "(latest)" and "(date)" variants when the clean base name exists as another model
    const qualifier = m.name.match(/\s*\((latest|\d{4}-\d{2}-\d{2})\)$/);
    if (!qualifier) return !baseNames.has(m.name) || true; // clean name — always keep
    const base = m.name.replace(qualifier[0], '');
    // Keep (latest) variant only if no clean base exists
    if (qualifier[1] === 'latest') return !all.find(x => x.name === base);
    // Drop dated variants
    return false;
  });
  return filtered
    .sort((a, b) => a.cost.input - b.cost.input)
    .map(m => ({ value: m.id, label: `${m.name.replace(/\s*\(latest\)$/, '')}  ($${m.cost.input}/M)` }));
}

function goalText(goal) {
  return String(goal?.text || '').trim();
}

async function buildGoal(pid, proj, model, provider, apiKey) {
  const sourceContext = goalSourceContext(proj);
  if (!sourceContext) return { error: 'No early user messages found to build project goal' };

  const prompt = [
    'Hi, You are writing a concise project goal based on early user-side messages.',
    'This goal will be used to guide the project and keep it focused on the main objectives.',
    '',
    'PROJECT GOAL SCOPE RULES',
    '- Use only the early user-side messages below.',
    '- Do not write a plan. Do not write steps. Do not explain your reasoning.',
    '- Write one short paragraph that captures the project mission/task/goal.',
    '- The project can be anything: a software project, a research project, a writing project, etc. Do not assume it\'s coding work.',
    '- If the goal is unclear, return "unclear_goal" only.',
    '',
    'FORMAT RULES',
    '- One paragraph only',
    '- Plain text only',
    '- Keep it concise and easy to scan later',
    '- Generic wording: do not assume this is coding work',
    '',
    'SOURCE CONTEXT',
    sourceContext,
  ].join('\n');

  const res = await (await ai()).complete(model, {
    systemPrompt: 'You write concise, neutral project-goal summaries for workflow routing.',
    messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
  }, { apiKey, reasoning: 'minimal' });

  addTokens(pid, res.usage);
  const text = res.content?.find(b => b.type === 'text')?.text?.trim() || '';
  if (!text) return { error: 'Model returned an empty project goal' };
  if (isUnclearGoal(text)) {
    return {
      unclear: true,
      usage: res.usage,
      notifyReason: `Autopilot could not infer a clear project goal. Add a message starting with \`${GOAL_PREFIX}\` in any existing project worker session, then start Autopilot again.`,
    };
  }

  const goal = {
    text: text.replace(/\s+/g, ' ').trim(),
    builtAt: new Date().toISOString(),
    source: 'model',
  };
  saveGoal(pid, goal);
  appendKB(pid, { type: 'goal', goal: goal.text, source: goal.source, usage: usageTotals(res.usage) });
  debugLog(pid, 'goal', [
    `# Project Goal — ${goal.builtAt}`,
    `Provider: ${provider}`,
    `Tokens: in=${res.usage?.input || 0} out=${res.usage?.output || 0} total=${(res.usage?.input || 0) + (res.usage?.output || 0)}`,
    '',
    '## Source Context',
    sourceContext,
    '',
    '## Goal',
    goal.text,
  ].join('\n'));
  return { goal, usage: res.usage };
}

async function loadModelsForProvider(provider) {
  try {
    const m = await ai();
    const options = filterModels(m.getModels(provider));
    // Set options first so setSetting can validate against the new list
    api.setSettingOptions('model', options);
    const current = api.getSetting('model');
    if (options.length && !options.find(o => o.value === current)) {
      api.setSetting('model', options[0].value);
    }
  } catch (e) {
    api.log(`Failed to load models for ${provider}: ${e.message}`);
  }
}

// --- Provider helpers ---

function toolChoiceForProvider(provider) {
  // Anthropic, Google, Mistral use "any"; OpenAI-compatible (openai, groq, openrouter, xai, cerebras) use "required"
  return ({ anthropic: 'any', google: 'any', mistral: 'any' })[provider] || 'required';
}

// --- LLM tools ---

function buildTools(Type) {
  return [
    {
      name: 'route',
      description: 'Forward one agent\'s output to another idle agent. The system copies the output verbatim — you only choose who sends and who receives.',
      parameters: Type.Object({
        from: Type.String({ description: 'Source agent label (prefer [LATEST] agent)' }),
        to: Type.String({ description: 'Target agent label (must be IDLE)' }),
      }),
    },
    {
      name: 'notify_user',
      description: 'Notify the user and stop autopilot. Use light markdown. Keep it concise (2-5 sentences). Use when: workflow is complete, human input is needed, or agents are stuck.',
      parameters: Type.Object({
        reason: Type.String({ description: 'Short message to user (2-3 sentences max)' }),
      }),
    },
  ];
}

// --- System prompt ---

const PROMPT_TEMPLATE = readFileSync(join(__dirname, 'prompt.md'), 'utf8');

function buildPrompt(proj, pid) {
  const pList = api.getProjects();
  const p = pList.find(x => x.id === pid);
  const projectName = p ? `${p.name}${p.path ? ` (${p.path})` : ''}` : pid;

  const agentProfiles = [];
  for (const [sid, w] of proj.workers) {
    const busy = proj.status.get(sid);
    agentProfiles.push(`${w.label} [${busy ? 'WORKING' : 'IDLE'}]\n  Inferred role: ${w.role}\n  Summary: ${w.summary}`);
  }

  let prompt = PROMPT_TEMPLATE
    .replace('{{projectName}}', projectName)
    .replace('{{agents}}', agentProfiles.join('\n\n'));

  return prompt;
}

function buildStateContext(proj, pid) {
  const fmtTs = (ts) => ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
  const fmtAgo = (ts) => {
    if (!ts) return '';
    const sec = Math.round((Date.now() - ts) / 1000);
    if (sec < 60) return `${sec}s ago`;
    return `${Math.round(sec / 60)}m ago`;
  };

  const lines = ['PROJECT GOAL', `  ${goalText(proj.goal) || 'Goal not set'}`, '', 'CURRENT STATE'];

  // Per-worker state
  const lastActionAt = proj.lastAction?.at || 0;
  for (const [sid, w] of proj.workers) {
    const stored = proj.lastOutput.get(sid);
    const oid = stored?.outputId || null;
    const capturedAt = stored?.capturedAt || 0;
    const isNew = capturedAt > lastActionAt;
    const status = proj.status.get(sid) ? 'WORKING' : 'IDLE';
    let line = `  ${w.label}: ${status} | role: ${w.role}`;
    if (oid) line += ` | output #${oid} captured ${fmtAgo(capturedAt)}${isNew ? ' (NEW)' : ''}`;
    else line += ' | no output';
    lines.push(line);
  }

  // Handoff summary from KB: which outputs were routed where
  const kb = readKB(pid, 30);
  const handoffs = new Map(); // outputId → { from, routedTo: Set }
  for (const e of kb) {
    if (e.from && e.to && e.outputId) {
      if (!handoffs.has(e.outputId)) handoffs.set(e.outputId, { from: e.from, routedTo: new Set() });
      handoffs.get(e.outputId).routedTo.add(e.to);
    }
  }
  if (handoffs.size) {
    lines.push('');
    lines.push('HANDOFF LOG');
    for (const [oid, h] of handoffs) {
      lines.push(`  #${oid} from ${h.from} → routed to: ${[...h.routedTo].join(', ')}`);
    }
  }

  // Project-level routing state
  lines.push('');
  lines.push('ROUTING STATE');
  if (proj.lastAction) {
    lines.push(`  Last route: ${proj.lastAction.from} → ${proj.lastAction.to} (output #${proj.lastAction.outputId}, ${fmtAgo(proj.lastAction.at)})`);
  } else {
    lines.push('  No routes yet');
  }
  if (proj.waitingOn) lines.push(`  Waiting on: ${proj.waitingOn}`);
  if (proj.staleSince) lines.push(`  Stale since: ${fmtAgo(proj.staleSince)} (no new output since last route)`);

  // Recent routing history (compact, last 15)
  const recent = kb.slice(-15);
  if (recent.length) {
    lines.push('');
    lines.push('RECENT HISTORY');
    for (const e of recent) {
      const t = fmtTs(e.ts);
      if (e.from && e.to) lines.push(`  ${t} ${e.from} → ${e.to} (#${e.outputId || '?'})`);
      else if (e.from) lines.push(`  ${t} [${e.from}] output captured (#${e.outputId || '?'})`);
    }
  }

  return lines.join('\n');
}

// --- Core: consult LLM ---

async function consult(pid, proj) {
  if (proj.pending || proj.paused || !projects.has(pid)) return;
  const runPillId = pillId(pid);
  const provider = api.getSetting('provider') || 'anthropic';
  const modelId = api.getSetting('model') || 'claude-opus-4-6';
  let m;
  try { m = await ai(); } catch (e) {
    api.sendToFrontend('notify', { projectId: pid, reason: `Failed to load AI library: ${e.message}` });
    stop(pid);
    return;
  }
  const apiKey = api.getSetting('apiKey') || m.getEnvApiKey(provider) || '';
  if (!apiKey) {
    proj.paused = true;
    proj.pauseReason = 'config';
    api.sendToFrontend('error', { msg: `No API key for ${provider}. Set in Autopilot settings or via env var.` });
    api.sendToFrontend('paused', { projectId: pid, question: 'API key missing — configure in plugin settings' });
    api.updateSessionPill(runPillId, { working: false, statusText: 'Paused — no API key' });
    api.appendPillLog(runPillId, 'Paused: API key missing');
    return;
  }

  let model;
  try { model = m.getModel(provider, modelId); } catch (e) {
    api.sendToFrontend('notify', { projectId: pid, reason: `Model "${modelId}" not found — autopilot stopped` });
    stop(pid);
    return;
  }

  const refreshErr = await refreshWorkers(pid, proj, model, provider, apiKey);
  if (refreshErr) {
    api.sendToFrontend('notify', { projectId: pid, reason: `${refreshErr} — autopilot stopped` });
    stop(pid);
    return;
  }
  // Re-check all-idle after refresh — new workers may be busy
  if (![...proj.workers.keys()].every(sid => !proj.status.get(sid))) return;

  // Build structured state context
  const stateContext = buildStateContext(proj, pid);

  // Build agent output section
  const lastActionAt = proj.lastAction?.at || 0;
  const entries = [];
  for (const [sid, w] of proj.workers) {
    const stored = proj.lastOutput.get(sid);
    let text = stored?.text || null;
    let capturedAt = stored?.capturedAt || 0;
    let oid = stored?.outputId || null;
    if (!text) {
      text = latestAgentOutput(sid);
      if (text) { capturedAt = capturedAt || Date.now(); oid = outputId(text); }
    }
    entries.push({ sid, label: w.label, role: w.role, text, capturedAt, outputId: oid });
  }
  entries.sort((a, b) => a.capturedAt - b.capturedAt);

  const outputParts = entries.map(e => {
    const isNew = e.capturedAt > lastActionAt;
    const tag = isNew ? ' — NEW' : '';
    const idTag = e.outputId ? ` (#${e.outputId})` : '';
    return `[${e.label}${tag}${idTag} | ${e.role}]:\n${e.text ? e.text.slice(0, 2000) : '(no output captured)'}`;
  });

  const sections = [stateContext, ''];
  if (outputParts.length) {
    sections.push('AGENT OUTPUTS');
    sections.push(outputParts.join('\n\n'));
  } else {
    sections.push('No output from any agent yet.');
  }
  sections.push('\nDecide what to route next.');

  const ctx = {
    systemPrompt: buildPrompt(proj, pid),
    messages: [{
      role: 'user',
      content: sections.join('\n'),
      timestamp: Date.now(),
    }],
    tools: buildTools(m.Type),
  };

  debugLog(pid, 'turn', [
    `# Router Turn — ${new Date().toISOString()}`,
    `Model: ${modelId} (${provider})`,
    '',
    '## System Prompt',
    ctx.systemPrompt,
    '',
    '## User Message',
    ctx.messages[0].content,
  ].join('\n'));

  api.updateSessionPill(runPillId, { working: true, statusText: 'Consulting router...' });
  api.appendPillLog(runPillId, `Consulting ${modelId}`);
  // api.log(`[consult] model=${modelId} workers=${[...proj.workers.values()].map(w => w.role).join(',')}`);
  // api.log(`[consult] hasOutput=${[...proj.workers].filter(([sid]) => proj.lastOutput.has(sid)).map(([,w]) => w.role).join(',') || 'none'}`);

  const MAX_HINTS = 3;
  const HINT_DELAYS = [0, 3000, 6000];
  const delay = ms => new Promise(r => setTimeout(r, ms));

  proj.pending = true;
  const opts = { apiKey, reasoning: 'minimal', toolChoice: toolChoiceForProvider(provider) };
  try {
    for (let attempt = 0; attempt < MAX_HINTS; attempt++) {
      if (attempt > 0) await delay(HINT_DELAYS[attempt] || 6000);

      const res = await m.complete(model, ctx, opts);
      addTokens(pid, res.usage);

      const tc = res.content?.find(b => b.type === 'toolCall');
      const textContent = res.content?.find(b => b.type === 'text')?.text || '';
      debugLog(pid, `response_${attempt + 1}`, [
        `# Response — attempt ${attempt + 1}/${MAX_HINTS}`,
        `Tokens: in=${res.usage?.input || 0} out=${res.usage?.output || 0}`,
        '',
        tc ? `## Tool Call: ${tc.name}\n\`\`\`json\n${JSON.stringify(tc.arguments, null, 2)}\n\`\`\`` : '## No tool call',
        textContent ? `\n## Text\n${textContent}` : '',
      ].join('\n'));

      if (!tc) {
        ctx.messages.push(
          { role: 'assistant', content: textContent, timestamp: Date.now() },
          { role: 'user', content: 'You must call one of the provided tools: route(from, to) or notify_user(reason). Do not reply with text.', timestamp: Date.now() },
        );
        continue;
      }

      const error = executeAction(pid, proj, tc.name, tc.arguments, runPillId);
      if (error === null) { proj.pending = false; return; }

      // api.log(`[consult] action error — hinting: ${error}`);
      ctx.messages.push(res, {
        role: 'toolResult', toolCallId: tc.id, toolName: tc.name,
        content: [{ type: 'text', text: error }], isError: true, timestamp: Date.now(),
      });
    }

    proj.pending = false;
    api.sendToFrontend('notify', { projectId: pid, reason: 'Model failed after multiple hints — autopilot stopped' });
    stop(pid);
  } catch (e) {
    proj.pending = false;
    api.log(`LLM error: ${e.message}`);
    api.sendToFrontend('notify', { projectId: pid, reason: `Model error: ${e.message}` });
    stop(pid);
  }
}

function triggerConsult(pid, proj) {
  if (!projects.has(pid) || proj.paused || proj.pending) return;
  consult(pid, proj);
}

// --- Action execution (returns error string or null on success) ---

function executeAction(pid, proj, action, args, pillId) {
  const labels = [...proj.workers.values()].map(w => w.label);
  switch (action) {
    case 'route': {
      const src = workerByLabel(proj, args.from);
      const dst = workerByLabel(proj, args.to);
      if (!src) return `No agent with label "${args.from}". Available agents: ${labels.join(', ')}`;
      if (!dst) return `No agent with label "${args.to}". Available agents: ${labels.join(', ')}`;
      if (src === dst) return 'Cannot route agent to itself';
      if (proj.status.get(dst)) return `"${args.to}" is currently working — pick an idle agent`;
      const stored = src ? proj.lastOutput.get(src) : null;
      let out = stored?.text || null;
      let oid = stored?.outputId || null;
      if (!out && src) {
        out = latestAgentOutput(src);
        if (out) oid = outputId(out);
      }
      if (!out) return `"${args.from}" has no output to route`;

      // Repeat guard: block same outputId → same target unless new output was captured in between
      const la = proj.lastAction;
      if (la && oid && la.outputId === oid && la.to.toLowerCase() === args.to.toLowerCase()) {
        const anyNewSince = [...proj.lastOutput.values()].some(o => o.capturedAt > la.at);
        if (!anyNewSince) {
          return `Output #${oid} was already routed to "${args.to}" and no new output has been captured since. Pick a different target or call notify_user if stuck.`;
        }
      }

      const dstWorker = proj.workers.get(dst);
      const header = [
        `[Autopilot route${oid ? ` | output #${oid}` : ''}]`,
        `[Team: ${labels.join(', ')}]`,
        `[Target session: ${dstWorker?.label || args.to}]`,
        `[Target inferred role: ${dstWorker?.role || 'unknown'}]`,
        `[From: ${args.from}]`,
        '[Do not spawn internal agents.]',
      ].join('\n');
      const payload = `${header}\n\n${out}`;
      api.inputToSession(dst, payload);
      setTimeout(() => api.inputToSession(dst, '\r'), 150);
      const now = Date.now();
      appendKB(pid, { from: args.from, to: args.to, msg: out.slice(0, 4000), outputId: oid });
      proj.lastAction = { outputId: oid, from: args.from, to: args.to, at: now };
      proj.waitingOn = args.to;
      proj.staleSince = null;
      const projName = api.getProjects().find(x => x.id === pid)?.name || 'Project';
      api.sendToFrontend('routed', { projectId: pid, projectName: projName, from: args.from, to: args.to });
      if (pillId) {
        api.updateSessionPill(pillId, { working: false, statusText: `${args.from} → ${args.to}` });
        api.appendPillLog(pillId, `Routed ${args.from} → ${args.to}`);
      }
      return null;
    }
    case 'notify_user': {
      if (pillId) {
        api.appendPillLog(pillId, `Notify: ${args.reason}`);
        api.updateSessionPill(pillId, { working: false, statusText: 'Finished' });
      }
      const pList = api.getProjects();
      const projName = pList.find(x => x.id === pid)?.name || 'Project';
      api.sendToFrontend('notify', { projectId: pid, reason: args.reason, projectName: projName });
      // api.log(`Notify + stop: ${args.reason}`);
      stop(pid, true); // keepPill=true
      return null;
    }
    default:
      return `Unknown tool "${action}". You must use route(from, to) or notify_user(reason).`;
  }
}

// --- Lifecycle ---

async function start(pid) {
  if (projects.has(pid)) return { error: 'Already running' };
  if (!enabled()) return { error: 'Autopilot disabled' };

  const provider = api.getSetting('provider') || 'anthropic';
  const m = await ai();
  const apiKey = api.getSetting('apiKey') || m.getEnvApiKey(provider) || '';
  if (!apiKey) return { error: 'Set the API key in Autopilot settings (Plugins panel)' };
  const modelId = api.getSetting('model') || 'claude-opus-4-6';
  let model;
  try { model = m.getModel(provider, modelId); } catch { return { error: `Model "${modelId}" not found` }; }

  resetProjectState(pid);
  resetDebugLogs(pid);

  const seeded = bootstrapWorkers(pid);
  if (seeded.error) return { error: seeded.error };
  const { workers, status } = seeded;
  if (workers.size < 1) return { error: 'No project sessions found for Autopilot' };

  const proj = {
    workers,
    status,
    lastOutput: new Map(),
    goal: null,
    paused: false,
    pauseReason: null,
    pending: false,
    lastAction: null,    // { outputId, from, to, at }
    waitingOn: null,     // role name we expect new output from
    staleSince: null,    // timestamp when we started waiting without progress
  };
  projects.set(pid, proj);

  const runPillId = pillId(pid);
  api.addSessionPill({ id: runPillId, title: 'Autopilot', projectId: pid });
  api.appendPillLog(runPillId, `Started with ${workers.size} workers: ${[...workers.values()].map(w => w.label).join(', ')}`);

  // Flag all workers for core menu auto-approve
  for (const [sid] of workers) api.setAutoApproveMenu(sid, true);

  for (const [sid, w] of workers) {
    if (status.get(sid)) continue;
    const text = latestAgentOutput(sid);
    if (!text) continue;
    proj.lastOutput.set(sid, { text, capturedAt: Date.now(), outputId: outputId(text) });
  }

  // api.log(`Started: ${pid}, ${workers.size} workers`);
  api.sendToFrontend('started', { projectId: pid });

  const explicit = findExplicitGoal(proj);
  if (explicit.error) {
    api.updateSessionPill(runPillId, { working: false, statusText: 'Goal conflict' });
    api.appendPillLog(runPillId, `Notify: ${explicit.error}`);
    api.sendToFrontend('notify', { projectId: pid, reason: explicit.error });
    stop(pid, true, 'Stopped');
    return { error: explicit.error };
  }

  if (explicit.goal) {
    proj.goal = explicit.goal;
    saveGoal(pid, explicit.goal);
    appendKB(pid, { type: 'goal', goal: explicit.goal.text, source: explicit.goal.source });
    api.updateSessionPill(runPillId, { working: false, statusText: 'Project goal ready' });
    api.appendPillLog(runPillId, `Goal: ${explicit.goal.text}`);
    api.appendPillLog(runPillId, formatTokenLog('Goal', null, 'explicit message'));
  } else {
    const savedGoal = loadGoal(pid);
    if (savedGoal) {
      proj.goal = savedGoal;
      appendKB(pid, { type: 'goal', goal: savedGoal.text, source: savedGoal.source || 'saved', loaded: true });
      api.updateSessionPill(runPillId, { working: false, statusText: 'Project goal ready' });
      api.appendPillLog(runPillId, `Goal: ${savedGoal.text}`);
    } else {
      proj.pending = true;
      api.updateSessionPill(runPillId, { working: true, statusText: 'Building project goal...' });
      api.appendPillLog(runPillId, 'Building project goal');
      const built = await buildGoal(pid, proj, model, provider, apiKey);
      proj.pending = false;
      if (built.error) {
        api.sendToFrontend('notify', { projectId: pid, reason: `${built.error} — autopilot stopped` });
        stop(pid, true, 'Stopped');
        return { error: built.error };
      }
      if (built.unclear) {
        api.updateSessionPill(runPillId, { working: false, statusText: 'Goal required' });
        api.appendPillLog(runPillId, 'Goal: unclear_goal');
        api.appendPillLog(runPillId, formatTokenLog('Goal', built.usage, 'goal build'));
        api.appendPillLog(runPillId, `Notify: ${built.notifyReason}`);
        api.sendToFrontend('notify', { projectId: pid, reason: built.notifyReason });
        stop(pid, true, 'Goal required');
        return { error: 'unclear_goal' };
      }
      proj.goal = built.goal;
      api.updateSessionPill(runPillId, { working: false, statusText: 'Project goal ready' });
      api.appendPillLog(runPillId, `Goal: ${built.goal.text}`);
      api.appendPillLog(runPillId, formatTokenLog('Goal', built.usage, 'goal build'));
    }
  }

  api.updateSessionPill(runPillId, { working: true, statusText: 'Inferring agent roles...' });
  api.appendPillLog(runPillId, 'Inferring agent roles');
  const roleResult = await inferRolesForWorkers(pid, proj, model, provider, apiKey);
  if (roleResult.error) {
    api.sendToFrontend('notify', { projectId: pid, reason: `${roleResult.error} — autopilot stopped` });
    stop(pid, true, 'Stopped');
    return { error: roleResult.error };
  }
  if (roleResult.unclear) {
    api.updateSessionPill(runPillId, { working: false, statusText: 'Role required' });
    api.appendPillLog(runPillId, `Notify: ${roleResult.notifyReason}`);
    api.appendPillLog(runPillId, formatTokenLog('Role', roleResult.usage, 'role inference'));
    api.sendToFrontend('notify', { projectId: pid, reason: roleResult.notifyReason });
    stop(pid, true, 'Role required');
    return { error: 'unclear_role' };
  }
  api.appendPillLog(runPillId, formatTokenLog('Role', roleResult.usage, 'role inference'));
  api.updateSessionPill(runPillId, { working: false, statusText: 'Ready' });

  // Only consult if all workers are already idle
  const allIdle = [...workers.keys()].every(sid => !status.get(sid));
  if (allIdle) setTimeout(() => triggerConsult(pid, proj), 3000);

  return { ok: true };
}

function stop(pid, keepPill, finalLog) {
  const proj = projects.get(pid);
  if (!proj) return;
  for (const [sid] of proj.workers) clearIdleCaptureTimer(sid);
  for (const [sid] of proj.workers) api.setAutoApproveMenu(sid, false);
  projects.delete(pid);
  // api.log(`Stopped: ${pid}`);
  api.sendToFrontend('stopped', { projectId: pid });
  const pillId = `autopilot-${pid}`;
  if (keepPill) {
    api.appendPillLog(pillId, finalLog || 'Completed');
  } else {
    api.appendPillLog(pillId, 'Stopped');
    api.removeSessionPill(pillId);
  }
}

// --- Plugin init ---

module.exports.init = function (pluginApi) {
  api = pluginApi;
  loadUsage();

  api.addProjectAction({
    id: 'autopilot-toggle',
    title: 'Autopilot',
    icon: '<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>',
  });

  // Toggle on/off
  api.onFrontendMessage('autopilot-toggle', async (msg) => {
    if (projects.has(msg.projectId)) {
      stop(msg.projectId);
    } else {
      // Remove lingering pill from a previous finished run
      api.removeSessionPill(`autopilot-${msg.projectId}`);
      const r = await start(msg.projectId);
      if (r.error) api.sendToFrontend('error', { msg: r.error });
    }
  });

  // Menu detected on an autopilot worker — flag it so idle is suppressed until auto-approve completes
  api.onMenuDetected((id, choices) => {
    if (!choices?.length) return;
    const [pid] = projectFor(id);
    if (pid) {
      menuPending.add(id);
      clearIdleCaptureTimer(id);
    }
  });

  // Status change — the main routing trigger (only when ALL workers are idle)
  api.onStatusChange((id, working, source) => {
    if (!enabled()) return;
    const [pid, proj] = projectFor(id);
    if (!pid) return;
    const w = proj.workers.get(id);
    const role = w?.label || id.slice(0, 8);

    if (working) {
      menuPending.delete(id);
      clearIdleCaptureTimer(id);
    }

    if (!working && menuPending.has(id)) {
      clearIdleCaptureTimer(id);
      menuPending.delete(id);
      // api.log(`[status] ${role} → IDLE (menu pending — suppressed)`);
      return;
    }
    proj.status.set(id, working);
    const pillId = `autopilot-${pid}`;

    if (working) {
      api.appendPillLog(pillId, `${role} → working`);
      api.updateSessionPill(pillId, { working: false, statusText: `Waiting on ${role}` });
      // api.log(`[status] ${role} → WORKING`);
      return;
    }
    if (!proj.workers.has(id)) return;

    api.appendPillLog(pillId, `${role} → idle`);
    scheduleIdleCapture(id, pid, proj);
  });

  // Frontend queries
  api.onFrontendMessage('getStatus', (msg) => {
    const proj = projects.get(msg.projectId);
    const tokens = tokenUsage.get(msg.projectId);
    api.sendToFrontend('status', {
      projectId: msg.projectId,
      active: !!proj,
      paused: proj?.paused || false,
      tokens: tokens || null,
    });
  });

  api.onFrontendMessage('sync', () => {
    for (const [pid] of projects) {
      api.sendToFrontend('status', { projectId: pid, active: true });
    }
  });

  api.onFrontendMessage('getTokens', (msg) => {
    const u = tokenUsage.get(msg.projectId);
    api.sendToFrontend('tokens', { projectId: msg.projectId, ...(u || { input: 0, output: 0 }) });
  });

  // Clear config pauses when user fixes settings; refresh model list on provider change
  api.onSettingsChange((key) => {
    if (key === 'apiKey' || key === 'provider' || key === 'model') {
      for (const [pid, proj] of projects) {
        if (proj.paused && proj.pauseReason === 'config') {
          proj.paused = false;
          proj.pauseReason = null;
          api.sendToFrontend('resumed', { projectId: pid });
          const allIdle = [...proj.workers.keys()].every(sid => !proj.status.get(sid));
          if (allIdle) triggerConsult(pid, proj);
        }
      }
    }
    if (key === 'provider') loadModelsForProvider(api.getSetting('provider'));
  });

  // Load model options on startup
  loadModelsForProvider(api.getSetting('provider') || 'anthropic');

  api.onShutdown(() => {
    for (const [pid] of projects) stop(pid);
    saveUsage();
  });
};
