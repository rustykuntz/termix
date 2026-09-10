// UI IT — the relative-time ladder (DOM-free, so an IT is the right instrument) and the trimmed session
// menu. The dormant row's rendering and the name-lane width are browser facts and live in
// parity/probes/cdp-gate-rowtime.cjs instead; nothing here pretends to cover them.
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();
const { relTime, relTimeShort } = await import("../public/js/util.js");
const { store } = await import("../public/js/store.js");

let pass = 0, fail = 0;
const ok = (name, condition, extra) => {
  if (condition) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "  [" + extra + "]" : "")); }
};
const SEC = 1000, MIN = 60 * SEC, HOUR = 60 * MIN, DAY = 24 * HOUR;
const at = (ms) => Date.now() - ms;

try {
  // ── the ladder, prose ──────────────────────────────────────────────────────────────────────────
  const prose = [
    [10 * SEC, "now"], [44 * SEC, "now"],
    [3 * MIN, "3 minutes ago"], [30 * MIN, "30 minutes ago"],
    [59.6 * MIN, "59 minutes ago"],                    // FLOOR: rounding would say "60 minutes ago"
    [HOUR, "1 hour ago"], [5 * HOUR, "5 hours ago"], [23.9 * HOUR, "23 hours ago"],
    [DAY, "1 day ago"], [2 * DAY, "2 days ago"], [6.9 * DAY, "6 days ago"],
    [7 * DAY, "1 week ago"], [20 * DAY, "2 weeks ago"],
    [30 * DAY, "1 month ago"], [75 * DAY, "2 months ago"],
    [400 * DAY, "1 year ago"], [800 * DAY, "2 years ago"],
  ];
  for (const [ms, want] of prose) ok(`relTime ${want}`, relTime(at(ms)) === want, relTime(at(ms)));
  ok("relTime singular never says '1 minutes'", !/\b1 \w+s ago/.test(relTime(at(MIN))), relTime(at(MIN)));
  ok("relTime of nothing is empty, not 'now'", relTime(0) === "" && relTime(null) === "");

  // ── same ladder, compact ───────────────────────────────────────────────────────────────────────
  const short = [[10 * SEC, "now"], [3 * MIN, "3m"], [5 * HOUR, "5h"], [2 * DAY, "2d"],
                 [20 * DAY, "2w"], [75 * DAY, "2mo"], [800 * DAY, "2y"]];
  for (const [ms, want] of short) ok(`relTimeShort ${want}`, relTimeShort(at(ms)) === want, relTimeShort(at(ms)));
  ok("relTimeShort climbs past days — the old formatter said '45d' forever",
    relTimeShort(at(45 * DAY)) === "1mo", relTimeShort(at(45 * DAY)));
  ok("relTimeShort of nothing is empty", relTimeShort(0) === "" && relTimeShort(null) === "");

  // ── the engine's lastActive seeds the clock; a missing one must NOT become a fake timestamp ────
  const iso = new Date(at(3 * DAY)).toISOString();
  store.applyEvent({ type: "session.created", sessionId: "S1", provider: "shell", cwd: "/a", name: "stamped", live: false, lastActive: iso });
  store.applyEvent({ type: "session.created", sessionId: "S2", provider: "shell", cwd: "/a", name: "bare", live: false });
  const s1 = store.sessions.get("S1"), s2 = store.sessions.get("S2");
  ok("an engine lastActive is parsed onto the session", s1.lastActive === Date.parse(iso));
  ok("and it seeds lastActivity, so a reload does not reset every row to 'now'",
    relTimeShort(s1.lastActivity) === "3d", relTimeShort(s1.lastActivity));
  ok("no lastActive stays NULL — the dormant row shows nothing rather than lying", s2.lastActive === null);
  store.applyEvent({ type: "session.created", sessionId: "S1", provider: "shell", cwd: "/a", name: "stamped", live: true, pid: 9 });
  ok("a re-broadcast without the field does not wipe a real stamp", s1.lastActive === Date.parse(iso));

  // ── the session menu no longer carries a project picker ────────────────────────────────────────
  store.applyEvent({ type: "config", config: { projects: [{ id: "p1", name: "Alpha", color: "#3b82f6" }] } });
  const { __projectItemsForTest } = await import("../public/js/ui/session-menu.js");
  const labels = (items) => items.map((i) => i.label || i.html || "").join(" | ");
  const inProject = __projectItemsForTest("S1", { projectId: "p1" });
  const noProject = __projectItemsForTest("S2", { projectId: null });
  ok("no 'Move to project' caption anywhere", !/Move to project/.test(labels(inProject) + labels(noProject)),
    labels(inProject));
  ok("no per-project rows — moving is the drag now", !/Alpha/.test(labels(inProject)), labels(inProject));
  ok("'Remove from project' survives: a drag outside a project is deliberately a no-op",
    /Remove from project/.test(labels(inProject)), labels(inProject));
  ok("an ungrouped session gets NO project block at all", noProject.length === 0, String(noProject.length));

  console.log(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
} catch (error) {
  console.log("THREW", (error && error.stack) || error); fail++;
}
process.exit(fail === 0 ? 0 : 1);
