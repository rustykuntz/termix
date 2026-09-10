// IT — the session-name limit is 25, and it is ONE constant, not a number copied into three places.
//
// SESSION_NAME_MAX governs both what the inputs accept and how much of a name the row/header draw. The bug
// this guards is drift: someone hardcodes 18 (or 25) into one input, the cap and the display disagree, and a
// name silently loses its tail in exactly one surface. So every assertion below compares a surface against
// the CONSTANT rather than against the literal 25 — the one exception being the constant's own value, which
// is Or's decision and is pinned here deliberately.
//
// The row's LANE WIDTH is a separate question this cannot see: a 25-char name fits the store, the tooltip and
// the header, but at the 340px default sidebar the last characters ellipsize. That is measured in a real
// browser by parity/probes/cdp-gate-namewidth.cjs (threshold 352px) — a fake DOM has no font metrics.
import { installFakeDom } from "./fakedom.mjs";
const dom = installFakeDom();
function mkEl(id) { const e = document.createElement("div"); e.id = id; return e; }
const list = mkEl("list"); list.appendChild(mkEl("list-empty")); document.body.appendChild(list);
for (const id of ["tab-all", "tab-unread", "search", "search-clear", "notify-btn", "prompts-btn", "settings-btn", "proj-btn", "unread-cnt", "conn", "conn-text", "save-ind", "new-btn"]) document.body.appendChild(mkEl(id));
const sideHead = document.createElement("div"); sideHead.className = "side-head"; const nw = document.createElement("div"); nw.className = "new-wrap"; sideHead.appendChild(nw); document.body.appendChild(sideHead);

const { store } = await import("../public/js/store.js");
const { SESSION_NAME_MAX, limitSessionName } = await import("../public/js/util.js");
const { initSidebar } = await import("../public/js/ui/sidebar.js");
const { closeMenu } = await import("../public/js/ui/menu.js");

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n); } };
const rowFor = (sid) => dom.all("row").find((r) => r.dataset.id === sid) || null;
const childOf = (el, cls) => { const out = []; (function w(n) { for (const c of n.children) { if (c._cls && c._cls.has(cls)) out.push(c); w(c); } })(el); return out; };
const nameText = (sid) => { const t = childOf(rowFor(sid), "r-name-text")[0]; return t ? t.textContent : null; };

const N25 = "Frontend Refactor Session";        // exactly 25
const N26 = "Frontend Refactor Sessions";       // 26 — one over
const LONG = "A ridiculously long session name from the CLI";

try {
  ok("the fixtures are the lengths this suite claims", N25.length === 25 && N26.length === 26);

  // ── the constant itself — Or's call, pinned ──
  ok("SESSION_NAME_MAX is 25", SESSION_NAME_MAX === 25);

  // ── the slice ──
  ok("a name at the cap survives whole", limitSessionName(N25) === N25 && limitSessionName(N25).length === SESSION_NAME_MAX);
  ok("one character over is cut to the cap", limitSessionName(N26).length === SESSION_NAME_MAX);
  ok("the cut keeps the HEAD of the name (a tail cut would read as a different session)", limitSessionName(N26) === N25);
  ok("empty/undefined stay empty rather than throwing", limitSessionName("") === "" && limitSessionName(undefined) === "");

  initSidebar();
  const create = (sid, name) => store.applyEvent({ type: "session.created", sessionId: sid, provider: "shell", name, cwd: "/work/app", live: true, pid: 1 });

  // ── the row draws the whole name ──
  create("A", N25);
  store.applyEvent({ type: "status", sessionId: "A", state: "idle" });
  ok("a 25-char name renders in the row in full", nameText("A") === N25);

  // ── the engine has NO name cap of its own, so a longer name can arrive from the CLI ──
  create("B", LONG);
  store.applyEvent({ type: "status", sessionId: "B", state: "idle" });
  ok("a longer name from the wire is still displayed cut at the cap", nameText("B") === limitSessionName(LONG));
  ok("...and the store keeps the REAL name, so nothing is lost on the way back out", store.sessions.get("B").name === LONG);

  // ── the drift guard: every input that accepts a name reads the same constant ──
  {
    const t = childOf(rowFor("A"), "r-name-text")[0];
    t._fire("dblclick", { stopPropagation() {}, preventDefault() {} });
    const inp = document.querySelector(".r-name-text .name-input") || document.querySelector(".name-input");
    ok("row rename input opened", !!inp);
    ok("row rename input caps at SESSION_NAME_MAX (not a hardcoded number)", inp && inp.maxLength === SESSION_NAME_MAX);
    inp && inp._fire("keydown", { key: "Escape", stopPropagation() {}, preventDefault() {} });
  }
  {
    document.getElementById("new-btn")._fire("click", { currentTarget: document.getElementById("new-btn") });
    const inp = document.querySelector(".pv-name-input");
    ok("new-session name input opened", !!inp);
    ok("new-session name input caps at SESSION_NAME_MAX (not a hardcoded number)", inp && inp.maxLength === SESSION_NAME_MAX);
    closeMenu();
  }

  console.log(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
} catch (e) { console.log("THREW", e && e.stack || e); fail++; }
process.exit(fail === 0 ? 0 : 1);
