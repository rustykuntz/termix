// UI IT — every paste is one bracketed transaction; pasted newlines and embedded bracket controls cannot
// become an early Enter. Drives the real terminal paste handler, ws.send and normal terminal onData path.
import { installFakeDom, installFakeWs } from "./fakedom.mjs";

installFakeDom();
const ws = installFakeWs();
const el = (tag, id, parent = document.body) => {
  const node = document.createElement(tag); node.id = id; parent.appendChild(node); return node;
};
for (const id of [
  "term", "term-head", "th-avatar", "th-chip", "th-copy", "th-meta", "th-name", "th-rename",
  "rp", "rp-empty", "rp-empty-big", "rp-empty-sub", "scroll-btn",
]) el("div", id);
globalThis.getComputedStyle = () => ({
  paddingLeft: "0", paddingRight: "0", paddingTop: "0", paddingBottom: "0",
});
globalThis.ResizeObserver = class { observe() {} disconnect() {} };

let terminal;
class FakeTerminal {
  constructor(options) {
    terminal = this;
    this.options = { ...options };
    this.cols = options.cols; this.rows = options.rows;
    this.buffer = { active: { viewportY: 0, baseY: 0, getLine: () => null } };
    this.modes = { bracketedPasteMode: true };
    this._core = {
      _renderService: { dimensions: { css: { cell: { width: 8, height: 16 } } } },
      viewport: { scrollBarWidth: 0 },
    };
  }
  open(host) {
    const viewport = document.createElement("div"); viewport.className = "xterm-viewport"; host.appendChild(viewport);
    this.textarea = document.createElement("textarea"); host.appendChild(this.textarea);
  }
  attachCustomKeyEventHandler() {}
  onData(fn) { this.dataHandler = fn; }
  onScroll() {}
  onResize() { return { dispose() {} }; }
  registerLinkProvider() {}
  reset() {}
  clear() {}
  write(_data, done) { if (done) done(); }
  resize(cols, rows) { this.cols = cols; this.rows = rows; }
  scrollToBottom() {}
  focus() { this.textarea.focus(); }
}
window.Terminal = FakeTerminal;

const { store } = await import("../public/js/store.js");
const { connectWs } = await import("../public/js/ws.js");
const { initTerminal, commitTerminalDraft } = await import("../public/js/ui/terminal.js");
const { pastePayload } = await import("../public/js/ui/paste.js");
const { openSessionMenu } = await import("../public/js/ui/session-menu.js");

let pass = 0, fail = 0;
const ok = (name, condition) => {
  if (condition) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name); }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  initTerminal(); connectWs(); await sleep(5);
  const snapshot = (bracketedPaste) => ({
    type: "session.created", sessionId: "A", provider: "claude-code", cwd: "/a", name: "alpha",
    live: true, pid: 1, bracketedPaste,
  });
  store.applyEvent(snapshot());
  await sleep(5); ws.clear();

  let prevented = false, stopped = false;
  document.getElementById("term")._fire("paste", {
    target: terminal.textarea,
    clipboardData: { getData: () => "first\r\nsecond\rthird\x1b[201~fourth" },
    preventDefault: () => { prevented = true; },
    stopPropagation: () => { stopped = true; },
  });
  const pasted = ws.last("input");
  ok("native paste is captured before xterm", prevented && stopped);
  ok("paste is one input frame", ws.sent.filter((m) => m.type === "input").length === 1);
  ok("line endings normalize inside one bracketed transaction",
    pasted && pasted.data === "\x1b[200~first\nsecond\nthirdfourth\x1b[201~");

  store.applyEvent(snapshot(false)); ws.clear(); prevented = false; stopped = false;
  document.getElementById("term")._fire("paste", {
    target: terminal.textarea,
    clipboardData: { getData: () => "raw reader" },
    preventDefault: () => { prevented = true; },
    stopPropagation: () => { stopped = true; },
  });
  ok("engine-reported apps without bracketed-paste mode stay on xterm's native path",
    !prevented && !stopped && !ws.last("input"));
  store.applyEvent(snapshot(true));

  terminal.modes.bracketedPasteMode = false; ws.clear(); prevented = false; stopped = false;
  const longPaste = `first\n${"x".repeat(70_000)}\nPASTE-END`;
  document.getElementById("term")._fire("paste", {
    target: terminal.textarea,
    clipboardData: { getData: () => longPaste },
    preventDefault: () => { prevented = true; },
    stopPropagation: () => { stopped = true; },
  });
  ok("long replay tails cannot disable atomic paste",
    prevented && stopped && ws.sent.filter((m) => m.type === "input").length === 1
      && ws.last("input")?.data === pastePayload(longPaste));

  ws.clear();
  terminal.dataHandler("\r");
  ok("a real Enter remains a separate raw input", ws.last("input").data === "\r");
  ok("shared paste helper strips both embedded boundary controls",
    pastePayload("a\x1b[200~b\x1b[201~c") === "\x1b[200~abc\x1b[201~");
  const spliced = pastePayload("a\x1b[2\x1b[201~01~b");
  ok("removing a marker cannot splice fragments into a new end marker",
    spliced === "\x1b[200~ab\x1b[201~");

  ws.clear();
  ok("plugin draft commits to the exact active session without auto-send",
    commitTerminalDraft("draft\ntext", { sessionId: "A" }) && ws.last("input")?.data === "\x1b[200~draft\ntext\x1b[201~");
  ws.clear();
  ok("plugin can explicitly submit after one safe bracketed transaction",
    commitTerminalDraft("send this", { sessionId: "A", submit: true }) && ws.last("input")?.data === "\x1b[200~send this\x1b[201~\r");
  ws.clear();
  ok("wrong-session and oversized drafts never reach the PTY",
    !commitTerminalDraft("wrong", { sessionId: "B" }) && !commitTerminalDraft("x".repeat(65537), { sessionId: "A" }) && !ws.last("input"));

  const navigatorObject = globalThis.navigator || {};
  Object.defineProperty(navigatorObject, "clipboard", {
    configurable: true, value: { readText: async () => "menu\r\npaste" },
  });
  if (!globalThis.navigator) globalThis.navigator = navigatorObject;
  ws.clear();
  openSessionMenu({ x: 1, y: 1 }, "A", { live: true });
  document.querySelectorAll(".menu-item")[1]._fire("click");
  await sleep(5);
  ok("the session-menu Paste action uses the same safe transaction",
    ws.last("input").data === "\x1b[200~menu\npaste\x1b[201~");

  console.log(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
} catch (error) {
  console.log("THREW", error && error.stack || error); fail++;
}
process.exit(fail === 0 ? 0 : 1);
