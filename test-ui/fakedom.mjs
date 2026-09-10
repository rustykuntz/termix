// Committed, self-contained fake DOM for the UI integration tests (test-ui/). Minimal but faithful: enough of
// Element / document / window for the store, toast, content renderers, and the content surfaces to run under
// plain `node`. Replaces the wiped scratchpad harness — this one lives in the repo (standing rule).
export class El {
  constructor(tag, ns) {
    this.tag = tag; this.tagName = String(tag || "").toUpperCase(); this.ns = ns || null; this._cls = new Set(); this._kids = []; this.parentNode = null;
    this._on = {}; this._text = ""; this._html = ""; this.id = ""; this._attrs = {}; this.dataset = {};
    this._style = {}; this.style = new Proxy(this._style, { get: (t, k) => (k === "setProperty" ? (kk, v) => { t[kk] = v; } : t[k]), set: (t, k, v) => { t[k] = v; return true; } });
    if (tag === "input" || tag === "textarea") this.value = "";   // real form controls default to "", not undefined
    // Recording 2d context: clearRect starts a frame, each arc() records the ball drawn in it. Lets a test read
    // what was PAINTED (the canvas equivalent of reading cx/cy off SVG circles) without a real canvas.
    if (tag === "canvas") {
      this.width = 0; this.height = 0;
      const ctx = {
        globalAlpha: 1, fillStyle: "", _arcs: [], _frames: 0,
        setTransform() {}, scale() {}, beginPath() {}, fill() {},
        clearRect() { this._arcs = []; this._frames++; },
        arc(x, y, r) { this._arcs.push({ x, y, r, fill: this.fillStyle }); },
      };
      this._ctx = ctx;
      this.getContext = () => ctx;
    }
  }
  get children() {
    const kids = this._kids;
    const col = { length: kids.length, item: (i) => kids[i] || null, namedItem: () => null,
      [Symbol.iterator]: function* () { yield* kids; } };
    for (let i = 0; i < kids.length; i++) col[i] = kids[i];
    return col;
  }
  get _childList() { return this._kids; }          // internal: tests/harness walk this, product code must not
  get firstElementChild() { return this._kids[0] || null; }
  get lastElementChild() { return this._kids[this._kids.length - 1] || null; }
  get nextSibling() { const p = this.parentNode; if (!p) return null; const i = p._kids.indexOf(this); return i < 0 ? null : (p._kids[i + 1] || null); }
  get previousSibling() { const p = this.parentNode; if (!p) return null; const i = p._kids.indexOf(this); return i < 0 ? null : (p._kids[i - 1] || null); }
  set className(v) { this._cls = new Set(String(v || "").split(/\s+/).filter(Boolean)); }
  get className() { return [...this._cls].join(" "); }
  get classList() { const s = this._cls; return { add: (...c) => c.forEach((x) => s.add(x)), remove: (...c) => c.forEach((x) => s.delete(x)), contains: (c) => s.has(c), toggle: (c, f) => { const on = f == null ? !s.has(c) : !!f; on ? s.add(c) : s.delete(c); return on; } }; }
  set textContent(v) { this._text = String(v == null ? "" : v); this._kids = []; this._html = ""; }
  get textContent() { if (this._text) return this._text; if (this._kids.length) return this._kids.map((c) => c.textContent).join(""); return this._html ? this._html.replace(/<[^>]+>/g, "") : ""; }
  set innerHTML(v) { this._html = String(v == null ? "" : v); this._kids = []; }
  get innerHTML() { return this._html; }
  get offsetHeight() { return 40; }
  get offsetWidth() { return 200; }
  getBoundingClientRect() { return this._rect || { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  get firstChild() { return this._kids[0] || null; }
  setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; }
  select() { this.setSelectionRange(0, String(this.value == null ? "" : this.value).length); }   // real form controls have it; inlineRename calls it
  setAttribute(k, v) { this._attrs[k] = String(v); if (k === "id") this.id = String(v); if (k === "class") this.className = v; }
  getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; }
  hasAttribute(k) { return k in this._attrs; }
  removeAttribute(k) { delete this._attrs[k]; }
  appendChild(n) { n.parentNode = this; this._kids.push(n); return n; }
  append(...ns) { ns.forEach((n) => n && this.appendChild(n)); }
  prepend(n) { n.parentNode = this; this._kids.unshift(n); }
  insertBefore(n, ref) { n.parentNode = this; const i = ref ? this._kids.indexOf(ref) : -1; if (i < 0) this._kids.push(n); else this._kids.splice(i, 0, n); return n; }
  replaceChildren(...ns) { this._kids = []; this._text = ""; this._html = ""; ns.forEach((n) => n && this.appendChild(n)); }
  remove() { if (this.parentNode) { this.parentNode._kids = this.parentNode._kids.filter((c) => c !== this); this.parentNode = null; } }
  replaceWith(n) { if (this.parentNode) { const i = this.parentNode._kids.indexOf(this); this.parentNode._kids[i] = n; n.parentNode = this.parentNode; this.parentNode = null; } }
  contains(n) { if (n === this) return true; return this._kids.some((c) => c.contains(n)); }
  // A real tree can hold TEXT nodes beside elements (a hint that is "Detected: X · <button>"), and a selector
  // walk simply never matches one. The harness used to recurse into them and die on the missing _walk.
  _walk(out = []) { for (const c of this._kids) { if (typeof c._walk !== "function") continue; out.push(c); c._walk(out); } return out; }
  querySelector(sel) { return this._walk().find((n) => matchSel(n, sel)) || null; }
  querySelectorAll(sel) { return this._walk().filter((n) => matchSel(n, sel)); }
  closest(sel) { const groups = sel.split(","); let n = this; while (n) { if (groups.some((g) => matchSel(n, g))) return n; n = n.parentNode; } return null; }
  addEventListener(t, fn) { (this._on[t] || (this._on[t] = [])).push(fn); }
  removeEventListener(t, fn) { if (this._on[t]) this._on[t] = this._on[t].filter((f) => f !== fn); }
  _fire(t, ev = {}) { ev.target = ev.target || this; if (!ev.stopPropagation) ev.stopPropagation = () => {}; if (!ev.preventDefault) ev.preventDefault = () => {}; (this._on[t] || []).slice().forEach((fn) => fn(ev)); }
  set onclick(fn) { this.addEventListener("click", fn); }
  get isConnected() {
    let n = this;
    while (n && n.parentNode) n = n.parentNode;
    return !!(globalThis.document && n === globalThis.document.body);
  }
  focus() { if (globalThis.document) globalThis.document.activeElement = this; }
  setPointerCapture() {} releasePointerCapture() {}
  cloneNode(deep) {
    const n = new El(this.tag, this.ns);
    n._cls = new Set(this._cls); n._attrs = { ...this._attrs }; n.dataset = { ...this.dataset };
    n.id = this.id; n._text = this._text; n._html = this._html; Object.assign(n._style, this._style);
    if (deep) for (const c of this._kids) n.appendChild(c.cloneNode(true));
    return n;
  }
}
// selector engine: comma groups, descendant chains ("pre code"), child ">" (treated as descendant), compound
// tokens ("tag.cls#id.cls2"), and attribute presence/equality ("[data-id]", "[k=v]").
function parseCompound(tok) {
  const c = { classes: [], attrs: [] };
  tok = tok.replace(/\[([^\]=]+)(?:=["']?([^\]"']*)["']?)?\]/g, (_, k, v) => { c.attrs.push([k.trim(), v]); return ""; });
  tok.match(/[.#]?[\w-]+/g)?.forEach((t) => { if (t[0] === ".") c.classes.push(t.slice(1)); else if (t[0] === "#") c.id = t.slice(1); else c.tag = t; });
  return c;
}
function attrVal(el, k) {
  // A real element keeps setAttribute("data-x") and dataset.x as ONE thing. The harness stores them apart, so a
  // [data-x] selector has to look in both — it used to see only dataset and miss every setAttribute-written one.
  if (k.startsWith("data-")) {
    const camel = k.slice(5).replace(/-([a-z])/g, (_, x) => x.toUpperCase());
    const fromDataset = el.dataset ? el.dataset[camel] : undefined;
    if (fromDataset != null) return fromDataset;
    return el._attrs && k in el._attrs ? el._attrs[k] : undefined;
  }
  if (el._attrs && k in el._attrs) return el._attrs[k];
  return el[k];
}
function matchCompound(el, c) {
  if (!el || !el._cls) return false;
  if (c.tag && el.tag !== c.tag) return false;
  if (c.id && el.id !== c.id) return false;
  if (!c.classes.every((cl) => el._cls.has(cl))) return false;
  for (const [k, v] of c.attrs || []) { const av = attrVal(el, k); if (av == null || av === false) return false; if (v != null && String(av) !== v) return false; }
  return true;
}
// `_fire` invokes ONE element's listeners. A real click also runs every ancestor's, and stopPropagation is the
// only thing that halts it — so a bug about a click reaching the surface BEHIND a control is invisible to
// `_fire`. This walks the chain the way the browser does. Opt-in: no existing suite changes behaviour.
export function bubbleFire(el, type, init = {}) {
  let stopped = false;
  const ev = { ...init, target: init.target || el, stopPropagation: () => { stopped = true; }, preventDefault: init.preventDefault || (() => {}) };
  for (let node = el; node && !stopped; node = node.parentNode) {
    const handlers = node._on && node._on[type];
    if (!handlers) continue;
    for (const fn of handlers.slice()) { fn(ev); if (stopped) break; }
  }
  return ev;
}

export function matchSel(el, sel) {
  return sel.split(",").some((group) => {
    const parts = group.trim().replace(/\s*>\s*/g, " ").split(/\s+/).filter(Boolean).map(parseCompound);
    if (!matchCompound(el, parts[parts.length - 1])) return false;
    let pi = parts.length - 2, node = el.parentNode;
    while (pi >= 0 && node) { if (matchCompound(node, parts[pi])) pi--; node = node.parentNode; }
    return pi < 0;
  });
}
export const matchesSimple = matchSel;   // back-comaptible alias

// Install document/window/etc. as globals. Returns helpers { body, docFire, all, css }.
export function installFakeDom() {
  const body = new El("body");
  const docCap = {};
  const document = {
    body,
    activeElement: body,
    createElement: (tag) => new El(tag),
    // A real text node: the extractor walks nodeType 3 directly, and a fake that only has elements would let
    // it pass here while failing on every real document.
    createTextNode: (text) => ({ nodeType: 3, nodeValue: String(text), textContent: String(text), parentNode: null, _kids: [], contains() { return false; } }),
    createElementNS: (ns, tag) => new El(tag, ns),
    getElementById: (id) => body._walk().find((n) => n.id === id) || null,
    querySelector: (sel) => (matchesSimple(body, sel) ? body : body.querySelector(sel)),
    querySelectorAll: (sel) => body.querySelectorAll(sel),
    addEventListener: (t, fn) => { (docCap[t] || (docCap[t] = [])).push(fn); },
    removeEventListener: (t, fn) => { if (docCap[t]) docCap[t] = docCap[t].filter((f) => f !== fn); },
    documentElement: new El("html"),
  };
  globalThis.document = document;
  const winOn = {};
  globalThis.window = {
    _on: winOn,
    addEventListener: (t, fn) => { (winOn[t] || (winOn[t] = [])).push(fn); },
    removeEventListener: (t, fn) => { if (winOn[t]) winOn[t] = winOn[t].filter((f) => f !== fn); },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    innerWidth: 1200, innerHeight: 800, focus() {},
  };
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  globalThis.localStorage = { _s: {}, getItem(k) { return k in this._s ? this._s[k] : null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } };
  globalThis.matchMedia = globalThis.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  return {
    body,
    docFire: (t, ev) => (docCap[t] || []).slice().forEach((fn) => fn(ev)),
    winFire: (t, ev = {}) => { if (!ev.preventDefault) ev.preventDefault = () => {}; (winOn[t] || []).slice().forEach((fn) => fn(ev)); },
    all: (cls) => body.querySelectorAll("." + cls),
  };
}

// A fake WebSocket compatible with ws.js connectWs (onopen/onmessage/onclose props, readyState, static OPEN).
// Records every JSON frame the client sends so ITs can assert control messages (prompt.answer, input, …).
export function installFakeWs() {
  const sent = [];
  class FakeWS {
    constructor(url) { this.url = url; this.readyState = 0; this.onopen = this.onmessage = this.onclose = this.onerror = null; setTimeout(() => { this.readyState = 1; if (this.onopen) this.onopen(); }, 0); }
    send(d) { try { sent.push(JSON.parse(d)); } catch { sent.push(d); } }
    close() { this.readyState = 3; if (this.onclose) this.onclose(); }
  }
  FakeWS.OPEN = 1;
  globalThis.WebSocket = FakeWS;
  globalThis.location = globalThis.location || { host: "127.0.0.1:0" };
  return { sent, clear: () => { sent.length = 0; }, last: (type) => [...sent].reverse().find((m) => m && m.type === type) || null };
}
