// UI IT — the terminal header's two title interactions.
//
// 1. The TITLE copies the session's ask address. The separate copy button is gone, so the title is the only
//    place that does it, and renaming lives wholly on the pencil beside it.
// 2. Ending a rename ALWAYS puts the title back. It did not: updateHeader repaints the title only when its
//    identity signature changes, and cancelling — or a rename the engine refuses — changes nothing, so the
//    input stayed on screen with no way out. The duplicate check was blind for the same journey: the header
//    passed a bare cwd string where a {cwd, projectId} scope was expected.
import { installFakeDom } from "./fakedom.mjs";
installFakeDom();

const add = (tag, id, parent = document.body) => { const node = document.createElement(tag); node.id = id; parent.appendChild(node); return node; };
for (const id of ["term", "term-head", "th-avatar", "th-chip", "th-meta", "th-name", "th-rename", "th-rename-msg", "rp", "rp-empty", "rp-empty-big", "rp-empty-sub", "scroll-btn"]) add("div", id);
const context = add("div", "th-context"); context.hidden = true;
add("i", "th-context-fill", context); add("span", "th-context-value", context);
const last = add("div", "th-last"); last.hidden = true; add("span", "th-last-value", last);
document.getElementById("th-rename-msg").hidden = true;
globalThis.getComputedStyle = () => ({ paddingLeft: "0", paddingRight: "0", paddingTop: "0", paddingBottom: "0" });
globalThis.ResizeObserver = class { observe() {} disconnect() {} };

let copied = "";
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async (t) => { copied = t; } } } });

class FakeTerminal {
  constructor(options) {
    this.options = { ...options }; this.cols = options.cols; this.rows = options.rows; this.modes = { bracketedPasteMode: true };
    this.buffer = { active: { viewportY: 0, baseY: 0, getLine: () => null } };
    this._core = { _renderService: { dimensions: { css: { cell: { width: 8, height: 16 } } } }, viewport: { scrollBarWidth: 0 } };
    this.parser = { registerOscHandler() {} };
  }
  open(host) { const vp = add("div", "", host); vp.className = "xterm-viewport"; this.textarea = add("textarea", "", host); }
  attachCustomKeyEventHandler() {} onData() {} onScroll() {} onResize() { return { dispose() {} }; } registerLinkProvider() {} reset() {} clear() {}
  write(_data, done) { done?.(); } resize(cols, rows) { this.cols = cols; this.rows = rows; }
  scrollToBottom() {} focus() {}
}
window.Terminal = FakeTerminal;

const { store } = await import("../public/js/store.js");
const { initTerminal } = await import("../public/js/ui/terminal.js");

const checks = [];
const ok = (name, pass, extra) => { checks.push([name, !!pass]); console.log((pass ? "  ok   " : "  FAIL ") + name + (pass || extra === undefined ? "" : "  [" + extra + "]")); };
const tick = (ms = 4) => new Promise((resolve) => setTimeout(resolve, ms));
const name = () => document.getElementById("th-name");
const renameBtn = () => document.getElementById("th-rename");
const errMsg = () => document.getElementById("th-rename-msg");
const input = () => name().querySelector(".name-input");

initTerminal();
store.applyEvent({ type: "session.created", sessionId: "A", provider: "claude-code", name: "architecture", cwd: "/work", projectId: "p1", live: true, pid: 4321 });
store.applyEvent({ type: "session.created", sessionId: "B", provider: "codex", name: "programmer", cwd: "/work", projectId: "p1", live: true, pid: 4322 });
store.applyEvent({ type: "config", config: { projects: [{ id: "p1", name: "clideck", cwd: "/work" }] } });
store.select("A");

