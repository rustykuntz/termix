// Premium toast system (v2 parity for v1 toast.js). Bottom-right stack of tinted cards, four types
// keyed to the v2 palette (coral / sage / amber / rose — native to v2, not v1's colors). Auto-dismiss
// with a progress bar that PAUSES on hover; duration:0 → sticky with a Dismiss footer; same-id replace
// swaps a card in place; title, markdown-lite body, and custom iconHtml. Lazy container; each call
// returns a { dismiss } handle. Beats v1's flat 0.3s fade+slide with a slide+scale entrance, a tinted
// icon chip, a hover-pausable countdown bar, and a smooth height-collapse on exit so the stack reflows.
import { esc } from "../util.js";

const DEFAULT_MS = 3000;
const TYPES = new Set(["info", "success", "warn", "error"]);
const SVG = 'width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
const ICONS = {
  info:    `<svg ${SVG}><circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16"/><line x1="12" y1="8" x2="12" y2="8"/></svg>`,
  success: `<svg ${SVG}><circle cx="12" cy="12" r="9"/><path d="M8 12.4l2.6 2.6L16 9.4"/></svg>`,
  warn:    `<svg ${SVG}><path d="M12 3.2L21.3 19.5a1 1 0 0 1-.87 1.5H3.57a1 1 0 0 1-.87-1.5z"/><line x1="12" y1="9.5" x2="12" y2="14"/><line x1="12" y1="17.3" x2="12" y2="17.3"/></svg>`,
  error:   `<svg ${SVG}><circle cx="12" cy="12" r="9"/><line x1="12" y1="7.5" x2="12" y2="12.5"/><line x1="12" y1="16" x2="12" y2="16"/></svg>`,
};
const X_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

let container = null;
function host() {
  if (container && document.body.contains(container)) return container;
  container = document.createElement("div");
  container.className = "toaster";
  container.setAttribute("aria-live", "polite");
  document.body.appendChild(container);
  return container;
}

// markdown-lite (v1 utils.js:21-28): escapes first, then **bold**, `code`, -/• bullet runs, newlines→<br>.
function miniMarkdown(src) {
  const inline = (t) => esc(t)
    .replace(/`([^`]+)`/g, (_m, c) => "<code>" + c + "</code>")
    .replace(/\*\*([^*]+)\*\*/g, (_m, b) => "<strong>" + b + "</strong>");
  const out = [];
  let bullets = null;
  for (const line of String(src == null ? "" : src).split("\n")) {
    const m = line.match(/^\s*[-•]\s+(.*)$/);
    if (m) { (bullets || (bullets = [])).push("<li>" + inline(m[1]) + "</li>"); continue; }
    if (bullets) { out.push("<ul>" + bullets.join("") + "</ul>"); bullets = null; }
    out.push(inline(line));
  }
  if (bullets) out.push("<ul>" + bullets.join("") + "</ul>");
  return out.join("<br>").replace(/<br>(<ul>)/g, "$1").replace(/(<\/ul>)<br>/g, "$1");
}

function renderBody(opts) {
  if (opts.html) return String(opts.body == null ? "" : opts.body);
  if (opts.markdown) return miniMarkdown(opts.body);
  return esc(opts.body == null ? "" : opts.body).replace(/\n/g, "<br>");
}

// Smooth exit: fix the height, drop `.in` (fade + slide-right), then collapse height/margin/padding to 0
// so the toasts below slide up. Node removed once the 300ms transition is done.
function collapse(el) {
  el.style.height = el.offsetHeight + "px";
  void el.offsetHeight;                                   // force reflow so the height sticks before collapsing
  el.classList.remove("in");
  el.style.height = "0";
  el.style.marginBottom = "0";
  el.style.paddingTop = "0";
  el.style.paddingBottom = "0";
  setTimeout(() => el.remove(), 300);
}

function mk(tag, cls, html) { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; }

function showToast(opts = {}) {
  if (typeof opts === "string") opts = { body: opts };
  const type = TYPES.has(opts.type) ? opts.type : "info";
  const duration = opts.duration == null ? DEFAULT_MS : Number(opts.duration);
  const sticky = !(duration > 0);                          // duration:0 (or negative/NaN) → no auto-dismiss
  const c = host();

  const el = mk("div", "toast t-" + type);
  el.setAttribute("role", type === "error" ? "alert" : "status");
  if (opts.id) el.id = "toast-" + opts.id;
  el.style.setProperty("--tdur", Math.max(0, duration) + "ms");

  // The JS timer is authoritative for dismissal (reduced-motion safe); the CSS bar is purely visual and
  // pauses via :hover. Hover pauses BOTH — clear the timer, bank the remaining ms, re-arm on leave.
  let closing = false, timer = null, remaining = duration, startAt = 0;
  const arm = () => { if (sticky || closing) return; startAt = Date.now(); timer = setTimeout(dismiss, Math.max(0, remaining)); };
  const hold = () => { if (sticky || closing || timer == null) return; clearTimeout(timer); timer = null; remaining -= Date.now() - startAt; };
  function dismiss() { if (closing) return; closing = true; if (timer) clearTimeout(timer); collapse(el); }

  const col = mk("div", "toast-c");
  if (opts.title) { const t = mk("div", "toast-t"); t.textContent = opts.title; col.appendChild(t); }
  col.appendChild(mk("div", "toast-b", renderBody(opts)));
  if (sticky) {
    const act = mk("button", "toast-act"); act.type = "button"; act.textContent = "Dismiss";
    act.addEventListener("click", dismiss); col.appendChild(act);
  }
  el.appendChild(mk("span", "toast-ic", opts.iconHtml || ICONS[type]));
  el.appendChild(col);
  if (!sticky) {
    const x = mk("button", "toast-x", X_ICON); x.type = "button"; x.setAttribute("aria-label", "Dismiss");
    x.addEventListener("click", dismiss); el.appendChild(x);
    el.appendChild(mk("span", "toast-bar"));
  }

  // same-id replace channel: a new toast with the same id swaps into the old one's slot in place.
  const prev = el.id ? document.getElementById(el.id) : null;
  if (prev) prev.replaceWith(el); else c.appendChild(el);

  // Optional whole-toast action (e.g. "switch to that session"): clicking the body runs it then dismisses;
  // the Dismiss/× controls keep their own handlers (guarded out here).
  if (typeof opts.onClick === "function") {
    el.classList.add("toast-clickable");
    el.addEventListener("click", (e) => { if (e.target.closest(".toast-x,.toast-act")) return; opts.onClick(); dismiss(); });
  }

  el.addEventListener("mouseenter", hold);
  el.addEventListener("mouseleave", arm);

  requestAnimationFrame(() => { el.classList.add("in"); arm(); });   // enter, then start the clock
  return { dismiss };
}

const norm = (o, type) => (typeof o === "string" ? { body: o, type } : { ...o, type });
export const toast = Object.assign(showToast, {
  info: (o) => showToast(norm(o, "info")),
  success: (o) => showToast(norm(o, "success")),
  warn: (o) => showToast(norm(o, "warn")),
  error: (o) => showToast(norm(o, "error")),
});
