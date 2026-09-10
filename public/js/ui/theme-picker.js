// Terminal theme picker — a modal of live mini-preview cards, grouped Dark / Light. Picking a theme stores a
// per-session override (config.sessionThemes) and re-colours the live terminal instantly; a polarity chip +
// footer Restart handle the color-mode escape hatch, and the footer can promote a theme to the mode default.
import { store } from "../store.js";
import { esc } from "../util.js";
import { resolvedTheme } from "../theme.js";
import { allThemes, getTheme, appliedThemeId, defaultThemeId, isPolarityFlip, setSessionTheme, setDefaultTheme, restartWithTheme } from "../terminal-themes.js";

let overlay = null, els = null, offConfig = null, sid = null;

function node(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }

export function openThemePicker(sessionId) {
  if (overlay) { close(); return; }
  sid = sessionId;
  build();
  document.addEventListener("keydown", onKey, true);
  offConfig = store.on("config", render);   // optimistic apply / another client's change → re-render highlight
  render();
  requestAnimationFrame(() => { if (overlay) overlay.classList.add("show"); });
}

function build() {
  overlay = node("div", "tp-overlay");
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  const modal = node("div", "tp-modal");
  const head = node("div", "tp-head");
  const s = store.sessions.get(sid);
  const title = node("div", "tp-title", "Terminal theme");
  const sub = node("div", "tp-sub", s ? (s.name || "this session") : "this session");
  const titleWrap = node("div", "tp-titlewrap"); titleWrap.append(title, sub);
  const x = node("button", "tp-x"); x.type = "button"; x.setAttribute("aria-label", "Close");
  x.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  x.addEventListener("click", close);
  head.append(titleWrap, x);
  const body = node("div", "tp-body");
  const footer = node("div", "tp-foot");
  modal.append(head, body, footer);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  els = { modal, body, footer };
}

// One live mini-terminal — a colorized mock session on the theme's own background (v1 terminals.js:538, richened).
// Exported so the Settings › Appearance panel renders the same treatment for the per-mode default themes.
export function previewHtml(c) {
  const sp = (col, t) => '<span style="color:' + col + '">' + t + "</span>";
  const line = (h) => '<div class="tp-line">' + h + "</div>";
  return (
    line(sp(c.green, "➜") + " " + sp(c.blue, "~/src") + " " + sp(c.foreground, "git status")) +
    line(sp(c.brightBlack, "On branch ") + sp(c.magenta, "main")) +
    line(sp(c.yellow, "modified:") + " " + sp(c.foreground, "app.ts") + "  " + sp(c.cyan, "utils.ts")) +
    line(sp(c.green, "✓ 2 pass") + "  " + sp(c.red, "✗ 1 fail")) +
    line(sp(c.green, "➜") + " " + sp(c.blue, "~/src") + ' <span class="tp-cursor" style="background:' + c.cursor + '"></span>')
  );
}

function card(t, appliedId) {
  const cur = t.id === appliedId;
  const flip = !cur && isPolarityFlip(sid, t.id);
  const el = node("button", "tp-card" + (cur ? " sel" : ""));
  el.type = "button";
  el.style.setProperty("--tp-accent", t.accent);
  el.innerHTML =
    '<div class="tp-preview" style="background:' + t.theme.background + ';color:' + t.theme.foreground + '">' + previewHtml(t.theme) + "</div>" +
    '<div class="tp-meta"><span class="tp-name">' + esc(t.name) + "</span>" +
    (cur ? '<span class="tp-cur-badge">current</span>' : (flip ? '<span class="tp-flip" title="This theme flips light/dark vs the running agent — restart to apply">↻</span>' : "")) +
    "</div>";
  el.addEventListener("click", () => setSessionTheme(sid, t.id));   // config emit → live re-colour + re-render
  return el;
}

function section(title, list, appliedId) {
  const sec = node("div", "tp-section");
  sec.appendChild(node("div", "tp-secthead", title));
  const grid = node("div", "tp-grid");
  for (const t of list) grid.appendChild(card(t, appliedId));
  sec.appendChild(grid);
  return sec;
}

function render() {
  if (!els) return;
  const themes = allThemes();
  const appliedId = appliedThemeId(sid);
  els.body.replaceChildren(
    section("Dark", themes.filter((t) => t.mode === "dark"), appliedId),
    section("Light", themes.filter((t) => t.mode === "light"), appliedId),
  );
  renderFooter(appliedId);
}

function renderFooter(appliedId) {
  const s = store.sessions.get(sid);
  const applied = getTheme(appliedId);
  const appMode = resolvedTheme();
  els.footer.replaceChildren();
  const status = node("div", "tp-statusline");
  status.innerHTML = "New <b>" + appMode + "</b>-mode sessions use <b>" + esc(getTheme(defaultThemeId(appMode)).name) + "</b>";
  els.footer.append(status, node("div", "tp-spacer"));
  if (s && s.live !== false && isPolarityFlip(sid, appliedId)) {
    const rb = node("button", "tp-restart", "↻ Restart to apply color mode"); rb.type = "button";
    rb.title = "This theme's light/dark polarity differs from the running agent";
    rb.addEventListener("click", () => { restartWithTheme(sid); close(); });
    els.footer.appendChild(rb);
  }
  const setDef = node("button", "tp-setdefault", "Set " + applied.mode + " default"); setDef.type = "button";
  setDef.title = 'Make "' + applied.name + '" the default for ' + applied.mode + "-mode sessions";
  setDef.disabled = defaultThemeId(applied.mode) === applied.id;
  setDef.addEventListener("click", () => setDefaultTheme(applied.mode, applied.id));
  const done = node("button", "tp-done", "Done"); done.type = "button";
  done.addEventListener("click", close);
  els.footer.append(setDef, done);
}

function onKey(e) { if (e.key === "Escape") close(); }

function close() {
  if (!overlay) return;
  document.removeEventListener("keydown", onKey, true);
  if (offConfig) { offConfig(); offConfig = null; }
  const ov = overlay;
  overlay = null; els = null; sid = null;
  ov.classList.remove("show");
  setTimeout(() => ov.remove(), 180);
}
