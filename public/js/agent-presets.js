// Client-side agent metadata for the 7 built-in providers. The engine's availability check reports
// {available, version, error} but NOT the install command or a minimum version — so this table supplies the
// "Add" (install) and "Update" (outdated) hints. Ported from v1 agent-presets.json. Keyed by the engine
// provider id (providers-ui.js). Shell is always available and has nothing to install.
export const AGENT_PRESETS = {
  "claude-code": { command: "claude",   minVersion: "2.1.90",  installCmd: "npm install -g @anthropic-ai/claude-code" },
  "antigravity": { command: "agy",      minVersion: "",        installCmd: "" },
  "codex":       { command: "codex",    minVersion: "0.118.0", installCmd: "npm install -g @openai/codex" },
  "gemini":      { command: "gemini",   minVersion: "0.36.0",  installCmd: "npm install -g @google/gemini-cli" },
  "opencode":    { command: "opencode", minVersion: "1.2.26",  installCmd: "npm install -g opencode-ai" },
  "pi":          { command: "pi",       minVersion: "0.79.3",  installCmd: "npm install -g --ignore-scripts @earendil-works/pi-coding-agent" },
  "shell":       { command: "",         minVersion: "",        installCmd: "" },
};

function verParts(s) { const m = String(s == null ? "" : s).match(/(\d+)\.(\d+)\.(\d+)/); return m ? [+m[1], +m[2], +m[3]] : null; }
function cmp(a, b) { for (let i = 0; i < 3; i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) return d; } return 0; }

// Health of a built-in provider given its availability entry {available,version,error}:
//   'ok'       — installed (and, if we know a minVersion, current enough)
//   'missing'  — not installed → offer the install command
//   'outdated' — installed but below minVersion → offer the update command
//   'unknown'  — no availability data yet (check hasn't replied)
export function providerHealth(id, entry) {
  const preset = AGENT_PRESETS[id] || {};
  if (id === "shell") return { state: "ok", version: (entry && entry.version) || "" };
  if (!entry) return { state: "unknown" };
  if (entry.available === false) return { state: "missing", installCmd: preset.installCmd };
  const cur = verParts(entry.version), min = preset.minVersion ? verParts(preset.minVersion) : null;
  if (cur && min && cmp(cur, min) < 0) return { state: "outdated", version: entry.version, minVersion: preset.minVersion, installCmd: preset.installCmd };
  return { state: "ok", version: entry.version || "" };
}
