// Resizable sidebar (E1): a drag handle on the sidebar/terminal divider sets the --sidebar-w CSS var, clamped
// to [MIN, MAX]; double-click resets to DEFAULT; the width persists in localStorage['clideck.sidebarW'] (the
// same client-pref pattern as the theme). A tiny inline <head> script pre-stamps the saved width before first
// paint (no resize flash); this module owns the drag interaction and re-affirms that stamp. The terminal's own
// ResizeObserver refits xterm as .main reflows, so there's nothing to notify here.
const KEY = "clideck.sidebarW";
export const SIDEBAR_DEFAULT = 340, SIDEBAR_MIN = 240, SIDEBAR_MAX = 560;

const clamp = (px) => Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(px)));
let cur = SIDEBAR_DEFAULT;
function applyWidth(px) { cur = clamp(px); document.documentElement.style.setProperty("--sidebar-w", cur + "px"); }

export function sidebarWidth() { const v = read(); return v == null ? SIDEBAR_DEFAULT : clamp(v); }

export function initSidebarResize() {
  const handle = document.getElementById("resize-handle");
  if (!handle) return;
  applyWidth(sidebarWidth());   // re-affirm the head pre-stamp (and normalize a stale/out-of-range value)
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "vertical");
  handle.title = "Drag to resize · double-click to reset";

  let dragging = false;
  const onMove = (e) => { if (dragging) { applyWidth(e.clientX); e.preventDefault(); } };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("resizing");
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    write(cur);
  };
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    dragging = true;
    document.body.classList.add("resizing");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    e.preventDefault();
  });
  handle.addEventListener("dblclick", () => { applyWidth(SIDEBAR_DEFAULT); write(SIDEBAR_DEFAULT); });
}

function read() { try { const v = parseInt(localStorage.getItem(KEY), 10); return Number.isFinite(v) ? v : null; } catch { return null; } }
function write(px) { try { localStorage.setItem(KEY, String(clamp(px))); } catch {} }
