// Drag & drop for the sidebar (ported from v1 drag.js). Two gestures share one pointer pipeline:
//   • session row  → drop anywhere inside a PROJECT group (move to project)
//   • project head → reorder among the other projects (an insertion line shows the drop slot)
// A 5px threshold separates a drag from a click; pointer-capture keeps the gesture even off-list; a ghost
// follows the pointer; and after a real drag the follow-up click is suppressed so a drop never selects/collapses.
// The store/config drive the actual re-render — drag only fires the intent (setSessionProject / config.update).
import { store } from "../store.js";
import { setSessionProject, updateConfig } from "../ws.js";

const DRAG_THRESHOLD = 5;
let ds = null;              // active drag state (or a pending one below threshold)
let suppressClick = false;  // set on a real drag end → the very next click is swallowed

// The sidebar's row/header click handlers call this first: true (once) right after a drag, so the drop
// doesn't also select the row or toggle the group.
export function wasDragging() {
  if (suppressClick) { suppressClick = false; return true; }
  return false;
}

export function initDrag(listEl) {
  listEl.addEventListener("pointerdown", onDown);
  listEl.addEventListener("pointermove", onMove);
  listEl.addEventListener("pointerup", onUp);
  listEl.addEventListener("pointercancel", onCancel);
}

function onDown(e) {
  if (e.button !== 0) return;
  if (e.target.closest("button") || e.target.closest("input")) return;   // controls never start a drag

  // Project drag — grab by the project header (only when there's another project to reorder against). The
  // whole group dims, but the ghost is just the header so a tall project doesn't drag a giant card around.
  const head = e.target.closest(".project.is-project > .group-head");
  if (head) {
    if (document.querySelectorAll(".project.is-project").length <= 1) return;
    const group = head.closest(".project");
    beginPending("project", group, head, e, { projectId: group.dataset.projectId });
    return;
  }
  // Session drag — grab by the row.
  const row = e.target.closest(".row[data-id]");
  if (row) beginPending("session", row, row, e, { id: row.dataset.id });
}

function beginPending(mode, dragRow, ghostSrc, e, extra) {
  const rect = ghostSrc.getBoundingClientRect();
  ds = { mode, row: dragRow, ghostSrc, startX: e.clientX, startY: e.clientY, offsetY: e.clientY - rect.top,
    ghost: null, active: false, dropTarget: null, pointerId: e.pointerId, ...extra };
}

function onMove(e) {
  if (!ds) return;
  if (!ds.active) {
    if (Math.abs(e.clientX - ds.startX) < DRAG_THRESHOLD && Math.abs(e.clientY - ds.startY) < DRAG_THRESHOLD) return;
    try { ds.row.setPointerCapture(ds.pointerId); } catch {}
    startDrag();
  }
  ds.ghost.style.top = (e.clientY - ds.offsetY) + "px";
  if (ds.mode === "project") updateProjectDropTarget(e.clientY);
  else updateSessionDropTarget(e.clientX, e.clientY);
}

function onUp() {
  if (!ds) return;
  if (ds.active) endDrag();
  ds = null;
}
function onCancel() {
  if (ds && ds.active) cleanup();
  ds = null;
}

function startDrag() {
  ds.active = true;
  ds.row.classList.add("dragging");
  const r = ds.ghostSrc.getBoundingClientRect();
  const ghost = ds.ghostSrc.cloneNode(true);
  ghost.classList.add("drag-ghost"); ghost.classList.remove("dragging");
  ghost.style.top = (ds.startY - ds.offsetY) + "px";
  ghost.style.left = r.left + "px";
  ghost.style.width = r.width + "px";
  document.body.appendChild(ghost);
  ds.ghost = ghost;
  if (ds.mode === "session") document.querySelectorAll(".project.is-project > .group-head").forEach((h) => h.classList.add("drop-target"));   // NOT 'drop-zone' — that's the file-drop veil (inset:0/opacity:0) and would make the headers vanish
}

// The whole project group is a drop target, while the compact header carries the visual highlight.
// Dropping outside an explicit project is a no-op: a drag must never silently manufacture a cwd group.
function updateSessionDropTarget(x, y) {
  document.querySelectorAll(".drop-highlight").forEach((el) => el.classList.remove("drop-highlight"));
  ds.dropTarget = null;
  for (const group of document.querySelectorAll(".project.is-project")) {
    const rect = group.getBoundingClientRect();
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
      const head = group.querySelector(":scope > .group-head");
      head.classList.add("drop-highlight");
      ds.dropTarget = { type: "project", projectId: group.dataset.projectId };
      return;
    }
  }
}

// A project drops between other projects — the insertion line marks the slot (skips the two no-op slots).
function updateProjectDropTarget(y) {
  clearDropLine();
  ds.dropTarget = null;
  const groups = [...document.querySelectorAll(".project.is-project")];
  const dragIdx = groups.indexOf(ds.row);
  for (let i = 0; i <= groups.length; i++) {
    const prev = i > 0 ? groups[i - 1].getBoundingClientRect().bottom : -Infinity;
    const next = i < groups.length ? groups[i].getBoundingClientRect().top : Infinity;
    if (y >= prev && y < next) {
      if (i === dragIdx || i === dragIdx + 1) return;   // dropping back where it already is
      ds.dropTarget = { type: "reorder", insertBefore: i };
      const line = document.createElement("div");
      line.className = "project-drop-line";
      const ref = groups[i] || null;
      if (ref) ref.parentNode.insertBefore(line, ref);
      else groups[groups.length - 1].after(line);
      return;
    }
  }
}

function endDrag() {
  const target = ds.dropTarget;
  suppressClick = true;
  cleanup();
  if (!target) return;
  if (ds.mode === "session") {
    const s = store.sessions.get(ds.id);
    if (!s) return;
    if (target.type === "project" && s.projectId !== target.projectId) setSessionProject(ds.id, target.projectId);
  } else if (ds.mode === "project" && target.type === "reorder") {
    const projects = store.projects.slice();
    const from = projects.findIndex((p) => p.id === ds.projectId);
    if (from < 0) return;
    const [moved] = projects.splice(from, 1);
    let to = target.insertBefore;
    if (to > from) to -= 1;                              // indices shift after the removal
    projects.splice(to, 0, moved);
    store.setProjects(projects);                        // optimistic re-order → the sidebar re-sorts instantly
    updateConfig({ projects });                         // persist (engine echoes {type:'config'})
  }
}

function cleanup() {
  if (ds.row) ds.row.classList.remove("dragging");
  if (ds.ghost) ds.ghost.remove();
  document.querySelectorAll(".drop-highlight, .drop-target").forEach((el) => el.classList.remove("drop-highlight", "drop-target"));
  clearDropLine();
}
function clearDropLine() { document.querySelectorAll(".project-drop-line").forEach((el) => el.remove()); }
