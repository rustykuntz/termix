// Generic popover menu — reused by session rows, the terminal context-menu, and (later) the
// project ⋮ menu. No app-specific knowledge lives here.
//
// openMenu(anchor, items, opts) → { close }
//   anchor : a DOM element (menu anchors to its box) OR a {x,y} client point (context-menu).
//   items  : [{ label, icon?, html?, danger?, ok?, disabled?, caption?, separator?, render?, onSelect(ctl) }]
//            icon → a host-built DOM node for the item's leading slot (never plugin markup). One icon in the
//            list gives EVERY item the slot, so the labels share a column.
//            caption → a non-interactive header line. html → rich item label (trusted markup) instead of
//            plain `label`. render(ctl) → a fully custom, non-menuitem row element (e.g. a swatch strip),
//            skipped by keyboard roaming. ctl = { close(), replace(items, keepFocus?) }.
//            If onSelect calls neither close nor replace, the menu auto-closes after it.
//   opts   : { align?: 'start'|'end', returnFocus?: el, pointerReturnFocus?: el,
//              sourceEvent?: MouseEvent, onClose?: fn, className?: string }
//            className → extra class on the root (e.g. 'menu-form' to host a form: drops the item padding).
//            A popover whose only item is a render() form has NO menuitems, so onKey roams nothing and the
//            form's own inputs receive Arrow/Enter/typing untouched — only Escape/outside/scroll dismiss it.
//
// One menu at a time; anchored + edge-flipped; role=menu/menuitem; focus enters the menu;
// Arrow/Home/End roam, Enter/Space select, Escape closes and restores focus; outside-click,
// scroll and resize close. Theme-aware purely through CSS tokens.

const MARGIN = 8;
const GAP = 4;               // breathing room between the anchor and the popover
const MIN_USABLE = 180;      // a side thinner than this is not worth anchoring to
let current = null;

export function closeMenu() { if (current) current.dismiss(false); }
export function isMenuOpen() { return !!current; }   // so a host (e.g. the settings modal) can defer its own Escape to the menu

