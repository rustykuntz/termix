// Small shared helpers. No deps.

export function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

export function firstLine(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

export function shortId(id) {
  return String(id || "").slice(0, 6);
}

export const SESSION_NAME_MAX = 25;
export function limitSessionName(name) {
  return String(name || "").slice(0, SESSION_NAME_MAX);
}

const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR, WEEK = 7 * DAY, MONTH = 30 * DAY, YEAR = 365 * DAY;
// ONE ladder, two renderings. FLOOR, never round: at 59.6 minutes "60 minutes ago" is both wrong and a unit
// the next rung owns. max(1) keeps the first rung honest, since 45s floors to zero.
function rung(ts) {
  const d = Date.now() - ts;
  if (d < 45000) return null;                                        // "now"
  if (d < HOUR)  return [Math.max(1, Math.floor(d / MIN)),   "minute", "m"];
  if (d < DAY)   return [Math.max(1, Math.floor(d / HOUR)),  "hour",   "h"];
  if (d < WEEK)  return [Math.max(1, Math.floor(d / DAY)),   "day",    "d"];
  if (d < MONTH) return [Math.max(1, Math.floor(d / WEEK)),  "week",   "w"];
  if (d < YEAR)  return [Math.max(1, Math.floor(d / MONTH)), "month",  "mo"];
  return [Math.max(1, Math.floor(d / YEAR)), "year", "y"];
}

// Prose — for a slot with room to spend. The dormant row's is one, because the Resume button beneath it
// already sets that column's width, so the words are free there.
export function relTime(ts) {
  if (!ts) return "";
  const r = rung(ts);
  return r ? r[0] + " " + r[1] + (r[0] === 1 ? "" : "s") + " ago" : "now";
}

// Compact — SAME ladder, for the live row, whose time column shares one lane with the session name.
// Measured: "30 minutes ago" is 81px and drops the name lane to 148px, truncating a 24-character name;
// "30m" costs ~24px and leaves it whole. Both climb through weeks/months/years, which is what the old
// formatter never did — it said "45d" forever.
export function relTimeShort(ts) {
  if (!ts) return "";
  const r = rung(ts);
  return r ? r[0] + r[2] : "now";
}

// terse element builder
export function h(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}

export function debounce(fn, ms) {
  let t = null;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// Copy text to the clipboard. Localhost is a secure context so the async API works;
// fall back to a hidden textarea for anything that lacks it. Resolves to success bool.
export async function copyText(text) {
  const s = String(text == null ? "" : text);
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(s); return true; }
  } catch {}
  try {
    const ta = document.createElement("textarea");
    ta.value = s; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand("copy"); ta.remove(); return ok;
  } catch { return false; }
}

// Inline name-edit, shared by the terminal header and the sidebar row so both behave identically
// (v1 terminals.js:1055-1120). Swaps `host`'s content for an input; Enter commits (if valid),
// Escape cancels, blur commits, EMPTY reverts (never clears). Live-validates via opts.validate(name)
// → error string | null (duplicate check); while invalid the commit is blocked and opts.showError(msg)
// paints the caller's chosen error slot. opts.initialError forces an error until the first edit (used
// to re-surface an engine renameRejected). Returns { end } to discard the edit externally.
export function inlineRename(host, opts = {}) {
  const input = document.createElement("input");
  input.className = "name-input"; input.value = opts.value || ""; input.maxLength = opts.maxLength || 60;
  input.placeholder = opts.placeholder || "Name"; input.spellcheck = false; input.autocomplete = "off";
  host.replaceChildren(input);
  let done = false, forced = opts.initialError || null;
  const err = () => { const n = input.value.trim(); return (n && opts.validate ? opts.validate(n) : null) || forced; };
  const paint = () => { const m = err(); input.classList.toggle("invalid", !!m); if (opts.showError) opts.showError(m); return m; };
  const finish = (cb) => {
    if (done) return; done = true;
    input.removeEventListener("blur", onBlur);
    if (opts.showError) opts.showError(null);
    if (cb) cb();
    if (opts.onEnd) opts.onEnd();
  };
  const commit = (fromBlur) => {
    const name = input.value.trim();
    if (!name) { finish(opts.onCancel); return; }              // empty reverts
    if (paint()) { if (fromBlur) input.focus(); return; }      // invalid: stay in edit mode
    finish(() => opts.onCommit && opts.onCommit(name));
  };
  const onBlur = () => commit(true);
  input.addEventListener("input", () => { forced = null; paint(); });
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); commit(false); }
    else if (e.key === "Escape") { e.preventDefault(); finish(opts.onCancel); }
  });
  input.addEventListener("blur", onBlur);
  // ⚠️ A CLICK INSIDE THE FIELD IS NOT A CLICK ON THE SURFACE BEHIND IT. The editor is dropped INTO the thing
  // it renames — a session row, a project header, the terminal title — and every one of those acts on a click.
  // The row selects, which refocuses the terminal, which blurs the input, and blur COMMITS: pressing the
  // pencil and then clicking to place the caret ended the edit and saved it. Every other control on those
  // surfaces already suppresses this; the field the helper installs has to as well.
  const shield = (e) => e.stopPropagation();
  input.addEventListener("mousedown", shield);
  input.addEventListener("click", shield);
  input.addEventListener("dblclick", shield);
  if (opts.onStart) opts.onStart();
  input.focus(); input.select(); paint();
  return { end: () => finish(opts.onCancel) };
}

// The 8-colour project palette (v1 app.js:768) — round-robin at create time by `projects.length % 8`.
export const PROJECT_COLORS = ["#3b82f6", "#8b5cf6", "#ec4899", "#f59e0b", "#10b981", "#ef4444", "#06b6d4", "#84cc16"];

// A session's /ask address — exactly what the engine resolves [project-scope.js sessionAddress].
// Explicit projects use their name; ad-hoc sessions use their cwd-group name.
export function askAddress(session, projects) {
  const name = (session && session.name) || (session && session.id) || "";
  const pid = session && session.projectId;
  const proj = pid && (projects || []).find((p) => p.id === pid);
  const scope = pid ? ((proj && proj.name) || pid) : basename(session && session.cwd);
  return scope && scope !== "/" ? "@" + scope + "/" + name : name;
}

// A project is just a cwd. basename() is its short label; "/" for root/empty.
export function basename(p) {
  const s = String(p == null ? "" : p).replace(/\/+$/, "");
  if (s === "") return "/";
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

// Map each distinct cwd -> display label. Basename normally; when two distinct cwds
// share a basename, disambiguate that one with its parent segment (e.g. a/web vs b/web).
export function projectLabels(cwds) {
  const base = new Map(), counts = new Map();
  for (const c of cwds) { const b = basename(c); base.set(c, b); counts.set(b, (counts.get(b) || 0) + 1); }
  const out = new Map();
  for (const c of cwds) {
    const b = base.get(c);
    if (counts.get(b) > 1) {
      const s = String(c == null ? "" : c).replace(/\/+$/, "");
      const i = s.lastIndexOf("/");
      const parent = i > 0 ? basename(s.slice(0, i)) : (i === 0 ? "/" : "");
      out.set(c, parent && parent !== "/" ? parent + "/" + b : b);
    } else out.set(c, b);
  }
  return out;
}
