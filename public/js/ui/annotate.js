// R2 annotate surface — a prompt.show {annotate:{contentId,url,name}} shows the image with a drawing layer; the
// user drags rectangles (each with an optional note), then Send resolves the prompt with the MARKS JSON below.
// Skip / Escape / backdrop sends empty marks (the agent is blocked — closing must still unblock it). Follows the
// 13c modal conventions (scrim + cd-modal-open + animate + Escape).
//
// MARKS SPEC (the answer value string; engine does not validate — this is the renderer↔agent contract):
//   { "image": { "w": <natural px>, "h": <natural px> },
//     "marks": [ { "x":px, "y":px, "w":px, "h":px, "note"?:str }, … ] }
//   Rect coords are in the image's NATURAL pixel space (top-left origin); `image` gives the reference size so an
//   agent can map marks back onto the original file regardless of how it was displayed.
import { h } from "../util.js";

let overlay = null, layer = null, img = null, rects = [], curPromptId = null, resultCb = null, drawing = null;

export function annotateOpenFor() { return curPromptId; }

export function openAnnotate(ev, onResult) {
  closeAnnotate();
  const a = (ev && ev.annotate) || {};
  curPromptId = ev.promptId; resultCb = typeof onResult === "function" ? onResult : () => {}; rects = [];
  overlay = h("div", "an-overlay");
  const modal = h("div", "an-modal");
  const head = h("div", "an-head");
  const title = h("div", "an-title"); title.textContent = a.name || "Annotate image";
  const hint = h("div", "an-hint"); hint.textContent = "Drag to draw boxes · add a note to each";
  const skip = h("button", "an-skip", "Skip"); skip.type = "button";
  const send = h("button", "an-send", "Send annotations"); send.type = "button";
  head.append(title, hint, skip, send);
  const stage = h("div", "an-stage");
  const frame = h("div", "an-frame");   // shrinks to the image so the drawing layer overlays it exactly
  img = h("img", "an-img"); img.src = a.url; img.alt = a.name || "";
  layer = h("div", "an-layer");
  frame.append(img, layer);
  stage.appendChild(frame);
  modal.append(head, stage);
  overlay.append(modal);
  overlay.addEventListener("mousedown", (e) => { e.stopPropagation(); if (e.target === overlay) doSkip(); });
  overlay.addEventListener("click", (e) => e.stopPropagation());
  skip.addEventListener("click", doSkip);
  send.addEventListener("click", doSend);
  layer.addEventListener("pointerdown", onDown);
  document.body.appendChild(overlay);
  document.body.classList.add("cd-modal-open");
  document.addEventListener("keydown", onKey, true);
  requestAnimationFrame(() => { if (overlay) overlay.classList.add("show"); });   // guard: a fast close may have nulled it
}

function onKey(e) { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); doSkip(); } }
function rectOf() { return layer.getBoundingClientRect(); }
function place(box, l, t, w, ht) { box.style.left = l + "px"; box.style.top = t + "px"; box.style.width = w + "px"; box.style.height = ht + "px"; }

function onDown(e) {
  if (e.button != null && e.button !== 0) return;
  const r = rectOf();
  const box = h("div", "an-rect");
  drawing = { box, x0: e.clientX - r.left, y0: e.clientY - r.top, cur: null };
  place(box, drawing.x0, drawing.y0, 0, 0);
  layer.appendChild(box);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  if (e.preventDefault) e.preventDefault();
}
function onMove(e) {
  if (!drawing) return;
  const r = rectOf();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  const cur = { left: Math.min(x, drawing.x0), top: Math.min(y, drawing.y0), w: Math.abs(x - drawing.x0), h: Math.abs(y - drawing.y0) };
  place(drawing.box, cur.left, cur.top, cur.w, cur.h);
  drawing.cur = cur;
}
function onUp() {
  window.removeEventListener("pointermove", onMove);
  window.removeEventListener("pointerup", onUp);
  if (!drawing) return;
  const c = drawing.cur;
  if (!c || c.w < 6 || c.h < 6) { drawing.box.remove(); drawing = null; return; }   // ignore a click / tiny drag
  const rec = { left: c.left, top: c.top, w: c.w, h: c.h, note: "", box: drawing.box };
  const note = h("input", "an-note-in"); note.type = "text"; note.placeholder = "note (optional)"; note.spellcheck = false; note.autocomplete = "off";
  note.addEventListener("keydown", (e) => e.stopPropagation());
  note.addEventListener("input", () => { rec.note = note.value; });
  const del = h("button", "an-rect-x", "×"); del.type = "button"; del.title = "Remove box";
  del.addEventListener("click", (e) => { e.stopPropagation(); rec.box.remove(); rects = rects.filter((x) => x !== rec); });
  drawing.box.append(note, del);
  rects.push(rec);
  drawing = null;
}

function buildMarks() {
  const r = rectOf();
  const dispW = r.width || 1, dispH = r.height || 1;
  const nw = img.naturalWidth || dispW, nh = img.naturalHeight || dispH;
  const sx = nw / dispW, sy = nh / dispH;
  const marks = rects.map((m) => {
    const o = { x: Math.round(m.left * sx), y: Math.round(m.top * sy), w: Math.round(m.w * sx), h: Math.round(m.h * sy) };
    if (m.note && m.note.trim()) o.note = m.note.trim();
    return o;
  });
  return JSON.stringify({ image: { w: nw, h: nh }, marks });
}

function doSend() { const cb = resultCb; const v = buildMarks(); finish(); if (cb) cb(v); }
function doSkip() { const cb = resultCb; const nw = (img && img.naturalWidth) || 0, nh = (img && img.naturalHeight) || 0; finish(); if (cb) cb(JSON.stringify({ image: { w: nw, h: nh }, marks: [] })); }

function finish() {
  const node = overlay;
  curPromptId = null; resultCb = null; rects = []; drawing = null;
  overlay = null; layer = null; img = null;
  if (!node) return;
  document.removeEventListener("keydown", onKey, true);
  node.classList.remove("show");
  setTimeout(() => { node.remove(); if (!overlay) document.body.classList.remove("cd-modal-open"); }, 180);
}

// forced close on prompt.resolved (answered elsewhere / timed out) — dismiss with NO answer sent.
export function closeAnnotate() { if (!overlay && curPromptId == null) return; resultCb = null; finish(); }
