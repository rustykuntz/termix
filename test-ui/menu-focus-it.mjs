// IT — sidebar popovers restore focus by opening modality: pointer users return to xterm so Escape can
// interrupt the agent; keyboard/screen-reader users return to the trigger. Drives the REAL sidebar,
// menu, terminal onData, ws.send, store, and a real isolated shell PTY over a tiny fake xterm/DOM.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { installFakeDom } from "./fakedom.mjs";

const dom = installFakeDom();
const require = createRequire(import.meta.url);
const WebSocket = require("ws");
const { HeadlessServer } = require("../src/server");
const scratch = mkdtempSync(join(tmpdir(), "clideck-menu-focus-"));
const server = new HeadlessServer({
  port: 0, cwd: process.cwd(), dataDir: join(scratch, "data"), autoSaveMs: 0,
});
const address = await server.listen();
globalThis.WebSocket = WebSocket;
globalThis.location = { host: `${address.host}:${address.port}` };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (predicate, timeoutMs, label) => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timeout: ${label}`);
    await sleep(25);
  }
};
const el = (tag, id, parent = document.body) => {
  const node = document.createElement(tag);
  node.id = id;
  parent.appendChild(node);
  return node;
};

const list = el("div", "list");
el("div", "list-empty", list);
for (const id of [
  "tab-all", "tab-unread", "search-clear", "notify-btn", "prompts-btn", "settings-btn", "proj-btn",
  "unread-cnt", "conn", "conn-text", "save-ind", "new-btn", "engine-banner", "engine-banner-text",
  "term-head", "th-avatar", "th-chip", "th-copy", "th-meta", "th-name", "th-rename",
  "rp", "rp-empty", "rp-empty-big", "rp-empty-sub", "scroll-btn",
]) el("div", id);
el("input", "search");
el("div", "term");
const sideHead = el("div", "");
sideHead.className = "side-head";
const newWrap = el("div", "", sideHead);
newWrap.className = "new-wrap";

globalThis.getComputedStyle = () => ({
  paddingLeft: "0", paddingRight: "0", paddingTop: "0", paddingBottom: "0",
});
globalThis.ResizeObserver = class { observe() {} disconnect() {} };

let terminal;
class FakeTerminal {
  constructor(options) {
    terminal = this;
    this.options = { ...options };
    this.cols = options.cols;
    this.rows = options.rows;
    this.buffer = { active: { viewportY: 0, baseY: 0, getLine: () => null } };
    this._core = {
      _renderService: { dimensions: { css: { cell: { width: 8, height: 16 } } } },
      viewport: { scrollBarWidth: 0 },
    };
  }
  open(host) {
    const viewport = document.createElement("div");
    viewport.className = "xterm-viewport";
    host.appendChild(viewport);
    this.textarea = document.createElement("textarea");
    this.textarea.className = "xterm-helper-textarea";
    host.appendChild(this.textarea);
  }
  attachCustomKeyEventHandler(fn) { this.keyHandler = fn; }
  onData(fn) { this.dataHandler = fn; }
  onScroll() {}
  onResize() { return { dispose() {} }; }
  registerLinkProvider() {}
  hasSelection() { return false; }
  getSelection() { return ""; }
  reset() {}
  clear() {}
  write(_data, done) { if (done) done(); }
  resize(cols, rows) { this.cols = cols; this.rows = rows; }
  scrollToBottom() {}
  focus() { this.textarea.focus(); }
  pressEscape() {
    const event = {
      type: "keydown", key: "Escape", code: "Escape", keyCode: 27,
      ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
      preventDefault() {}, stopPropagation() {},
    };
    if (!this.keyHandler || this.keyHandler(event) !== false) this.dataHandler("\x1b");
  }
}
window.Terminal = FakeTerminal;

const { store } = await import("../public/js/store.js");
const { connectWs, createSession, send } = await import("../public/js/ws.js");
const { initSidebar } = await import("../public/js/ui/sidebar.js");
const { initTerminal } = await import("../public/js/ui/terminal.js");

let pass = 0;
let fail = 0;
const ok = (name, condition) => {
  if (condition) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name); }
};

try {
  initSidebar();
  initTerminal();
  connectWs();
  await until(() => store.connected, 2000, "websocket connect");
  createSession("shell", process.cwd(), "Escape");
  await until(() => [...store.sessions.values()].some((session) => session.name === "Escape"), 5000, "shell session");
  const session = [...store.sessions.values()].find((entry) => entry.name === "Escape");
  await sleep(5);

  const trigger = document.querySelector(".r-menu-btn");
  ok("session row and menu trigger rendered", !!trigger);
  ok("new-session focus seam still focuses xterm", document.activeElement === terminal.textarea);

  // Pointer click → Escape dismisses the menu back to xterm; the next Escape traverses the real
  // terminal.onData callback and ws.send as byte 0x1b.
  trigger._fire("click", { detail: 1 });
  ok("pointer-opened menu takes focus", document.activeElement !== trigger && document.activeElement !== terminal.textarea);
  dom.docFire("keydown", { key: "Escape", preventDefault() {} });
  ok("pointer-close restores xterm", document.activeElement === terminal.textarea);

  // Put the real shell PTY into single-byte mode; its od output is conclusive that xterm's Escape
  // survived the real WebSocket and engine input path as 0x1b.
  send({
    type: "input", sessionId: session.id,
    data: "stty -echo -icanon min 1 time 0; od -An -tx1 -N1; stty sane\r",
  });
  await sleep(300);
  terminal.pressEscape();
  await until(() => /(?:^|\s)1b(?:\s|$)/m.test(store.sessions.get(session.id)?.outputBuf || ""), 5000, "PTY hex 1b");
  ok("next Escape reaches the real PTY as byte 0x1b", /(?:^|\s)1b(?:\s|$)/m.test(store.sessions.get(session.id)?.outputBuf || ""));

  // Keyboard-generated click has detail=0 → preserve the accessible trigger-return contract.
  trigger.focus();
  trigger._fire("click", { detail: 0 });
  dom.docFire("keydown", { key: "Escape", preventDefault() {} });
  ok("keyboard-close restores the trigger", document.activeElement === trigger);

  // Existing modal guard: while a modal sits above a menu, Escape remains owned by the modal.
  trigger._fire("click", { detail: 1 });
  document.body.classList.add("cd-modal-open");
  dom.docFire("keydown", { key: "Escape", preventDefault() {} });
  ok("modal guard keeps the underlying menu open", !!document.querySelector(".menu"));
  document.body.classList.remove("cd-modal-open");
  dom.docFire("keydown", { key: "Escape", preventDefault() {} });
  ok("menu closes normally after modal guard clears", !document.querySelector(".menu"));

  console.log(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
} catch (error) {
  console.log("THREW", error && error.stack || error);
  fail++;
} finally {
  await server.close();
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(fail === 0 ? 0 : 1);