// ── the title is the copy control ────────────────────────────────────────────────────────────────
ok("the header no longer carries a separate copy button", !document.getElementById("th-copy"));
ok("the title advertises what clicking it does", /Copy ask address/.test(name().title), name().title);
name()._fire("click"); await tick();
ok("clicking the title copies the session's ask address", copied === "@clideck/architecture", copied);
ok("and the title flashes to confirm it", name().classList.contains("copied"));
copied = "";
name()._fire("keydown", { key: "Enter", preventDefault() {} });
await tick();
ok("the title is reachable from the keyboard too", copied === "@clideck/architecture", copied);

// ── the pencil becomes a cancel control while editing ─────────────────────────────────────────────
copied = "";
renameBtn()._fire("click"); await tick();
ok("the pencil opens an inline editor on the title", !!input() && input().value === "architecture");
ok("and turns into an explicit way out", renameBtn().classList.contains("editing") && renameBtn().title === "Cancel rename");
ok("clicking the title while editing does not also copy", (name()._fire("click"), copied === ""));

// A mouse press on the ✕ must not blur the input first — blur COMMITS, so the cancel would have saved.
let defaultPrevented = false;
renameBtn()._fire("mousedown", { preventDefault() { defaultPrevented = true; } });
ok("pressing the ✕ suppresses the blur that would otherwise commit the edit", defaultPrevented);

input().value = "renamed-by-x";
renameBtn()._fire("click"); await tick();
ok("the ✕ cancels: the editor closes", !input());
ok("the ✕ cancels: the name is untouched", store.sessions.get("A").name === "architecture");
ok("the title is painted back even though nothing about the session changed", name().textContent.trim() === "architecture");
ok("and the button is a pencil again", !renameBtn().classList.contains("editing") && renameBtn().title === "Rename session");

// ── Escape is the same journey, and used to leave the input stranded ──────────────────────────────
renameBtn()._fire("click"); await tick();
input().value = "renamed-by-escape";
input()._fire("keydown", { key: "Escape", preventDefault() {}, stopPropagation() {} });
await tick();
ok("Escape closes the editor and restores the title", !input() && name().textContent.trim() === "architecture");

// ── Enter commits ────────────────────────────────────────────────────────────────────────────────
renameBtn()._fire("click"); await tick();
input().value = "renamed-by-enter";
input()._fire("keydown", { key: "Enter", preventDefault() {}, stopPropagation() {} });
await tick();
ok("Enter closes the editor", !input() && !renameBtn().classList.contains("editing"));
store.applyEvent({ type: "session.created", sessionId: "A", provider: "claude-code", name: "renamed-by-enter", cwd: "/work", projectId: "p1", live: true, pid: 4321 });
ok("Enter committed the new name", name().textContent.trim() === "renamed-by-enter");
ok("and the copy address follows the new name", /Copy ask address — @clideck\/renamed-by-enter/.test(name().title), name().title);

// ── a name already used in the project is refused, visibly, without closing the editor ────────────
renameBtn()._fire("click"); await tick();
input().value = "programmer";
input()._fire("input", {});
ok("a duplicate name is caught as it is typed", input().classList.contains("invalid"));
ok("with the reason shown beside the box you are typing in", errMsg().hidden === false && /already used/i.test(errMsg().textContent), errMsg().textContent);
input()._fire("keydown", { key: "Enter", preventDefault() {}, stopPropagation() {} });
await tick();
ok("Enter on a duplicate keeps the editor open rather than silently doing nothing", !!input());
ok("and never sends the rename", store.sessions.get("A").name === "renamed-by-enter");
input()._fire("keydown", { key: "Escape", preventDefault() {}, stopPropagation() {} });
await tick();
ok("leaving the editor clears the message", errMsg().hidden === true && errMsg().textContent === "");
ok("the pid caption is untouched by rename errors", document.getElementById("th-meta").textContent === "pid 4321");

const failed = checks.filter(([, pass]) => !pass);
console.log(`\n${failed.length ? "✗" : "✓"} ${checks.length - failed.length}/${checks.length} terminal header checks passed`);
process.exit(failed.length ? 1 : 0);
