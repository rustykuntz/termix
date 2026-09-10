const { randomUUID } = require('crypto');

const DEFAULT_PROMPT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_PROMPT_TIMEOUT_MS = 60 * 60 * 1000;

function validSessionId(value) {
  return typeof value === 'string' && value.trim()
    && value.length <= 200 && !value.includes('\0');
}

function validTimeout(value) {
  return Number.isInteger(value) && value > 0 && value <= MAX_PROMPT_TIMEOUT_MS;
}

function parsePromptRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !validSessionId(value.sessionId)
    || typeof value.question !== 'string' || !value.question.trim()
    || value.question.length > 2000 || value.question.includes('\0')) return null;
  const options = value.options === undefined ? [] : value.options;
  const timeoutMs = value.timeoutMs === undefined
    ? DEFAULT_PROMPT_TIMEOUT_MS : value.timeoutMs;
  if (!Array.isArray(options) || options.length > 12
    || options.some((option) => typeof option !== 'string' || !option.trim()
      || option.length > 200 || option.includes('\0'))
    || !validTimeout(timeoutMs)) return null;
  return {
    sessionId: value.sessionId.trim(),
    question: value.question,
    options: [...options],
    timeoutMs,
  };
}

function parseAnnotateRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !validSessionId(value.sessionId)
    || typeof value.path !== 'string' || !value.path.trim()
    || value.path.length > 4096 || value.path.includes('\0')) return null;
  const timeoutMs = value.timeoutMs === undefined
    ? DEFAULT_PROMPT_TIMEOUT_MS : value.timeoutMs;
  if (!validTimeout(timeoutMs)) return null;
  return {
    sessionId: value.sessionId.trim(),
    path: value.path,
    timeoutMs,
  };
}

class PromptCoordinator {
  constructor(onEvent = () => {}, options = {}) {
    this.onEvent = onEvent;
    this.createId = options.createId || randomUUID;
    this.active = new Map();
    this.bySession = new Map();
  }

  emit(event) {
    try { this.onEvent(event); } catch {}
  }

  prompt(sessionId, fields, timeoutMs) {
    const promptId = this.createId();
    return new Promise((resolve) => {
      const finish = (result) => {
        const pending = this.active.get(promptId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.active.delete(promptId);
        const ids = this.bySession.get(sessionId);
        ids?.delete(promptId);
        if (!ids?.size) this.bySession.delete(sessionId);
        this.emit({ type: 'prompt.resolved', promptId });
        resolve(result);
      };
      const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), timeoutMs);
      this.active.set(promptId, { sessionId, timer, finish });
      let ids = this.bySession.get(sessionId);
      if (!ids) {
        ids = new Set();
        this.bySession.set(sessionId, ids);
      }
      ids.add(promptId);
      this.emit({ type: 'prompt.show', sessionId, promptId, ...fields });
    });
  }

  answer(promptId, value) {
    const pending = this.active.get(String(promptId || ''));
    if (!pending) return false;
    pending.finish({ ok: true, value });
    return true;
  }

  cancelSession(sessionId) {
    const ids = [...(this.bySession.get(String(sessionId || '')) || [])];
    for (const promptId of ids) {
      this.active.get(promptId)?.finish({ ok: false, error: 'session_closed' });
    }
    return ids.length;
  }
}

module.exports = {
  DEFAULT_PROMPT_TIMEOUT_MS,
  MAX_PROMPT_TIMEOUT_MS,
  PromptCoordinator,
  parseAnnotateRequest,
  parsePromptRequest,
};
