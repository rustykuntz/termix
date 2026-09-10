import { store } from "./store.js";   // custom-command sessions resolve their icon/label from config.commands

// Provider display identity — label, mark, tint class, search terms. DISPLAY ONLY:
// the engine owns behavior (id + command); this owns how a provider looks. One source
// of truth for provider identity across the sidebar, terminal header, and new-session picker.
//
// Marks are inline SVG created in the DOM (not served files) — the engine's .html/.js/.css
// MIME map is irrelevant to them. Tints are muted + cool, deliberately outside the
// amber/sage/coral triad, so provider hue is identity-only and never reads as a status.

const NS = "http://www.w3.org/2000/svg";

function svgEl(inner) {
  const s = document.createElementNS(NS, "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("fill", "none");
  s.innerHTML = inner;              // parsed in the SVG namespace (the element's own context)
  return s;
}

// Claude — a sunburst spark: 12 tapered spokes radiating from a small core.
function claudeMark() {
  let rays = "";
  for (let k = 0; k < 12; k++) {
    const len = k % 3 === 0 ? 8.4 : 6.6;              // long/short alternation → organic burst
    rays += `<rect x="-0.95" y="${-len - 2.4}" width="1.9" height="${len}" rx="0.95" fill="currentColor" transform="rotate(${k * 30})"/>`;
  }
  return svgEl(`<g transform="translate(12 12)">${rays}<circle r="1.5" fill="currentColor"/></g>`);
}

// Antigravity — a light orbital A: grounded enough to read at 15px, with one rising satellite that gives
// it motion without importing the oversized legacy artwork.
function antigravityMark() {
  return svgEl(
    `<path d="M6.8 17.8 12 5.8l5.2 12M8.8 13.5h6.4" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<path d="M4.4 10.2c1.5-4.7 6.2-7.5 11-6.3" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" opacity=".7"/>` +
    `<circle cx="17.9" cy="4.9" r="1.55" fill="currentColor"/>`
  );
}

// Codex — a six-fold interlocking rosette, evoking the OpenAI knot (stroked loops, not a copy).
function codexMark() {
  let petals = "";
  for (let k = 0; k < 6; k++) {
    petals += `<ellipse cx="0" cy="-4.3" rx="3.1" ry="6.4" transform="rotate(${k * 60})" stroke="currentColor" stroke-width="1.5" opacity="${k % 2 ? 0.55 : 0.9}"/>`;
  }
  return svgEl(`<g transform="translate(12 12)">${petals}</g>`);
}

// Shell — the universal command prompt: a chevron and a cursor underscore ("> _").
function shellMark() {
  return svgEl(
    `<path d="M7.5 8.2 L12 12 L7.5 15.8" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<path d="M13.2 15.7 L17 15.7" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>`
  );
}

// Gemini — a four-point spark (the sparkle glyph): a concave star as one filled path.
function geminiMark() {
  return svgEl(`<path d="M12 2.6 Q13.1 10.9 21.4 12 Q13.1 13.1 12 21.4 Q10.9 13.1 2.6 12 Q10.9 10.9 12 2.6 Z" fill="currentColor"/>`);
}

// OpenCode — a pair of curly braces "{ }": the code-block sigil, stroked (distinct from shell's chevron).
function opencodeMark() {
  return svgEl(
    `<path d="M10 5 Q7.5 5 7.5 8 Q7.5 11 5.5 12 Q7.5 13 7.5 16 Q7.5 19 10 19" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<path d="M14 5 Q16.5 5 16.5 8 Q16.5 11 18.5 12 Q16.5 13 16.5 16 Q16.5 19 14 19" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`
  );
}

// Pi — the π glyph: an overhanging top bar and two lightly-splayed legs.
function piMark() {
  return svgEl(
    `<path d="M5.5 8.6 H18.5" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>` +
    `<path d="M9 8.6 Q8 13 7.6 17.6" stroke="currentColor" stroke-width="1.9" fill="none" stroke-linecap="round"/>` +
    `<path d="M15 8.6 Q16 13 16.4 17.6" stroke="currentColor" stroke-width="1.9" fill="none" stroke-linecap="round"/>`
  );
}

const DEFAULT_ID = "claude-code";
const PROVIDERS = {
  "claude-code": { id: "claude-code", label: "Claude",   cls: "pv-claude-code", terms: "claude", mark: claudeMark },
  "antigravity": { id: "antigravity", label: "Antigravity", cls: "pv-antigravity", terms: "antigravity agy", mark: antigravityMark },
  "codex":       { id: "codex",       label: "Codex",    cls: "pv-codex",       terms: "codex",  mark: codexMark },
  "gemini":      { id: "gemini",      label: "Gemini",   cls: "pv-gemini",      terms: "gemini google", mark: geminiMark },
  "opencode":    { id: "opencode",    label: "OpenCode", cls: "pv-opencode",    terms: "opencode oc", mark: opencodeMark },
  "pi":          { id: "pi",          label: "Pi",       cls: "pv-pi",          terms: "pi", mark: piMark },
  "shell":       { id: "shell",       label: "Shell",    cls: "pv-shell",       terms: "shell terminal sh", mark: shellMark },
};

// Ordered for the new-session picker — default first, AI agents grouped, plain shell last.
export const PROVIDER_LIST = [PROVIDERS["claude-code"], PROVIDERS["antigravity"], PROVIDERS["codex"], PROVIDERS["gemini"], PROVIDERS["opencode"], PROVIDERS["pi"], PROVIDERS["shell"]];
export const DEFAULT_PROVIDER = DEFAULT_ID;

// Always resolves — a missing/unknown id falls back to claude-code (graceful vs a
// committed engine that omits provider). Callers never get undefined.
export function providerOf(id) { return PROVIDERS[id] || PROVIDERS[DEFAULT_ID]; }

// A neutral terminal glyph for custom commands whose icon isn't a provider mark (v1 rendered img/char icons).
const TERMINAL_GLYPH =
  `<rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" stroke-width="1.7"/>` +
  `<path d="M7 9.5l3 2.5-3 2.5M12.5 15H16.5" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
function terminalMark() { return svgEl(TERMINAL_GLYPH); }
function emojiMark(ch) { const s = document.createElement("span"); s.className = "pv-emoji"; s.textContent = ch; return s; }

// A custom command's face: a provider-id icon → that provider's mark/tint; 'terminal' (or unknown) → the glyph;
// any other short string → the emoji/char itself. `sig` folds the icon so a config recolor re-renders the avatar.
function commandFace(cmd) {
  const label = cmd.label || "Custom";
  const terms = (label + " " + (cmd.command || "") + " custom").toLowerCase();
  const icon = cmd.icon;
  const base = { id: cmd.command || cmd.id, label, terms, sig: "cmd:" + cmd.id + ":" + (icon || "terminal") };
  if (icon && PROVIDERS[icon]) return { ...base, cls: PROVIDERS[icon].cls, mark: PROVIDERS[icon].mark };
  if (icon && icon !== "terminal") return { ...base, cls: "pv-custom", mark: () => emojiMark(icon) };
  return { ...base, cls: "pv-custom", mark: terminalMark };
}

// A session's display face {id,label,cls,terms,mark,sig}. A session spawned from a custom command (its snapshot
// carries commandId + label) resolves to that command's icon (§A); until config.commands has loaded (or if the
// command was deleted) it falls back to a neutral terminal glyph + the snapshot label. Built-ins resolve by
// provider id. `sig` lets callers cheaply detect when a session's avatar needs rebuilding.
export function sessionFace(s) {
  if (s && s.commandId) {
    const cmd = store.commands.find((c) => c.id === s.commandId);
    if (cmd) return commandFace(cmd);
    const label = s.commandLabel || "Custom";
    return { id: "custom", label, cls: "pv-custom", terms: (label + " custom").toLowerCase(), mark: terminalMark, sig: "cmd:pending:" + s.commandId };
  }
  const p = providerOf(s ? s.provider : DEFAULT_ID);
  return { id: p.id, label: p.label, cls: p.cls, terms: p.terms, mark: p.mark, sig: "p:" + p.id };
}
