// The new-project creator (v1 app.js:768-859). Opens as a POPOVER anchored to the New Project button — the
// SAME transient-surface pattern as the new-session picker (13c: both are menu.js popovers; the old inline
// card that reflowed the session list is gone). A folder path (with the folder picker behind Browse), a name
// that auto-fills from the folder's basename until you edit it, and a round-robin colour from the 8-palette.
// Create writes config.projects optimistically (the empty group renders instantly) then persists via
// config.update. Enter creates; Esc / outside-click / Cancel dismiss (all via menu.js). Built structurally.
import { store } from "../store.js";
import { updateConfig } from "../ws.js";
import { h, basename, PROJECT_COLORS } from "../util.js";
import { openFolderPicker } from "./folder-picker.js";
import { openMenu } from "./menu.js";

const FOLDER_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';

let handle = null;

function genId() { return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }   // matches /^[A-Za-z0-9_-]{1,100}$/

export function closeProjectCreator() { if (handle) handle.close(); }

export function openProjectCreator(anchor, focus = {}) {
  if (handle) { handle.close(); return; }   // toggle off (menu.js leaves the trigger's own click to us)
  handle = openMenu(anchor, [{ render: buildForm }], {
    align: "start", className: "menu-form", returnFocus: anchor,
    pointerReturnFocus: focus.pointerReturnFocus, sourceEvent: focus.sourceEvent,
    onClose: () => { handle = null; },
  });
}

// The form is menu.js's single render() item → no menuitems, so Arrow/Enter/typing reach these inputs and
// only Escape / outside-click / scroll dismiss the popover.
function buildForm(ctl) {
  const form = h("div", "pc-form");
  const pathCap = h("div", "pc-cap", "Project folder");
  const pathRow = h("div", "pc-path-row");
  // Prefilled with the configured Default working directory (Settings) so the setting is VISIBLE — it was only
  // consulted at create time, which made a blank field read as "my setting is ignored". Clearing it still falls
  // back to the same value in doCreate, so the placeholder's promise holds.
  const pathInput = h("input", "pc-path"); pathInput.value = store.defaultCwd || ""; pathInput.placeholder = "path/to/folder — blank = default"; pathInput.spellcheck = false; pathInput.autocomplete = "off";
  const browse = h("button", "pc-browse", FOLDER_ICON); browse.type = "button"; browse.title = "Browse folders"; browse.setAttribute("aria-label", "Browse folders");
  pathRow.append(pathInput, browse);
  const nameCap = h("div", "pc-cap", "Project name "); nameCap.appendChild(h("span", null, "auto-filled from the folder"));
  const nameInput = h("input", "pc-name"); nameInput.placeholder = "Project name"; nameInput.spellcheck = false; nameInput.autocomplete = "off"; nameInput.maxLength = 60;
  const foot = h("div", "pc-foot");
  const create = h("button", "pc-create", "Create project"); create.type = "button";
  const cancel = h("button", "pc-cancel", "Cancel"); cancel.type = "button";
  foot.append(create, cancel);
  form.append(pathCap, pathRow, nameCap, nameInput, foot);

  let userEditedName = false;
  const autoName = () => { const p = pathInput.value.trim(); if (p && !userEditedName) nameInput.value = basename(p); };
  pathInput.addEventListener("input", autoName);
  nameInput.addEventListener("input", () => { userEditedName = nameInput.value.trim().length > 0; });
  autoName();   // a programmatic .value fires no input event, so derive the name from the prefill here

  for (const inp of [pathInput, nameInput]) inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); doCreate(); }   // Esc / outside-click dismissal is menu.js's job now
  });
  browse.addEventListener("click", (e) => {
    e.stopPropagation();
    // folder picker flags body.cd-modal-open → this popover stays open behind it (menu.js modal-guard)
    openFolderPicker(pathInput.value.trim(), (p) => { pathInput.value = p; autoName(); }, () => setTimeout(() => pathInput.focus(), 0));
  });
  create.addEventListener("click", doCreate);
  cancel.addEventListener("click", () => ctl.close());

  function doCreate() {
    const path = pathInput.value.trim() || store.defaultCwd;   // blank folder → the configured Default working directory (Settings)
    const name = nameInput.value.trim() || basename(path);
    if (!name || name === "/") { nameInput.focus(); return; }   // name is required (basename of "" is "/")
    const projects = store.projects.slice();
    projects.push({ id: genId(), name, path, color: PROJECT_COLORS[projects.length % PROJECT_COLORS.length], collapsed: false });
    store.setProjects(projects);                                // optimistic → the empty group renders instantly
    updateConfig({ projects });                                 // persist (engine echoes {type:'config'})
    ctl.close();
  }

  // Caret to the END of the prefill, not a select-all: the default working dir is a PARENT folder, so the common
  // next move is appending a subfolder rather than retyping the whole path.
  setTimeout(() => {
    pathInput.focus();
    const end = pathInput.value.length;
    if (pathInput.setSelectionRange) pathInput.setSelectionRange(end, end);
  }, 0);
  return form;
}