export function openMenu(anchor, items, opts = {}) {
  closeMenu();

  const isPoint = !(anchor && anchor.nodeType === 1);
  const keyboardReturnFocus = opts.returnFocus || (isPoint ? null : anchor);
  // Browser-generated keyboard/screen-reader clicks have detail=0; pointer clicks have detail>0.
  // Keep the trigger for keyboard accessibility, but let pointer-opened sidebar menus return to xterm.
  const pointerOpened = !!(opts.sourceEvent && Number(opts.sourceEvent.detail) > 0);
  const returnFocus = pointerOpened && opts.pointerReturnFocus
    ? opts.pointerReturnFocus
    : keyboardReturnFocus;
  const root = document.createElement("div");
  root.className = "menu" + (opts.className ? " " + opts.className : "");   // e.g. "menu-form" for a hosted form
  root.setAttribute("role", "menu");
  root.tabIndex = -1;

  const state = { itemEls: [] };

  // A hidden or detached anchor reports an ALL-ZERO rect, which reads as "the top-left corner of the screen"
  // and is where the menu used to jump. The row's ▾ is display:none unless the row is hovered or active, so
  // simply moving the pointer onto the menu to reach an item makes the anchor vanish — and the next
  // position() (Delete → its confirm) sent the popover to (8,8). Remember the last real rect and keep using
  // it: where the menu opened is still where it belongs.
  let lastRect = null;
  let placedAbove = null;   // which side we settled on; kept across replace() so the popover never flips
  function anchorRect() {
    if (isPoint) { const { x, y } = anchor; return { left: x, right: x, top: y, bottom: y }; }
    const b = anchor.getBoundingClientRect();
    if (b.width || b.height) lastRect = { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
    return lastRect || b;
  }

  function render(list) {
    root.replaceChildren();
    state.itemEls = [];
    // A menu is iconed as a WHOLE: the moment one item carries an icon every item gets the same leading
    // slot, so labels stay on one column instead of stepping in and out around the decorated rows.
    const iconed = list.some((it) => it && it.icon && !it.separator && !it.caption && !it.render);
    root.classList.toggle("menu-iconed", iconed);
    for (const it of list) {
      if (it.separator) {
        const sep = document.createElement("div");
        sep.className = "menu-sep"; sep.setAttribute("role", "separator");
        root.appendChild(sep);
        continue;
      }
      if (it.caption) {
        const cap = document.createElement("div");
        cap.className = "menu-cap";
        cap.textContent = it.label;
        root.appendChild(cap);
        continue;
      }
      if (it.render) {                                    // fully custom row (not a menuitem, not roamed)
        const el = it.render({ close: () => dismiss(true), replace: (n, k) => { render(n); position(); if (!k) focusFirst(); } });
        if (el) root.appendChild(el);
        continue;
      }
      const el = document.createElement("button");
      el.type = "button";
      el.className = "menu-item" + (it.danger ? " danger" : "") + (it.ok ? " ok" : "");
      el.setAttribute("role", "menuitem");
      if (iconed) {
        const slot = document.createElement("span");
        slot.className = "menu-ic"; slot.setAttribute("aria-hidden", "true");
        if (it.icon) slot.appendChild(it.icon);
        const label = document.createElement("span");
        label.className = "menu-lb";
        if (it.html != null) label.innerHTML = it.html; else label.textContent = it.label;
        el.append(slot, label);
      } else if (it.html != null) el.innerHTML = it.html; else el.textContent = it.label;
      if (it.disabled) { el.disabled = true; el.setAttribute("aria-disabled", "true"); }
      else el.addEventListener("click", () => activate(it));
      root.appendChild(el);
      state.itemEls.push(el);
    }
  }

  // Prefer below the anchor, then above. When NEITHER side fits, take the roomier side and size the menu to
  // it rather than giving up — and when even that is too cramped to read, stop tracking the anchor's line
  // altogether and use the full column. Starting exactly at the row is a nicety; being readable is not.
  function position() {
    root.style.visibility = "hidden";
    root.style.maxHeight = "";                                               // measure natural height first
    root.style.left = "0px"; root.style.top = "0px";
    const w = root.offsetWidth, h = root.offsetHeight;
    const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    const r = anchorRect();
    const align = opts.align || (isPoint ? "start" : "end");

    const below = vh - MARGIN - (r.bottom + GAP);
    const above = (r.top - GAP) - MARGIN;
    // Once a side is chosen it STICKS. replace() (Delete → its confirm) re-runs this with a much shorter
    // menu, and picking the side afresh would flip a popover opened above the row to below it — the content
    // changes under the pointer AND leaps a few hundred px away from where the user is looking.
    let top, cap = 0;
    const fitsBelow = h <= below, fitsAbove = h <= above;
    const useAbove = placedAbove == null ? (!fitsBelow && fitsAbove) : (placedAbove ? fitsAbove || !fitsBelow : !fitsBelow && fitsAbove);
    if (!useAbove && fitsBelow) top = r.bottom + GAP;
    else if (useAbove && fitsAbove) top = r.top - GAP - h;
    else if (Math.max(below, above) >= MIN_USABLE) {
      cap = Math.max(below, above);
      top = below >= above ? r.bottom + GAP : r.top - GAP - cap;
    } else {
      cap = vh - MARGIN * 2;                                                 // detached from the row
      top = MARGIN;
    }
    if (placedAbove == null) placedAbove = useAbove && fitsAbove;
    if (cap) root.style.maxHeight = cap + "px";
    const hh = cap ? Math.min(h, cap) : h;
    top = Math.min(Math.max(MARGIN, top), Math.max(MARGIN, vh - MARGIN - hh));

    let left = align === "end" ? r.right - w : r.left;
    left = Math.min(Math.max(MARGIN, left), Math.max(MARGIN, vw - MARGIN - w));
    root.style.left = left + "px"; root.style.top = top + "px";
    root.style.visibility = "";
  }

  function enabledEls() { return state.itemEls.filter((e) => !e.disabled); }
  function focusFirst() { const e = enabledEls()[0]; if (e) e.focus({ preventScroll: true }); }

  function activate(it) {
    let handled = false;
    const ctl = {
      close: () => { handled = true; dismiss(true); },
      replace: (next, keepFocus) => { handled = true; render(next); position(); if (!keepFocus) focusFirst(); },
    };
    if (it.onSelect) it.onSelect(ctl);
    if (!handled) dismiss(true);
  }

  // A modal the menu itself spawned (the folder picker, opened from a form popover's Browse) sits ON TOP —
  // while it's up, the menu must ignore Escape / outside-click / scroll so the modal owns dismissal and the
  // menu stays open behind it. The modal toggles document.body.cd-modal-open for its lifetime.
  function modalOpen() { return document.body.classList.contains("cd-modal-open"); }

  function onKey(e) {
    if (modalOpen()) return;
    if (e.key === "Escape") { e.preventDefault(); dismiss(true); return; }
    const els = enabledEls();
    if (!els.length) return;
    const i = els.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); (els[(i + 1) % els.length] || els[0]).focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); (els[(i - 1 + els.length) % els.length] || els[0]).focus(); }
    else if (e.key === "Home") { e.preventDefault(); els[0].focus(); }
    else if (e.key === "End") { e.preventDefault(); els[els.length - 1].focus(); }
    else if (e.key === "Tab") { dismiss(false); }
  }
  function onDown(e) {
    if (modalOpen()) return;
    if (root.contains(e.target)) return;
    // Let a TOGGLE toggle: pressing the button that opened the menu must close it rather than reopen it, so a
    // click inside the trigger is not an outside click. ⚠️ That exemption belongs to an ELEMENT-anchored menu
    // only. A context menu is anchored to a POINT, and its "trigger" is whatever surface was right-clicked —
    // for a document that is the entire page. Honoured there, the guard made every click inside the document
    // a click on the trigger, and the menu could not be dismissed by clicking anything it covered. A
    // right-click is not a toggle; there is nothing to toggle back.
    if (!isPoint && returnFocus && returnFocus.contains && returnFocus.contains(e.target)) return;
    dismiss(false);
  }
  // A scroll used to CLOSE the menu outright, which meant any scroll anywhere — the session list, a document
  // pane, the terminal viewport — killed a popover the user had just opened, and it read as "it flashed and
  // vanished". An element-anchored menu now FOLLOWS its anchor instead, and only gives up when the anchor is
  // gone or has left the viewport. A point-anchored one (the terminal context-menu) still closes: its point
  // is a place on screen, and once the content scrolls that place means nothing.
  let raf = 0;
  function reflow() { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; if (current === handle) position(); }); }
  function onScrollResize(e) {
    if (modalOpen()) return;
    if (e && e.target && root.contains && root.contains(e.target)) return;   // the menu's own overflow
    if (isPoint) { dismiss(false); return; }
    if (!anchor.isConnected) { dismiss(false); return; }
    const b = anchor.getBoundingClientRect();
    const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    if ((b.width || b.height) && (b.bottom < 0 || b.top > vh || b.right < 0 || b.left > vw)) { dismiss(false); return; }
    reflow();
  }

  // A click inside a sandboxed preview frame never reaches THIS document, so outside-click alone would leave
  // the menu hanging over content the user has already moved on from. Focus landing IN a frame is the tell —
  // and it is specifically not an app switch, where the active element does not become an iframe.
  function onBlur() {
    if (modalOpen()) return;
    const focused = document.activeElement;
    if (focused && String(focused.tagName || "").toUpperCase() === "IFRAME") dismiss(false);
  }

  function dismiss(restoreFocus) {
    if (current !== handle) return;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("mousedown", onDown, true);
    document.removeEventListener("scroll", onScrollResize, true);
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("resize", onScrollResize);
    root.remove();
    current = null;
    if (restoreFocus && returnFocus && returnFocus.isConnected) returnFocus.focus();
    if (opts.onClose) opts.onClose();
  }

  const handle = { dismiss };
  current = handle;
  render(items);
  document.body.appendChild(root);
  position();
  focusFirst();
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("mousedown", onDown, true);
  document.addEventListener("scroll", onScrollResize, true);
  window.addEventListener("resize", onScrollResize);
  window.addEventListener("blur", onBlur);
  return { close: () => dismiss(true) };
}
