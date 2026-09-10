// UI IT — the terminal's right-click menu is a TEXT menu (copy / paste / read aloud), not the session menu.
// Read-aloud is not hardcoded: it arrives as a plugin action, so it is driven here as one.
import { installFakeDom } from "./fakedom.mjs";

const dom = installFakeDom();
const { store } = await import("../public/js/store.js");
const { openTerminalMenu, openSessionMenu } = await import("../public/js/ui/session-menu.js");
const { closeMenu } = await import("../public/js/ui/menu.js");

let pass = 0, fail = 0;
const ok = (name, condition, extra) => {
  if (condition) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "  [" + extra + "]" : "")); }
};
const labels = () => [...document.querySelectorAll(".menu .menu-item")].map((e) => e.textContent.trim());
const disabledOf = (label) => {
  const el = [...document.querySelectorAll(".menu .menu-item")].find((e) => e.textContent.trim() === label);
  return el ? !!el.disabled : null;
};

try {
  store.applyEvent({ type: "session.created", sessionId: "T1", provider: "shell", cwd: "/a", name: "term", live: true, pid: 7 });

  // ── the terminal menu, with a selection and the voice plugin contributing ──────────────────────
  let spoke = "";
  openTerminalMenu({ x: 40, y: 40 }, "T1", {
    selection: "npm run build failed", live: true,
    pluginItems: [{ label: "Read selection aloud", onSelect: (c) => { spoke = "said"; c.close(); } }],
  });
  const withSel = labels();
  ok("exactly three items: Copy, Paste, Read selection aloud",
    withSel.length === 3 && withSel.join("|") === "Copy|Paste|Read selection aloud", withSel.join("|"));
  for (const gone of ["Rename", "Delete", "Theme…", "Restart session", "Mute", "Copy @address", "Remove from project"])
    ok(`the session action "${gone}" is not in the terminal menu`, !withSel.includes(gone), withSel.join("|"));
  ok("Copy is enabled when there is a selection", disabledOf("Copy") === false);
  const readItem = [...document.querySelectorAll(".menu .menu-item")].find((e) => e.textContent.trim() === "Read selection aloud");
  readItem._fire("click");
  ok("Read selection aloud runs the plugin action", spoke === "said", spoke);
  ok("and choosing it closes the menu", !document.querySelector(".menu"));

  // ── no selection: Copy is disabled, and the plugin contributes nothing ─────────────────────────
  openTerminalMenu({ x: 40, y: 40 }, "T1", { selection: "", live: true, pluginItems: [] });
  ok("with no selection the menu is just Copy and Paste", labels().join("|") === "Copy|Paste", labels().join("|"));
  ok("and Copy is disabled rather than silently doing nothing", disabledOf("Copy") === true);
  closeMenu();

  // ── a dormant session has no PTY, so Paste has nowhere to go ──────────────────────────────────
  openTerminalMenu({ x: 40, y: 40 }, "T1", { selection: "x", live: false, pluginItems: [] });
  ok("Paste is disabled on a dormant session", disabledOf("Paste") === true);
  closeMenu();

  // ── the ROW menu is untouched — Or's "the session panel is perfect" ────────────────────────────
  openSessionMenu({ x: 40, y: 40 }, "T1", { selection: "", live: true, muted: false });
  const row = labels();
  for (const kept of ["Copy", "Paste", "Rename", "Copy @address", "Mute", "Theme…", "Restart session", "Delete"])
    ok(`the row menu still offers "${kept}"`, row.includes(kept), row.join("|"));
  ok("the two menus are genuinely different", row.length > withSel.length, `${row.length} vs ${withSel.length}`);
  closeMenu();

  console.log(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
} catch (error) {
  console.log("THREW", (error && error.stack) || error); fail++;
}
process.exit(fail === 0 ? 0 : 1);
