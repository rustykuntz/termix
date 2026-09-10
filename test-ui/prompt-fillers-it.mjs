// IT — the two saved-prompt placeholders, and the one thing about them that is easy to get wrong.
//
// ⚠️ {{session_name}} EXPANDS TO THE FULL ADDRESS — `@clideck-next/main programmer`, not the bare
// `main programmer`. Or's correction (09-09): it is the same string @@ mentions and Copy address use.
//
// The value comes from `askAddress`, the one function behind all three, so the checks below assert those call
// sites agree rather than pinning a hand-built string in three places.
// Everything here is resolved AT PASTE TIME, so switching or renaming the active session changes the next
// paste with no re-save: those are the checks that would catch a well-meaning "cache it once" refactor.
import { installFakeDom, installFakeWs } from "./fakedom.mjs";
installFakeDom();
const ws = installFakeWs();

const { store } = await import("../public/js/store.js");
const { connectWs } = await import("../public/js/ws.js");
const { askAddress } = await import("../public/js/util.js");
const { openPromptLibrary, handleTerminalKey, closePromptDropdown } = await import("../public/js/ui/prompts.js");

const checks = [];
const ok = (name, pass) => { checks.push([name, !!pass]); console.log((pass ? "  ok   " : "  FAIL ") + name); };
const sleep = (ms = 8) => new Promise((r) => setTimeout(r, ms));

const P_ASK = { id: "p-ask", name: "Hand it over", text: "ask {{session_name}} to review {{project_name}}" };
const P_ODD = { id: "p-odd", name: "Odd braces", text: "{{agent_name}} and {{ session_name }} and {{}}" };
const seed = (extra = {}) => store.applyEvent({
  type: "config",
  config: {
    projects: [{ id: "pn", name: "clideck-next", path: "/w/clideck-next", color: "#111", collapsed: false },
               { id: "pv", name: "voice-agent-photos", path: "/w/voice", color: "#222", collapsed: false }],
    commands: [], prompts: [P_ASK, P_ODD], ...extra,
  },
});
const live = (id, name, projectId, cwd = "/w/clideck-next") => store.applyEvent({
  type: "session.created", sessionId: id, protocol: 1, provider: "claude-code",
  name, pid: 1, cwd, cols: 80, rows: 24, live: true, projectId,
});
// What actually reached the PTY, unwrapped from its bracketed-paste envelope.
const pasted = () => { const m = ws.last("input"); return m ? String(m.data).replace(/\[20[01]~/g, "") : null; };
const rows = () => [...document.querySelectorAll(".pl-row")];
const rowNamed = (name) => rows().find((r) => r.querySelector(".pl-name").textContent === name);
// The library through the user's own path: open it, click the prompt, which pastes and closes.
function pasteViaLibrary(name) { ws.clear(); openPromptLibrary(); rowNamed(name)._fire("click"); }
// The // picker through the REAL trigger: two '/' inside the 300ms window, then Enter on the top match.
const key = (k) => handleTerminalKey({ type: "keydown", key: k, preventDefault() {} });
function pasteViaSlash(filter) {
  ws.clear(); closePromptDropdown();
  key("x"); key(" ");
  key("/"); key("/");
  for (const ch of filter) key(ch);
  key("Enter");
}

try {
  connectWs(); await sleep();
  seed();
  live("s1", "main programmer", "pn");
  live("s2", "UI", "pn");
  live("s3", "loose", null, "/w/scratch");
  store.select("s1");

  // ── the address, not the name ───────────────────────────────────────────
  pasteViaLibrary("Hand it over");
  ok("a prompt pasted from the library reaches the terminal", typeof pasted() === "string" && pasted().length > 0);
  ok("{{session_name}} expands to the FULL address, scope and all",
    pasted() === "ask @clideck-next/main programmer to review clideck-next", pasted());
  ok("…so the paste carries the scope, not just the name",
    !/ask main programmer to/.test(pasted()) && pasted().includes("@clideck-next/main programmer"), pasted());
  ok("…and it is the SAME string askAddress gives everyone else — @@, the row menu, this",
    pasted().includes(askAddress(store.sessions.get("s1"), store.projects)));
  ok("{{project_name}} is untouched by the change — still the plain project name",
    pasted().endsWith("review clideck-next") && !pasted().includes("review @"));

  // ── the // picker shares the filler, it does not have its own ───────────
  pasteViaSlash("Hand it");
  ok("the // picker pastes through the same filler as the modal",
    pasted() === "ask @clideck-next/main programmer to review clideck-next", pasted());

  // ── paste TIME, not save time ───────────────────────────────────────────
  store.select("s2");
  pasteViaLibrary("Hand it over");
  ok("switching the active session changes what the SAME saved prompt pastes",
    pasted() === "ask @clideck-next/UI to review clideck-next", pasted());
  // A rename arrives as a session.created re-broadcast for the same id.
  live("s2", "Reviewer", "pn");
  pasteViaLibrary("Hand it over");
  ok("renaming the session changes the next paste, with nothing re-saved",
    pasted() === "ask @clideck-next/Reviewer to review clideck-next", pasted());
  store.select("s3");
  pasteViaLibrary("Hand it over");
  ok("an ad-hoc session with no project still gets a real address — its cwd group is the scope",
    pasted() === "ask @scratch/loose to review scratch", pasted());
  // askAddress falls back to the id; shortId (the old value) was display-only.
  live("s4", "", "pn");
  store.select("s4");
  pasteViaLibrary("Hand it over");
  ok("an unnamed session falls back to its id, the way every other address does",
    pasted() === "ask @clideck-next/s4 to review clideck-next", pasted());

  // ── everything else in the braces is left alone ─────────────────────────
  store.select("s1");
  pasteViaLibrary("Odd braces");
  ok("an undocumented filler is passed through verbatim, never blanked",
    pasted().startsWith("{{agent_name}} and ") && pasted().endsWith(" and {{}}"), pasted());
  ok("…while a spaced {{ session_name }} is still filled", pasted().includes("@clideck-next/main programmer"));

  // ── the copy tells the user which of the two they are getting ───────────
  openPromptLibrary();
  document.querySelector(".pl-help-btn")._fire("click");
  const help = document.querySelector(".pl-help").textContent;
  ok("the help card says session_name is the full ask address, and shows its shape",
    /full ask address/i.test(help) && /@Project\/name/.test(help));
  ok("…and still describes project_name as the project or working-folder name",
    /project \(or working-folder\) name/i.test(help));
  // The editor is where a prompt is WRITTEN, so the placeholder is the only hint that arrives unasked-for.
  document.querySelector(".pl-newbtn")._fire("click");
  const ph = document.querySelector(".pl-ed-text").placeholder;
  ok("the new-prompt box names both fillers where a prompt is actually written",
    /\{\{session_name\}\}/.test(ph) && /\{\{project_name\}\}/.test(ph), ph);
  ok("…and says session_name means the FULL address, not the name", /full @Project\/name address/i.test(ph), ph);
} catch (error) {
  ok("suite ran to completion", false);
  console.log(error && error.stack || error);
}

const failed = checks.filter(([, pass]) => !pass);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
