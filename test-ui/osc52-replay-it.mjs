// OSC52 is a live terminal side effect. Persisted output and shared-terminal focus rewrites may repaint it,
// but must never copy it again. This drives the real store -> terminal -> hotkeys path.
import { installFakeDom } from "./fakedom.mjs";
installFakeDom();
const el = (id) => { const node = document.createElement("div"); node.id = id; document.body.appendChild(node); return node; };
for (const id of ["term", "term-head", "th-avatar", "th-chip", "th-copy", "th-meta", "th-name", "th-rename", "rp", "rp-empty", "rp-empty-big", "rp-empty-sub", "scroll-btn"]) el(id);
globalThis.getComputedStyle = () => ({ paddingLeft: "0", paddingRight: "0", paddingTop: "0", paddingBottom: "0" });
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
const copied = [];
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform: "MacIntel", userAgent: "", clipboard: { writeText: async (text) => { copied.push(text); } } } });

let terminal;
class FakeTerminal {
  constructor(options) {
    terminal = this; this.options = { ...options }; this.cols = options.cols; this.rows = options.rows; this.writes = [];
    this.buffer = { active: { viewportY: 0, baseY: 0, length: 0, getLine: () => null } };
    this.modes = { bracketedPasteMode: true };
    this._core = { _renderService: { dimensions: { css: { cell: { width: 8, height: 16 } } } }, viewport: { scrollBarWidth: 0 } };
    this.parser = { registerOscHandler: (code, fn) => { if (code === 52) this.osc52 = fn; } };
  }
  open(host) { const viewport = document.createElement("div"); viewport.className = "xterm-viewport"; host.appendChild(viewport); this.textarea = document.createElement("textarea"); host.appendChild(this.textarea); }
  attachCustomKeyEventHandler() {} onData() {} onScroll() {} onResize() { return { dispose() {} }; } registerLinkProvider() {} reset() {} clear() {}
  write(data, done) { this.writes.push({ data, done }); }
  finish(index) { const done = this.writes[index]?.done; if (done) { this.writes[index].done = null; done(); } }
  async parse(index) {
    const match = String(this.writes[index]?.data || "").match(/\x1b\]52;([^\x07]*)\x07/);
    return match ? this.osc52(match[1]) : false;
  }
  resize(cols, rows) { this.cols = cols; this.rows = rows; } scrollToBottom() {} focus() { this.textarea.focus(); }
}
window.Terminal = FakeTerminal;
const checks = [];
function ok(name, pass) { checks.push([name, !!pass]); console.log((pass ? "  ok   " : "  FAIL ") + name); }

const { store } = await import("../public/js/store.js");
const { initTerminal } = await import("../public/js/ui/terminal.js");
initTerminal();
const created = (id) => store.applyEvent({ type: "session.created", sessionId: id, provider: "shell", cwd: "/tmp", name: id, live: true, pid: 1 });
const osc = (text) => "\x1b]52;c;" + btoa(text) + "\x07";
created("A");

store.applyEvent({ type: "output", sessionId: "A", data: osc("history"), replay: true });
await terminal.parse(0); terminal.finish(0);
ok("history-tail output cannot write OSC52 to the clipboard", copied.length === 0);

created("B"); store.select("B"); store.select("A");
await terminal.parse(1); terminal.finish(1);
ok("switching sessions and rewriting output remains side-effect free", copied.length === 0);

store.applyEvent({ type: "output", sessionId: "A", data: osc("overlap one"), replay: true });
store.applyEvent({ type: "output", sessionId: "A", data: osc("overlap two"), replay: true });
await terminal.parse(2); terminal.finish(2);
await terminal.parse(3);
ok("one completed replay cannot lower the guard while another is pending", copied.length === 0);
terminal.finish(3);

store.applyEvent({ type: "output", sessionId: "A", data: osc("live copy") });
await terminal.parse(4); terminal.finish(4);
ok("live OSC52 still writes exactly once", copied.length === 1 && copied[0] === "live copy");

if (checks.some(([, pass]) => !pass)) process.exitCode = 1;
else console.log(`\n${checks.length}/${checks.length} OSC52 replay checks passed`);
