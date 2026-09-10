// Directory picker (v1 folder-picker.js). A centered modal: optimistic path line + spinner so navigation
// feels instant, subdir listing with a root-aware '..' row, a session-local hidden-folders toggle, an
// inline new-folder row, and keyboard nav. dirs.list/dirs.mkdir are requester-only; the engine echoes the
// requested `path`, which we use as a STALE-RESPONSE GUARD — replies for a path we've navigated away from
// (or after close) are dropped. Returns the chosen path to the caller via onSelect.
import { store } from "../store.js";
import { listDir, makeDir } from "../ws.js";
import { h } from "../util.js";

const FOLDER = '<svg class="fp-ic" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const UP = '<svg class="fp-ic" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V6M5 12l7-7 7 7"/></svg>';
const EYE = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>';
const CHECK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
const XI = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

// path helpers — POSIX + Windows aware (v1 handled both)
function isRoot(p) { return p === "/" || /^[A-Za-z]:[\\/]?$/.test(p); }
function join(base, name) {
  const sep = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  return base.replace(/[\\/]+$/, "") + sep + name;
}
function parentOf(p) {
  if (isRoot(p)) return p;
  const s = p.replace(/[\\/]+$/, "");
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  if (i <= 0) return "/";
  if (/^[A-Za-z]:$/.test(s.slice(0, i))) return s.slice(0, i + 1);   // C:\foo → C:\
  return s.slice(0, i);
}

let overlay = null, els = null;
let onSelectCb = null, onCloseCb = null, offList = null, offMkdir = null;
let currentPath = null, lastRequested = null, newRow = null, mkErrT = null;
let showHidden = false;             // session-local (v1: module-level, not persisted)
let lastBrowsed = null;             // remembered across opens this session

export function openFolderPicker(startPath, onSelect, onClose) {
  if (overlay) close();
  onSelectCb = onSelect || null; onCloseCb = onClose || null;
  build();
  offList = store.on("dirs:list", onList);
  offMkdir = store.on("dirs:mkdir", onMkdir);
  document.addEventListener("keydown", onKey, true);
  navigate(startPath || lastBrowsed || "/");
  document.body.classList.add("cd-modal-open");   // a menu.js popover that spawned us (Browse) stays open behind us
  requestAnimationFrame(() => overlay.classList.add("show"));
}

function build() {
  overlay = h("div", "fp-overlay");
  const modal = h("div", "fp-modal");
  const head = h("div", "fp-head");
  const title = h("div", "fp-title", "Choose a folder");
  const x = h("button", "fp-x", XI); x.type = "button"; x.title = "Close"; x.onclick = close;
  head.append(title, x);
  const path = h("div", "fp-path");
  const toolbar = h("div", "fp-toolbar");
  const hidden = h("button", "fp-hidden", EYE); hidden.type = "button"; hidden.title = "Show hidden folders"; hidden.onclick = toggleHidden;
  const newBtn = h("button", "fp-newbtn", FOLDER + "<span>New folder</span>"); newBtn.type = "button"; newBtn.onclick = openNewFolder;
  toolbar.append(hidden, newBtn);
  const listing = h("div", "fp-listing");
  const foot = h("div", "fp-foot");
  const cancel = h("button", "fp-cancel", "Cancel"); cancel.type = "button"; cancel.onclick = close;
  const select = h("button", "fp-select", "Select folder"); select.type = "button"; select.onclick = doSelect;
  foot.append(cancel, select);
  modal.append(head, path, toolbar, listing, foot);
  overlay.append(modal);
  // backdrop click closes; stopPropagation so the click never reaches a caller's outside-click handler
  overlay.addEventListener("mousedown", (e) => { e.stopPropagation(); if (e.target === overlay) close(); });
  overlay.addEventListener("click", (e) => e.stopPropagation());
  document.body.appendChild(overlay);
  els = { path, listing, hidden, select };
}

function navigate(path) {
  lastRequested = path;
  els.path.textContent = path; els.path.title = path;     // optimistic — canonical resolvedPath lands with the reply
  closeNewFolder();
  els.select.disabled = true;
  els.listing.replaceChildren(h("div", "fp-loading", '<span class="fp-spin"></span>Loading…'));
  listDir(path, showHidden);
}

