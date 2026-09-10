// IT — the sessions-panel preview is PURE: it reflects the agent's message (finalized turn / live agent line),
// never the raw terminal tail, so the user typing / deleting / pasting at the prompt can't corrupt it. Drives
// the ACTUAL store + sidebar.js on a fake-DOM sidebar.
import { installFakeDom } from "./fakedom.mjs";
const dom = installFakeDom();
function mkEl(id) { const e = document.createElement("div"); e.id = id; return e; }
const list = mkEl("list"); list.appendChild(mkEl("list-empty")); document.body.appendChild(list);
for (const id of ["tab-all", "tab-unread", "search", "search-clear", "notify-btn", "prompts-btn", "settings-btn", "proj-btn", "unread-cnt", "conn", "conn-text", "save-ind", "new-btn"]) document.body.appendChild(mkEl(id));
const sideHead = document.createElement("div"); sideHead.className = "side-head"; const nw = document.createElement("div"); nw.className = "new-wrap"; sideHead.appendChild(nw); document.body.appendChild(sideHead);

const { store } = await import("../public/js/store.js");
const { initSidebar } = await import("../public/js/ui/sidebar.js");

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n); } };
const rowFor = (sid) => dom.all("row").find((r) => r.dataset.id === sid) || null;
const childOf = (el, cls) => { const out = []; (function w(n) { for (const c of n.children) { if (c._cls && c._cls.has(cls)) out.push(c); w(c); } })(el); return out; };
const preview = (sid) => { const p = childOf(rowFor(sid), "r-preview")[0]; return p ? p.textContent : null; };
const turn = (id, role, text) => store.applyEvent({ type: "transcript.append", id, role, text });
const out = (id, data) => store.applyEvent({ type: "output", sessionId: id, data });

try {
  initSidebar();
  store.applyEvent({ type: "session.created", sessionId: "A", provider: "claude-code", name: "alpha", cwd: "/work/app", live: true, pid: 1 });
  store.applyEvent({ type: "status", sessionId: "A", state: "idle" });
  ok("agent row rendered", !!rowFor("A"));

  // a finalized agent turn IS the preview
  turn("A", "agent", "Here is the summary you asked for.");
  ok("finalized agent turn → preview shows it", preview("A") === "Here is the summary you asked for.");

  // the user typing / deleting / pasting echoes back as OUTPUT — the preview must NOT change
  out("A", "l"); out("A", "s"); out("A", " -la");                 // typing echoes
  ok("keystroke echo does NOT change the preview", preview("A") === "Here is the summary you asked for.");
  out("A", "\b \b\b \b");                                          // backspaces (delete)
  ok("delete/backspace echo does NOT change the preview", preview("A") === "Here is the summary you asked for.");
  out("A", "\x1b[200~pasted multi\nline text\x1b[201~");          // a bracketed paste
  ok("paste echo does NOT change the preview", preview("A") === "Here is the summary you asked for.");
  out("A", "\x1b[32muser@host\x1b[0m:~/work/app$ ");              // the shell/agent prompt line
  ok("a redrawn prompt line does NOT change the preview", preview("A") === "Here is the summary you asked for.");

  // a USER turn is not shown (only the agent's message is)
  turn("A", "user", "now do the other thing");
  ok("a user turn does NOT become the preview", preview("A") === "Here is the summary you asked for.");

  // the next agent turn updates it; agent.final too
  turn("A", "agent", "Done — 3 files changed.");
  ok("the next agent turn updates the preview", preview("A") === "Done — 3 files changed.");
  store.applyEvent({ type: "agent.final", sessionId: "A", text: "All set." });
  ok("agent.final updates the preview", preview("A") === "All set.");

  // a shell (no agent messages) shows a stable subtitle, never the live output line
  store.applyEvent({ type: "session.created", sessionId: "S", provider: "shell", name: "shell", cwd: "/Users/tester/proj", live: true, pid: 2 });
  store.applyEvent({ type: "status", sessionId: "S", state: "idle" });
  ok("shell preview is the cwd path, not output", preview("S") === "~/proj");
  out("S", "rm -rf build\r\n"); out("S", "\x1b[31merror\x1b[0m nonsense line");
  ok("shell output/echo does NOT become the preview", preview("S") === "~/proj");

  console.log(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
} catch (e) { console.log("THREW", e && e.stack || e); fail++; }
process.exit(fail === 0 ? 0 : 1);
