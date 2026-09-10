// Document title (§N) — tracks the active session so the browser tab / window names the context.
// 'CliDeck — <name>' (or '<Project>/<name>' when the session belongs to a project); plain 'CliDeck'
// when nothing is open. v1 tracked panel names; v2 tracks the active session — one clear anchor.
import { store } from "./store.js";
import { shortId } from "./util.js";

function titleFor() {
  const s = store.active();
  if (!s) return "CliDeck";
  const name = s.name || shortId(s.id);
  const proj = s.projectId ? store.projects.find((p) => p.id === s.projectId) : null;
  return "CliDeck — " + (proj ? (proj.name || "Project") + "/" + name : name);
}

function apply() { try { document.title = titleFor(); } catch {} }

export function initTitle() {
  apply();
  store.on("active", apply);                                   // selection changed (or cleared)
  store.on("session:update", (id) => { if (id === store.activeId) apply(); });   // active session renamed / moved project
  store.on("reset", apply);                                    // reconnect wipe → back to plain 'CliDeck' until re-selected
}
