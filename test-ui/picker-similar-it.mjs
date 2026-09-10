// IT — the "Similar matches" tail on `//` and `@@`.
//
// The literal pipeline's order is guarded next door in `picker-order-it.mjs`. This file is about the tail:
// that it holds only what the literal pass REJECTED, that it is ranked by CLOSENESS with project/MRU breaking
// only an equal score — the same shape the literal pass itself has had since the 09-09 ladder fix — that it is capped, that it never reads a prompt
// BODY, that it is announced rather than blended in, that the selection cannot be left pointing at a row
// which changed underneath it, and that completing a guess inserts exactly what the real item says.
//
// ⚠️ EVERY ASSERTION READS ONE RENDER. Calling the opener again inside a check re-renders the dropdown, so
// a later assertion silently measures a different list than the one it names — the body and cap checks in
// the first draft of this file were reading the `@@` list while claiming to test `//`. `snap()` takes one
// picture and every check reads that picture.
//
// ⚠️ SCORES ARE NOT HARDCODED. The scorer is the main programmer's (`public/js/search-similarity.js`) and
// its numbers are theirs to change. Where order-by-score matters, this file CALLS the scorer and asserts the
// rendered order agrees with it, so the check tests the contract rather than a snapshot of the arithmetic.
import { installFakeDom, installFakeWs } from "./fakedom.mjs";
const dom = installFakeDom();
const ws = installFakeWs();

const { store } = await import("../public/js/store.js");
const { connectWs } = await import("../public/js/ws.js");
const { handleTerminalKey, closePromptDropdown } = await import("../public/js/ui/prompts.js");
const { spellingScore } = await import("../public/js/search-similarity.js");

let pass = 0, fail = 0;
const ok = (n, c, extra) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n + (extra !== undefined ? "  [" + extra + "]" : "")); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = (k) => handleTerminalKey({ type: "keydown", key: k, preventDefault() {} });
const text = (el) => el.innerHTML.replace(/<[^>]+>/g, "");

// ONE picture of the dropdown. Everything a check needs comes from here, read in a single pass.
function snap(trigger, query = "") {
  closePromptDropdown();
  key("x"); key(" ");
  key(trigger); key(trigger);
  for (const ch of query) key(ch);
  const items = [...document.querySelectorAll(".pl-ac-item")];
  const named = (el) => text(el.querySelector(".pl-ac-name"));
  return {
    all: items.map(named),
    exact: items.filter((el) => !el._cls.has("similar")).map(named),
    similar: items.filter((el) => el._cls.has("similar")).map(named),
    labels: [...document.querySelectorAll(".pl-ac-group")].map((el) => el.textContent),
    selected: (() => { const el = document.querySelector(".pl-ac-item.sel .pl-ac-name"); return el ? text(el) : null; })(),
  };
}
const slash = (q) => snap("/", q);
const at = (q) => snap("@", q);
const live = (id, name, projectId) => store.applyEvent({
  type: "session.created", sessionId: id, protocol: 1, provider: "claude-code",
  name, pid: 1, cwd: "/w", cols: 80, rows: 24, live: true, projectId,
});
const literal = (q, name) => name.toLowerCase().includes(q.toLowerCase());
const nonIncreasing = (scores) => scores.every((s, i) => i === 0 || scores[i - 1] >= s);

