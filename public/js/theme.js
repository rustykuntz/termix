// Theme: a 3-way preference — auto | light | dark — persisted in localStorage['clideck.theme'].
// 'auto' resolves via prefers-color-scheme and follows OS changes live. The resolved concrete
// theme ('light'|'dark') is stamped on <html data-theme>. Dark is the CSS base, so auto on a
// dark OS renders identically to the original — no light override applies.
//
// A tiny inline script in index.html <head> pre-stamps data-theme before first paint (no FOUC);
// this module re-affirms that stamp and owns the runtime switch + the xterm subscribers.

const KEY = "clideck.theme";
const ORDER = ["auto", "light", "dark"];
const GLYPH = { auto: "◐", light: "☀", dark: "☾" };
const LABEL = { auto: "Auto (follows system)", light: "Light", dark: "Dark" };
const mq = window.matchMedia("(prefers-color-scheme: dark)");
const subs = new Set();       // fn(resolved) — notified on every resolved-theme change
const prefSubs = new Set();   // fn(pref) — notified on every preference change (auto|light|dark) for chrome in sync

export const THEME_PREFS = ORDER;      // ['auto','light','dark'] — for a settings segmented control
export const THEME_LABELS = LABEL;
export const THEME_GLYPHS = GLYPH;

export function themePref() {
  const v = read();
  return ORDER.includes(v) ? v : "auto";
}
export function resolvedTheme() {
  const p = themePref();
  return p === "auto" ? (mq.matches ? "dark" : "light") : p;
}
// Subscribe to resolved-theme changes (e.g. the terminal re-themes its xterm). Returns an unsub.
export function onTheme(fn) { subs.add(fn); return () => subs.delete(fn); }
// Subscribe to preference changes (auto|light|dark) — the footer glyph + Appearance control stay in sync.
export function onThemePref(fn) { prefSubs.add(fn); return () => prefSubs.delete(fn); }
// Set the app-mode preference from anywhere (footer button, Appearance panel) — applies + notifies both channels.
export function setThemePref(p) { write(ORDER.includes(p) ? p : "auto"); apply(); }

function apply() {
  const r = resolvedTheme();
  document.documentElement.setAttribute("data-theme", r);
  for (const fn of subs) fn(r);
  for (const fn of prefSubs) fn(themePref());
}

// OS theme flips only matter while following the system.
mq.addEventListener("change", () => { if (themePref() === "auto") apply(); });

// The one quiet control: cycles auto → light → dark. No coral spent on it.
export function initTheme() {
  const btn = document.getElementById("theme-btn");
  if (btn) {
    const paint = () => { const p = themePref(); btn.textContent = GLYPH[p]; btn.title = "Theme: " + LABEL[p]; btn.setAttribute("aria-label", "Theme: " + LABEL[p]); };
    btn.onclick = () => setThemePref(ORDER[(ORDER.indexOf(themePref()) + 1) % ORDER.length]);
    onThemePref(paint);   // repaint on any pref change (footer button OR the Appearance panel)
    paint();
  }
  apply();   // re-affirm the head pre-stamp + notify subscribers now that they're wired
}

function read() { try { return localStorage.getItem(KEY); } catch { return null; } }
function write(v) { try { localStorage.setItem(KEY, v); } catch {} }
