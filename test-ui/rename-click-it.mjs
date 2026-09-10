// IT — clicking INSIDE an open rename field must not act on the surface behind it.
//
// The report: press the pencil on a session row, then click anywhere in the name to move the caret, and the
// edit closes. The row's own click handler selects the session; selecting emits "active", the terminal
// refocuses, the input blurs — and `inlineRename` commits on blur. So a click meant to place a caret ended
// the edit and saved. Every OTHER control on the row already stops propagation (copy, pencil, ▾); the field
// the helper drops in did not.
//
// ⚠️ `_fire` runs one element's listeners and stops. This bug is entirely about a click REACHING an ancestor,
// so it is invisible to `_fire` — the checks below use `bubbleFire`, which walks the chain like a browser.
import { installFakeDom, installFakeWs, bubbleFire } from "./fakedom.mjs";
installFakeDom();
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform: "MacIntel", userAgent: "", clipboard: {} } });
installFakeWs();
const mk = (id) => { const e = document.createElement("div"); e.id = id; document.body.appendChild(e); return e; };
const list = mk("list"); list.appendChild(mk("list-empty"));
for (const id of ["tab-all", "tab-unread", "search", "search-clear", "notify-btn", "prompts-btn", "settings-btn", "unread-cnt", "conn", "conn-text", "save-ind", "new-btn", "proj-btn", "theme-btn"]) mk(id);
const sideHead = document.createElement("div"); sideHead.className = "side-head";
const nw = document.createElement("div"); nw.className = "new-wrap"; sideHead.appendChild(nw); document.body.appendChild(sideHead);

const { connectWs } = await import("../public/js/ws.js");
const { store } = await import("../public/js/store.js");
const { initSidebar } = await import("../public/js/ui/sidebar.js");
const { inlineRename } = await import("../public/js/util.js");

const checks = [];
const ok = (name, pass) => { checks.push([name, !!pass]); console.log((pass ? "  ok   " : "  FAIL ") + name); };
const sleep = (ms = 8) => new Promise((r) => setTimeout(r, ms));
const row = () => document.querySelector(".row");
const input = () => document.querySelector(".name-input");

try {
  connectWs(); await sleep();
  initSidebar();
  store.applyEvent({ type: "config", config: { projects: [], commands: [] } });
  store.applyEvent({ type: "session.created", sessionId: "s1", provider: "shell", cwd: "/work", name: "alpha", live: true, pid: 7, status: "idle" });
  store.applyEvent({ type: "session.created", sessionId: "s2", provider: "shell", cwd: "/work", name: "beta", live: true, pid: 8, status: "idle" });
  await sleep();
  store.select("s2");                              // the row we rename is NOT the active one, so a stray select shows
  ok("two rows rendered", document.querySelectorAll(".row").length === 2);

  // ── the reported journey ────────────────────────────────────────────────
  const target = [...document.querySelectorAll(".row")].find((r) => r.dataset.id === "s1") || row();
  target.querySelector(".r-rename-btn")._fire("click");
  ok("the pencil opens an inline editor", !!input() && target.classList.contains("renaming"));

  let actives = 0;
  const off = store.on("active", () => { actives++; });
  bubbleFire(input(), "click");
  ok("clicking inside the field does NOT select the session behind it", actives === 0);
  ok("…so the editor is still open", !!document.querySelector(".name-input") && target.classList.contains("renaming"));
  ok("…and the active session is unchanged", store.activeId === "s2");

  // A press is the half that arms a drag and, on other rows, the half every control already suppresses.
  bubbleFire(input(), "mousedown");
  ok("a press inside the field does not reach the row either", actives === 0 && !!document.querySelector(".name-input"));

  // The field must still be a field: typing, Enter and Escape are untouched by the guard.
  input().value = "renamed";
  input()._fire("keydown", { key: "Enter", preventDefault() {}, stopPropagation() {} });
  ok("Enter still commits", !document.querySelector(".name-input"));
  off();

  // ── clicking the row itself still selects, or the guard went too far ────
  store.select("s2");
  let selected = 0;
  const off2 = store.on("active", () => { selected++; });
  bubbleFire(target, "click");
  ok("a click on the row with no edit open still selects it", selected === 1 && store.activeId === "s1");
  off2();

  // ── the same guarantee at the helper, for every caller ──────────────────
  const host = document.createElement("div");
  const parent = document.createElement("div");
  let parentClicks = 0;
  parent.addEventListener("click", () => { parentClicks++; });
  parent.appendChild(host); document.body.appendChild(parent);
  inlineRename(host, { value: "x", onCommit() {}, onCancel() {} });
  bubbleFire(host.querySelector(".name-input"), "click");
  bubbleFire(host.querySelector(".name-input"), "mousedown");
  ok("the helper's field shields its host from both events, for every call site", parentClicks === 0);
} catch (error) {
  ok("suite ran to completion", false);
  console.log(error && error.stack || error);
}

const failed = checks.filter(([, pass]) => !pass);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
