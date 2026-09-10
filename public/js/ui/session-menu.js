// The per-session actions shown through the shared popover — used by the row ▾ button and the
// terminal context-menu. Order mirrors v1 [terminals.js:416-470]: Copy / Paste (terminal clipboard),
// then the session actions, then Delete. Rename, selection and liveness are supplied by the opener
// via opts, so this module stays decoupled from the terminal (no import cycle).
import { openMenu } from "./menu.js";
import { store } from "../store.js";
import { closeSession, setMute, send, setSessionProject } from "../ws.js";
import { copyText, askAddress } from "../util.js";
import { openThemePicker } from "./theme-picker.js";
import { restartWithTheme } from "../terminal-themes.js";
import { pastePayload } from "./paste.js";

// THE TERMINAL'S MENU IS NOT THE SESSION'S MENU. On a row you right-click a SESSION, so the menu offers
// session things — rename, theme, restart, delete. In the terminal you right-click TEXT, with a selection
// under the cursor, so the menu offers text things: copy it, paste over it, hear it. Carrying the whole
// session menu here made the common case (copy) sit inside a list mostly about something else, and every
// session action is still one right-click away on the row.
//
// "Read selection aloud" is NOT hardcoded: it is the Supertonic plugin's `read-selection` action arriving
// through opts.pluginItems, already gated on a non-empty selection. If the plugin is off, the item is
// absent rather than dead — which is the whole point of the plugin action surface.
export function openTerminalMenu(point, id, opts = {}) {
  const sel = opts.selection || "";
  const live = opts.live !== false;
  const plugin = Array.isArray(opts.pluginItems) && opts.pluginItems.length
    ? [{ separator: true }, ...opts.pluginItems] : [];
  openMenu(point, [
    { label: "Copy", disabled: !sel, onSelect: (c) => { copyText(sel); c.close(); } },
    { label: "Paste", disabled: !live, onSelect: (c) => { c.close(); pasteInto(id); } },
    ...plugin,
  ], {
    align: opts.align || "start",
    returnFocus: opts.returnFocus,
    sourceEvent: opts.sourceEvent,
    onClose: opts.onClose,
  });
}

export function openSessionMenu(anchor, id, opts = {}) {
  openMenu(anchor, baseItems(id, opts), {
    align: opts.align,
    returnFocus: opts.returnFocus,
    pointerReturnFocus: opts.pointerReturnFocus,
    sourceEvent: opts.sourceEvent,
    onClose: opts.onClose,
  });
}

// @address = exactly what /ask resolves: @Project/name when the session belongs to a project, else name||id.
function address(id) { return askAddress(store.sessions.get(id), store.projects); }

// MOVING between projects is a drag now — a project list in here was a second way to do an already
// intuitive gesture, and it was the longest block in the menu. What stays is the one thing a drag CANNOT
// express: dropping outside a project is deliberately a no-op (drag.js "never silently manufacture a cwd
// group"), so removal has no gesture and would otherwise become unreachable. Empty unless the session is
// actually in a project, so an ungrouped session sees no project block at all.
export function __projectItemsForTest(id, s) { return projectItems(id, s); }
function projectItems(id, s) {
  if (!(s && s.projectId)) return [];
  return [
    { html: '<span class="mi-dot mi-none"></span><span class="mi-label">Remove from project</span>',
      onSelect: (c) => { c.close(); setSessionProject(id, null); } },
    { separator: true },
  ];
}

async function pasteInto(id) {
  try { const t = await navigator.clipboard.readText(); if (t) send({ type: "input", sessionId: id, data: pastePayload(t) }); } catch {}
}

function baseItems(id, opts) {
  const sel = opts.selection || "";           // current terminal selection for this session ("" if none / not active)
  const live = opts.live !== false;           // dormant sessions have no PTY → no paste/restart
  const s = store.sessions.get(id);
  const proj = projectItems(id, s);
  const plugin = Array.isArray(opts.pluginItems) && opts.pluginItems.length ? [...opts.pluginItems, { separator: true }] : [];
  const items = [
    { label: "Copy", disabled: !sel, onSelect: (c) => { copyText(sel); c.close(); } },
    { label: "Paste", disabled: !live, onSelect: (c) => { c.close(); pasteInto(id); } },
    { separator: true },
    ...plugin,
    ...proj,
    { label: "Rename", onSelect: (c) => { c.close(); opts.onRename && opts.onRename(); } },
    { label: "Copy @address", _copyAddress: true, onSelect: (c) => {
        copyText(address(id));
        const items = baseItems(id, opts);
        const copyIdx = items.findIndex((item) => item._copyAddress);
        items[copyIdx] = { label: "Copied", ok: true, disabled: true };   // calm in-place confirmation (its own slot)
        c.replace(items, true);                                           // keepFocus: no jump during the flash
        setTimeout(() => c.close(), 850);
      } },
    { label: opts.muted ? "Unmute" : "Mute", onSelect: (c) => { c.close(); setMute(id, !opts.muted); } },
    { label: "Theme…", onSelect: (c) => { c.close(); openThemePicker(id); } },
    { label: "Restart session", disabled: !live, onSelect: (c) => { c.close(); restartWithTheme(id); } },
    { separator: true },
    // Confirm-before-close is a General setting: when OFF, Delete closes immediately (skips the inline confirm).
    { label: "Delete", danger: true, onSelect: (c) => (store.confirmClose === false ? (c.close(), closeSession(id)) : c.replace(confirmItems(id, opts))) },
  ];
  return items;
}

// Delete never fires on the first click — it flips the menu to an inline confirm (no browser dialog).
// Cancel returns to the actions; Delete closes and closes the session (live OR dormant).
function confirmItems(id, opts) {
  return [
    { label: "Delete this session?", caption: true },
    { label: "Cancel", onSelect: (c) => c.replace(baseItems(id, opts)) },
    { label: "Delete", danger: true, onSelect: (c) => { c.close(); closeSession(id); } },
  ];
}
