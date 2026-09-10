// IT — @@ agent mentions are offered PROJECT-FIRST (Or's ask): agents in the ACTIVE session's project come
// before everyone else. Drives the REAL @@ trigger through prompts.js handleTerminalKey (two '@' keydowns
// inside the 300ms window) and reads the ACTUAL dropdown rows, so the user-visible order is what's asserted.
//
// The rule under test is a STABLE PARTITION, not a re-rank: inside each group today's semantics must survive
// unchanged (name-hit above address-only-hit, ties keep list order), and it must apply to the unfiltered list too.
import { installFakeDom, installFakeWs } from "./fakedom.mjs";
const dom = installFakeDom();
const ws = installFakeWs();

const { store } = await import("../public/js/store.js");
const { connectWs } = await import("../public/js/ws.js");
const { handleTerminalKey, closePromptDropdown } = await import("../public/js/ui/prompts.js");

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const key = (k) => handleTerminalKey({ type: "keydown", key: k, preventDefault() {} });
// the real trigger: two '@' within 300ms (the first passes through, the second opens the menu)
function openMentions(filter = "") {
  closePromptDropdown();
  key("x"); key(" ");            // a space before the trigger — a printable char would suppress it
  key("@"); key("@");
  for (const ch of filter) key(ch);
  return [...document.querySelectorAll(".pl-ac-item .pl-ac-name")].map((n) => n.innerHTML.replace(/<[^>]+>/g, ""));
}
const live = (id, name, projectId) => store.applyEvent({
  type: "session.created", sessionId: id, protocol: 1, provider: "claude-code",
  name, pid: 1, cwd: "/w", cols: 80, rows: 24, live: true, projectId,
});

try {
  connectWs(); await sleep(5);
  store.applyEvent({ type: "config", config: { projects: [
    { id: "pa", name: "Alpha", path: "/a", color: "#111", collapsed: false },
    { id: "pb", name: "Beta", path: "/b", color: "#222", collapsed: false },
  ] } });

  // Insertion order deliberately interleaves projects so a correct partition has to REORDER, not just pass through.
  live("s1", "beta-one", "pb");
  live("s2", "alpha-one", "pa");
  live("s3", "loose-one", null);
  live("s4", "beta-two", "pb");
  live("s5", "alpha-two", "pa");
  live("s6", "loose-two", null);

  // ── active session in project Alpha ──
  store.select("s2");
  let names = openMentions();
  ok("unfiltered list is partitioned, not just filtered", names.length === 6);
  ok("Alpha agents come first when the active session is in Alpha", names.slice(0, 2).join(",") === "alpha-one,alpha-two");
  ok("everyone else follows, in their original list order", names.slice(2).join(",") === "beta-one,loose-one,beta-two,loose-two");

  // ── switching project changes the grouping, nothing else ──
  store.select("s1");
  names = openMentions();
  ok("Beta agents lead when the active session is in Beta", names.slice(0, 2).join(",") === "beta-one,beta-two");
  ok("the rest keep list order", names.slice(2).join(",") === "alpha-one,loose-one,alpha-two,loose-two");

  // ── an ad-hoc (project-less) active session groups with the other ad-hoc sessions ──
  store.select("s3");
  names = openMentions();
  ok("ad-hoc active session leads with the other ad-hoc sessions", names.slice(0, 2).join(",") === "loose-one,loose-two");
  document.querySelectorAll(".pl-ac-item")[1]._fire("mousedown", { preventDefault() {} });
  ok("completing an ad-hoc mention inserts its full cwd-group address", (() => {
    const m = ws.last("input");
    return m && m.data === "\x1b[200~@w/loose-two \x1b[201~";
  })());

  // ── filtering still ranks name-hits above address-only hits INSIDE each group ──
  store.select("s2");                       // back to Alpha
  live("s7", "zzz", "pa");                  // name misses "one"; its @Alpha/zzz address misses too
  live("s8", "one-by-address", "pb");
  names = openMentions("one");
  ok("filter applies, project-first still holds", names[0] === "alpha-one" && names.includes("beta-one"));
  ok("no non-matching agent leaks into the filtered list", !names.includes("zzz") && !names.includes("alpha-two"));

  // name-hit outranks address-only-hit within the SAME group
  store.select("s5");                       // active in Alpha
  names = openMentions("alpha");           // alpha-* hit by NAME; "zzz" hits only via its @Alpha/zzz ADDRESS
  ok("name hits lead address-only hits inside the current-project group",
     names[0].startsWith("alpha-") && names.indexOf("zzz") > names.indexOf("alpha-two"));

  // ══ // prompts: project-first by USE (per-project MRU), same stable-partition shape ══
  closePromptDropdown();
  store.applyEvent({ type: "config", config: { projects: [
    { id: "pa", name: "Alpha", path: "/a", color: "#111", collapsed: false },
    { id: "pb", name: "Beta", path: "/b", color: "#222", collapsed: false } ],
    prompts: [ { id: "p1", name: "aaa", text: "one" }, { id: "p2", name: "bbb", text: "two" }, { id: "p3", name: "ccc", text: "three" } ] } });
  const openPrompts = (filter = "") => {
    closePromptDropdown();
    key("x"); key(" "); key("/"); key("/");
    for (const ch of filter) key(ch);
    return [...document.querySelectorAll(".pl-ac-item .pl-ac-name")].map((n) => n.innerHTML.replace(/<[^>]+>/g, ""));
  };
  store.select("s2");                                   // active in project Alpha
  ok("prompts start in library order (MRU empty)", openPrompts().join(",") === "aaa,bbb,ccc");
  // use the 3rd prompt here → it should lead in THIS project only
  document.querySelectorAll(".pl-ac-item")[2]._fire("mousedown", { preventDefault() {} });
  ok("using a prompt records it for this project", (store.promptMru["pa"] || [])[0] === "p3");
  ok("used prompt leads in the project where it was used", openPrompts()[0] === "ccc");
  ok("the rest keep library order behind it", openPrompts().slice(1).join(",") === "aaa,bbb");
  store.select("s1");                                   // switch to project Beta
  ok("a DIFFERENT project is unaffected", openPrompts().join(",") === "aaa,bbb,ccc");
  store.select("s3");                                   // ad-hoc session → its own bucket
  ok("ad-hoc sessions get their own bucket", openPrompts().join(",") === "aaa,bbb,ccc");

  closePromptDropdown();
  console.log(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
} catch (e) { console.log("THREW", e && e.stack || e); fail++; }
process.exit(fail === 0 ? 0 : 1);
