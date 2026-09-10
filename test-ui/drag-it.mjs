// IT — the session→project drag highlight must NOT reuse the file-veil's class. Regression guard for the
// class-name collision: drag.js tagged project group-heads with 'drop-zone', which is ALSO the bare file-drop
// veil (.drop-zone { position:absolute; inset:0; opacity:0 }) — so starting a session drag made the headers
// drop out of flow and vanish, and nothing was targetable. drag.js now uses 'drop-target'. This drives the real
// drag.js pointer gesture on a fake-DOM sidebar and asserts the headers get 'drop-target', never 'drop-zone'.
import { installFakeDom, installFakeWs } from "./fakedom.mjs";
installFakeDom();
installFakeWs();

const list = document.createElement("div"); list.className = "list"; document.body.appendChild(list);
function project(pid, sid) {
  const proj = document.createElement("div"); proj.className = "project is-project"; proj.dataset.projectId = pid;
  const head = document.createElement("div"); head.className = "group-head";
  const rows = document.createElement("div"); rows.className = "rows";
  const row = document.createElement("div"); row.className = "row"; row.dataset.id = sid;
  rows.appendChild(row); proj.append(head, rows); list.appendChild(proj);
  return { proj, head, row };
}
const p1 = project("proj-1", "A");
const p2 = project("proj-2", "B");

const { initDrag } = await import("../public/js/ui/drag.js");

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n); } };
const ev = (o) => ({ preventDefault() {}, ...o });

try {
  initDrag(list);
  // begin a session drag on row A, then move past the 5px threshold → startDrag()
  list._fire("pointerdown", ev({ button: 0, target: p1.row, clientX: 10, clientY: 10 }));
  list._fire("pointermove", ev({ target: p1.row, clientX: 44, clientY: 44 }));

  ok("session-drag start highlights BOTH project group-heads", p1.head._cls.has("drop-target") && p2.head._cls.has("drop-target"));
  ok("group-heads are NOT tagged 'drop-zone' (the file-veil class → they'd vanish)", !p1.head._cls.has("drop-zone") && !p2.head._cls.has("drop-zone"));
  ok("the dragged row is marked .dragging", p1.row._cls.has("dragging"));

  // end the drag (no drop target) → the highlight clears
  list._fire("pointerup", ev({ target: p1.row }));
  ok("pointerup clears the highlight from every header", !p1.head._cls.has("drop-target") && !p2.head._cls.has("drop-target"));
  ok("pointerup clears .dragging", !p1.row._cls.has("dragging"));

  console.log(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
} catch (e) { console.log("THREW", e && e.stack || e); fail++; }
process.exit(fail === 0 ? 0 : 1);