try {
  connectWs(); await sleep(5);
  const PROMPTS = [
    { id: "p1", name: "deploy checklist", text: "Walk the release steps." },
    { id: "p2", name: "deployment notes", text: "Where the environments live." },
    // The trap for body matching: the NAME shares nothing with the query, the BODY is full of it.
    { id: "p3", name: "release ritual", text: "deploy deploy deploy the deployment to deploy again." },
    { id: "p4", name: "summarise", text: "Three lines." },
    // Six eligible near misses for "delpoy", so the cap has something to cut. None contains it literally.
    { id: "p5", name: "deploys twice", text: "Filler." },
    { id: "p6", name: "deployer role", text: "Filler." },
    { id: "p7", name: "deployed once", text: "Filler." },
    { id: "p8", name: "deploying now", text: "Filler." },
    { id: "p9", name: "deployable art", text: "Filler." },
    { id: "pa", name: "deployless run", text: "Filler." },
    // Contains the typo LITERALLY, so a typo query still produces an exact hit and both groups appear in
    // one render. Without it every result is a guess and "an exact hit comes first" has nothing to compare.
    { id: "pb", name: "delpoyed by hand", text: "Deliberate literal typo fixture." },
  ];
  const BASE = {
    projects: [
      { id: "pa", name: "Alpha", path: "/a", color: "#111", collapsed: false },
      { id: "pb", name: "Beta", path: "/b", color: "#222", collapsed: false },
    ],
    prompts: PROMPTS,
  };
  const config = (extra = {}) => store.applyEvent({ type: "config", config: { ...BASE, ...extra } });
  config();
  live("s1", "alpha-one", "pa");
  live("s2", "beta-one", "pb");
  live("s3", "loose-one", null);
  store.select("s1");

  // ── ONE render, read many times ────────────────────────────────────────────────────────────────────
  const typo = slash("delpoy");
  ok("a typo produces a tail", typo.similar.length > 0, JSON.stringify(typo.all));
  ok("the exact group is still first and the guesses follow it",
    typo.all.join(",") === typo.exact.concat(typo.similar).join(","), JSON.stringify(typo.all));
  ok("no row appears twice across the two groups",
    new Set(typo.all).size === typo.all.length, JSON.stringify(typo.all));

  // ⚠️ NEVER PROMPT BODIES — read from the SAME render as everything above.
  // "release ritual" shares nothing with the query by NAME, and its body is nothing but near misses of it.
  // The exact pass cannot match it (the body holds "deploy", the query is "delpoy"), so if it appears at
  // all it can only have come from scoring a BODY — which is the thing this must never do.
  ok("a prompt whose BODY is full of near misses is not offered — names only",
    !typo.all.includes("release ritual"), JSON.stringify(typo.all));

  // ── the cap, with more eligible candidates than the cap allows ─────────────────────────────────────
  const eligible = PROMPTS.filter((p) => !p.name.includes("delpoy") && spellingScore("delpoy", p.name) > 0);
  ok("the fixture really does offer more near misses than the cap allows",
    eligible.length >= 6, `${eligible.length} eligible: ${JSON.stringify(eligible.map((p) => p.name))}`);
  ok("and exactly five are shown", typo.similar.length === 5, `${typo.similar.length}: ${JSON.stringify(typo.similar)}`);

  // ── ranked by CLOSENESS, checked against the scorer itself ─────────────────────────────────────────
  const byName = new Map(PROMPTS.map((p) => [p.name, p]));
  ok("the guesses are ordered by score, best first",
    nonIncreasing(typo.similar.map((n) => spellingScore("delpoy", n))),
    JSON.stringify(typo.similar.map((n) => [n, spellingScore("delpoy", n)])));

  // ── ⚠️ agents are rebuilt per call, so identity dedupe would silently do nothing ───────────────────
  // `getAgents()` returns FRESH objects each call, so the exact list and the candidate list hold DIFFERENT
  // objects for the same agent. Dedupe is by id; this check fails outright if it is ever by identity.
  const agents = at("alpha-on");
  ok("an agent matched exactly is never repeated as a guess — dedupe is by id, not identity",
    agents.exact.includes("alpha-one") && !agents.similar.includes("alpha-one")
    && new Set(agents.all).size === agents.all.length, JSON.stringify(agents));
  const swapped = at("alhpa");
  ok("a transposed agent name is found", swapped.similar.includes("alpha-one"), JSON.stringify(swapped.all));

  // ── short queries are left alone ───────────────────────────────────────────────────────────────────
  // The buffer grows one keystroke at a time, so the user passes through length 1-3 every time. A tail
  // there would churn the list under their fingers on the way to the query they meant.
  let churn = true, detail = "";
  for (const q of ["d", "de", "dep"]) { const s = slash(q); if (s.similar.length) { churn = false; detail = `${q} -> ${JSON.stringify(s.similar)}`; } }
  ok("no guesses below four characters", churn, detail);
  // ⚠️ Four characters AND no exact hit: "depl" is a substring of nine of these names, so it matches
  // everything exactly and leaves nothing to guess. "delp" is the same four letters swapped.
  ok("and they begin at exactly four", slash("delp").similar.length > 0, JSON.stringify(slash("delp").all));

  // ── announced, not blended in ──────────────────────────────────────────────────────────────────────
  ok("the guesses sit under their own heading", typo.labels.join("|") === "Similar matches", typo.labels.join("|"));
  ok("the heading is not a selectable row", document.querySelectorAll(".pl-ac-group.pl-ac-item").length === 0);
  const only = slash("summar");
  ok("an exact-only result shows no heading at all",
    only.labels.length === 0 && only.all.join(",") === "summarise", JSON.stringify(only));

  // ── CLOSENESS LEADS; project/MRU only breaks an equal score ────────────────────────────────────────
  // Two guesses whose scores genuinely DIFFER, with the WEAKER one marked as recently used here. The
  // stronger must still lead — a guess further from what you typed must never be lifted for belonging to
  // your project. The pair is chosen by asking the scorer, not by assuming its arithmetic.
  // ⚠️ A ONE-EDIT QUERY TIES EVERYTHING. The score is normalised, so every candidate one edit away scores
  // identically and there is no "stronger" to test with — which is what the first draft of this check ran
  // into. "delpoyed" is long enough for two edits, so the candidates genuinely separate. The pair is
  // derived from the scorer, never assumed.
  const ranked = PROMPTS.map((p) => ({ p, s: spellingScore("delpoyed", p.name) }))
    .filter((r) => r.s > 0 && !literal("delpoyed", r.p.name)).sort((a, b) => b.s - a.s);
  const strongest = ranked[0], weaker = ranked.find((r) => r.s < strongest.s);
  ok("the fixture contains two guesses with genuinely different scores",
    !!weaker, JSON.stringify(ranked.map((r) => [r.p.name, r.s])));
  ok("and an exact hit for the same query, so both groups are in one render",
    PROMPTS.some((p) => literal("delpoyed", p.name)));
  if (weaker) {
    config({ promptMru: { pa: [weaker.p.id] } });
    const biased = slash("delpoyed");
    ok("a WEAKER guess used in this project does not overtake a stronger one",
      biased.similar.indexOf(strongest.p.name) < biased.similar.indexOf(weaker.p.name),
      JSON.stringify(biased.similar));
    // And the clause that matters most: an exact hit outside the project still beats a guess inside it.
    ok("an exact hit still comes before every guess, project membership notwithstanding",
      biased.exact.length > 0 && biased.all.indexOf(biased.exact[biased.exact.length - 1]) < biased.all.indexOf(biased.similar[0]),
      JSON.stringify(biased.all));
    config({ promptMru: {} });
  }
  // Equal scores are where the preference is allowed to decide.
  const equal = eligible.map((p) => ({ p, s: spellingScore("delpoy", p.name) })).sort((a, b) => b.s - a.s);
  const tied = equal.filter((r) => r.s === equal[0].s);
  if (tied.length >= 2) {
    config({ promptMru: { pa: [tied[1].p.id] } });
    const t = slash("delpoy");
    ok("among EQUALLY close guesses, the one used in this project leads",
      t.similar.indexOf(tied[1].p.name) < t.similar.indexOf(tied[0].p.name), JSON.stringify(t.similar));
    config({ promptMru: {} });
  } else {
    ok("among EQUALLY close guesses, the one used in this project leads — no tied pair in this fixture", false,
      JSON.stringify(equal.map((r) => [r.p.name, r.s])));
  }

  // ── the selection must not survive a query change ──────────────────────────────────────────────────
  // `acSelected` names a POSITION, not an item, and a query change can reorder the list. Going back to the
  // first result keeps Enter following the search rather than whatever now sits at that index.
  closePromptDropdown();
  key("x"); key(" "); key("/"); key("/");
  for (const ch of "dep") key(ch);
  key("ArrowDown"); key("ArrowDown");
  const moved = document.querySelector(".pl-ac-item.sel .pl-ac-name");
  ok("the arrows really do move the selection off the top", moved && text(moved) !== text(document.querySelector(".pl-ac-item .pl-ac-name")),
    moved ? text(moved) : "none");
  key("l");
  const afterType = document.querySelector(".pl-ac-item.sel .pl-ac-name");
  ok("typing another character resets the selection to the top",
    afterType && text(afterType) === text(document.querySelector(".pl-ac-item .pl-ac-name")), afterType ? text(afterType) : "none");
  key("ArrowDown"); key("Backspace");
  const afterBack = document.querySelector(".pl-ac-item.sel .pl-ac-name");
  ok("and so does a backspace",
    afterBack && text(afterBack) === text(document.querySelector(".pl-ac-item .pl-ac-name")), afterBack ? text(afterBack) : "none");

  // ── completing a GUESS inserts the real item, unchanged ────────────────────────────────────────────
  // The whole risk of a suggestion is that it inserts an approximation of what you typed. It must insert
  // the item's own text and address, byte for byte.
  closePromptDropdown();
  key("x"); key(" "); key("/"); key("/");
  for (const ch of "delpoy") key(ch);
  const firstGuess = [...document.querySelectorAll(".pl-ac-item")].filter((el) => el._cls.has("similar"))[0];
  const guessName = text(firstGuess.querySelector(".pl-ac-name"));
  const guessPrompt = byName.get(guessName);
  const steps = [...document.querySelectorAll(".pl-ac-item")].indexOf(firstGuess);
  for (let i = 0; i < steps; i++) key("ArrowDown");
  ws.clear();
  key("Enter");
  const pasted = ws.last("input");
  ok("Enter on a guess pastes that prompt's OWN text, not the query",
    !!pasted && pasted.data.includes(guessPrompt.text) && !pasted.data.includes("delpoy"),
    JSON.stringify({ name: guessName, data: pasted && pasted.data }));

  closePromptDropdown();
  key("x"); key(" "); key("@"); key("@");
  for (const ch of "alhpa") key(ch);
  const guessAgent = [...document.querySelectorAll(".pl-ac-item")].filter((el) => el._cls.has("similar"))[0];
  const agentSteps = [...document.querySelectorAll(".pl-ac-item")].indexOf(guessAgent);
  const agentSub = text(guessAgent.querySelector(".pl-ac-text"));
  for (let i = 0; i < agentSteps; i++) key("ArrowDown");
  ws.clear();
  key("Tab");
  const mentioned = ws.last("input");
  ok("Tab on a guessed agent inserts that agent's real address, untouched",
    !!mentioned && mentioned.data.includes(agentSub) && !mentioned.data.includes("alhpa"),
    JSON.stringify({ address: agentSub, data: mentioned && mentioned.data }));

  closePromptDropdown();
} catch (error) {
  fail++; console.log("  FAIL threw: " + (error && error.stack || error));
}
console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