function onList(res) {
  if (!overlay || res.path !== lastRequested) return;     // STALE-RESPONSE GUARD (closed, or navigated away)
  if (!res.success) { els.listing.replaceChildren(h("div", "fp-error", res.error || "Couldn't read this folder.")); return; }
  currentPath = res.resolvedPath || res.path;
  lastBrowsed = currentPath;
  els.path.textContent = currentPath; els.path.title = currentPath;
  renderEntries(res.entries || []);
  els.select.disabled = false;
}

function renderEntries(entries) {
  const list = els.listing;
  list.replaceChildren();
  const atRoot = isRoot(currentPath);
  if (!atRoot) list.appendChild(rowEl("..", parentOf(currentPath), true, false));
  if (!entries.length && atRoot) { list.appendChild(h("div", "fp-empty", "Empty directory")); return; }
  for (const e of entries) list.appendChild(rowEl(e.name, join(currentPath, e.name), false, e.hidden));
  const first = list.querySelector(".fp-row"); if (first) first.tabIndex = 0;
}

function rowEl(label, path, isParent, hidden) {
  const b = h("button", "fp-row" + (hidden ? " hidden" : "") + (isParent ? " parent" : ""));
  b.type = "button"; b.tabIndex = -1;
  b.append(h("span", "fp-rowic", isParent ? UP : FOLDER));
  const name = h("span", "fp-name"); name.textContent = label; b.append(name);
  b.onclick = () => navigate(path);
  return b;
}

function toggleHidden() {
  showHidden = !showHidden;
  els.hidden.classList.toggle("on", showHidden);
  els.hidden.title = showHidden ? "Hide hidden folders" : "Show hidden folders";
  if (currentPath) navigate(currentPath);
}

// ── inline new folder ──
function openNewFolder() {
  if (newRow || !currentPath) return;
  newRow = h("div", "fp-newrow");
  newRow.append(h("span", "fp-rowic", FOLDER));
  const input = h("input", "fp-newinput"); input.placeholder = "Folder name"; input.spellcheck = false; input.autocomplete = "off"; input.maxLength = 80;
  const ok = h("button", "fp-newok", CHECK); ok.type = "button"; ok.title = "Create";
  const cx = h("button", "fp-newcancel", XI); cx.type = "button"; cx.title = "Cancel";
  newRow.append(input, ok, cx);
  els.listing.prepend(newRow);
  input.focus();
  const submit = () => { const name = input.value.trim(); if (!name) { closeNewFolder(); return; } input.disabled = true; makeDir(currentPath, name); };
  ok.onclick = submit; cx.onclick = closeNewFolder;
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); submit(); }
    else if (e.key === "Escape") { e.preventDefault(); closeNewFolder(); }
  });
}
function closeNewFolder() { if (newRow) { newRow.remove(); newRow = null; } }

function onMkdir(res) {
  if (!overlay) return;
  if (res.success) { closeNewFolder(); navigate(res.path); return; }   // success → navigate into the new folder
  const input = newRow && newRow.querySelector(".fp-newinput"); if (input) input.disabled = false;
  clearTimeout(mkErrT);
  let err = els.listing.querySelector(".fp-mkerr");
  if (!err) { err = h("div", "fp-mkerr"); els.listing.prepend(err); }
  err.textContent = res.error || "Failed to create folder.";
  mkErrT = setTimeout(() => { const e = els.listing.querySelector(".fp-mkerr"); if (e) e.remove(); }, 3000);
}

function onKey(e) {
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    const rows = [...els.listing.querySelectorAll(".fp-row")];
    if (!rows.length) return;
    e.preventDefault();
    const i = rows.indexOf(document.activeElement);
    const n = e.key === "ArrowDown" ? Math.min((i < 0 ? -1 : i) + 1, rows.length - 1) : Math.max(i - 1, 0);
    rows.forEach((r) => (r.tabIndex = -1)); rows[n].tabIndex = 0; rows[n].focus();
  }
}

function doSelect() {
  if (!currentPath) return;
  const cb = onSelectCb, path = currentPath;
  close();
  cb && cb(path);
}
function close() {
  if (!overlay) return;
  document.removeEventListener("keydown", onKey, true);
  if (offList) offList(); if (offMkdir) offMkdir(); offList = offMkdir = null;
  clearTimeout(mkErrT);
  const node = overlay;
  overlay = null; els = null; newRow = null;
  currentPath = null; lastRequested = null;
  node.classList.remove("show");                                  // animate out to match the other modals
  setTimeout(() => { node.remove(); if (!overlay) document.body.classList.remove("cd-modal-open"); }, 180);
  const cb = onCloseCb; onSelectCb = onCloseCb = null;
  cb && cb();
}
