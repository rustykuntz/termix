// IT — Settings ▸ General ▸ About me (config.about). The whole point of this pane is a promise the user cannot
// inspect: "blank is never shared". So every check here is about the CONTRACT that leaves the client —
// what updateConfig actually carries — not about how the rows look.
//
// ⚠️ The time zone is the field that can lie. A select ALWAYS has a value, so the one seeded with the detected
// zone would ship a zone the user never chose. "Not shared" has to be a real, selected, first option.
import { installFakeDom, installFakeWs } from "./fakedom.mjs";
installFakeDom();
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform: "MacIntel", userAgent: "", clipboard: {} } });
const ws = installFakeWs();
for (const id of ["settings-btn", "theme-btn"]) { const el = document.createElement("button"); el.id = id; document.body.appendChild(el); }

const { connectWs } = await import("../public/js/ws.js");
const { store } = await import("../public/js/store.js");
const { openSettings } = await import("../public/js/ui/settings.js");

const checks = [];
const ok = (name, pass) => { checks.push([name, !!pass]); console.log((pass ? "  ok   " : "  FAIL ") + name); };
const sleep = (ms = 8) => new Promise((r) => setTimeout(r, ms));
const config = (extra = {}) => store.applyEvent({ type: "config", config: { projects: [], commands: [], ...extra } });
const sec = () => document.querySelector('[data-sec="about"]');
const nameEl = () => sec().querySelector("input.set-input");
const zoneEl = () => sec().querySelector("select.set-select");
const notesEl = () => sec().querySelector("textarea.set-textarea");
const countEl = () => sec().querySelector(".set-count");
const lastAbout = () => { const m = ws.last("config.update"); return m && m.config ? m.config.about : undefined; };
const detected = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { return ""; } })();

try {
  connectWs(); await sleep();

  // ── an empty profile ────────────────────────────────────────────────────
  config();
  openSettings();
  ok("About me is the FIRST section in General", document.querySelector(".set-body .set-section") === sec());
  ok("all three fields render, all three blank", nameEl().value === "" && zoneEl().value === "" && notesEl().value === "");
  ok("the time zone's selected option is a real 'Not shared', not the detected zone",
    zoneEl().value === "" && zoneEl()._childList[0].value === "" && zoneEl()._childList[0].textContent === "Not shared");
  // Or cut the long "shared with … and their AI services …" paragraph (09-09) — the pane is a profile, not a
  // consent form. The one disclosure that stays is the one the user cannot work out for themselves: a shell
  // that ignores a filled-in profile otherwise reads as the feature being broken.
  ok("it names who is excluded", /Not shared with/.test(sec().textContent) && /Shell/.test(sec().textContent) && /custom commands/.test(sec().textContent));
  ok("…and that is the ONLY disclosure left — the consent paragraph is gone",
    !/create, resume or restart a session/i.test(sec().textContent) && !/AI service/i.test(sec().textContent));
  // The tour used to spend a whole stop saying what this note says in four words, beside the title, where the
  // question is actually asked. Dropping the stop without adding the note would have lost the fact entirely.
  ok("the section title carries who it is shared with", sec().querySelector(".set-sec-h .set-sec-note") &&
    sec().querySelector(".set-sec-note").textContent === "shared with supported agents");
  ok("the notes counter is silent while the box is empty", countEl().textContent === "");
  // ⚠️ The box opens as ONE line and grows with what is typed. rows is the resting shape; the growth itself is
  // layout, which a headless DOM has none of, so this asserts the shape and the browser gate asserts the growth.
  ok("the notes box rests at a single line", notesEl().rows === 1);

  // ── the zone list is searchable the way people actually search ──────────
  // A native select's type-ahead matches the START of the label. Nobody hunting Bangkok types "Asia" first —
  // they type "b". So the label leads with the city, and the list is ORDERED by city or the matches scatter.
  const zoneOpts = () => zoneEl()._childList.slice(1);
  const cityOf = (z) => String(z).split("/").pop().replace(/_/g, " ");
  const listed = zoneOpts();
  ok("the browser's zones are listed at all", listed.length > 100);
  ok("every option's label LEADS with its city, and keeps the IANA id after it",
    listed.every((o) => o.textContent === (cityOf(o.value) === o.value ? o.value : cityOf(o.value) + " — " + o.value)));
  ok("a continent-first id is now found by its city", listed.some((o) => o.value === "Asia/Bangkok" && o.textContent === "Bangkok — Asia/Bangkok"));
  // ⚠️ Do not hard-code an example id — which zones exist, and how deep they nest, differs between engines.
  const nested = listed.filter((o) => o.value.split("/").length > 2);
  ok("a nested id leads with its LAST segment, not the country in the middle",
    nested.length > 0 && nested.every((o) => o.textContent.startsWith(cityOf(o.value) + " — ")));
  const underscored = listed.filter((o) => o.value.includes("_"));
  ok("underscores are spelled out — 'Rio Gallegos', never 'Rio_Gallegos'",
    underscored.length > 0 && underscored.every((o) => !o.textContent.split(" — ")[0].includes("_")));
  ok("a bare id is not doubled up", listed.every((o) => o.textContent !== o.value + " — " + o.value));
  ok("the list is sorted by city, so type-ahead lands in one run rather than scattering",
    listed.every((o, i) => i === 0 || cityOf(listed[i - 1].value).localeCompare(cityOf(o.value)) <= 0));
  // The real user story: press "b" and the first thing under the cursor is a B city, not America/Bahia.
  ok("typing 'b' reaches a city named B", /^B/.test(listed.find((o) => /^[Bb]/.test(o.textContent)).textContent));

  // ── the contract on the wire ────────────────────────────────────────────
  ws.clear();
  nameEl().value = "  Or  "; nameEl()._fire("input");
  await sleep(600);   // the save is 500ms-debounced, exactly like defaultCwd
  ok("a name save sends an about patch", lastAbout() && typeof lastAbout() === "object");
  ok("the name is trimmed", lastAbout().name === "Or");
  // ⚠️ The patch carries ONLY what was touched. Sending an untouched field back would let this tab overwrite
  // another tab's edit of it with a value nobody asked to change.
  ok("an untouched time zone is not in the patch at all", !("timeZone" in lastAbout()));
  ok("untouched notes are not in the patch either", !("notes" in lastAbout()));

  ws.clear();
  notesEl().value = "  Prefers short answers.  "; notesEl()._fire("input");
  ok("the counter appears as soon as there is text", countEl().textContent === notesEl().value.length + " / 500");
  await sleep(600);
  ok("notes are trimmed on the wire", lastAbout().notes === "Prefers short answers.");
  ok("…and the name it already saved rides along only because it too was edited here", lastAbout().name === "Or");

  // ── caps ────────────────────────────────────────────────────────────────
  ok("the name input caps at 80 characters", nameEl().maxLength === 80);
  ok("the notes box caps at 500 characters", notesEl().maxLength === 500);
  ws.clear();
  // maxLength is the browser's guard; the client must not RELY on it, because a paste-then-programmatic-set
  // (or any harness) can exceed it and the engine's limit would reject the whole patch.
  notesEl().value = "n".repeat(640); notesEl()._fire("input");
  await sleep(600);
  ok("an over-long note is cut to 500 by the client, not sent long and refused", lastAbout().notes.length === 500);
  ok("the counter flags a full box", countEl().classList.contains("full"));
  ws.clear();
  nameEl().value = "x".repeat(120); nameEl()._fire("input");
  await sleep(600);
  ok("an over-long name is cut to 80", lastAbout().name.length === 80);

  // ── the detected zone is a suggestion, never a default ──────────────────
  const hint = sec().querySelector(".set-tz");
  ok("the detected zone is offered as something to click", !hint.hidden && /Detected:/.test(hint.textContent) && hint.querySelector(".set-link"));
  ok("…and offering it did NOT select it", zoneEl().value === "");
  ws.clear();
  hint.querySelector(".set-link")._fire("click");
  ok("clicking 'use it' fills the field", zoneEl().value === detected);
  ok("filling it saves immediately — a select change is a decision, not typing", lastAbout() && lastAbout().timeZone === detected);
  // The click has to mark the field EDITED, or the draft keeps the previous choice and the next rebuild
  // silently undoes it.
  [...document.querySelectorAll(".set-cat")].find((el) => el.textContent === "Appearance")._fire("click");
  [...document.querySelectorAll(".set-cat")].find((el) => el.textContent === "General")._fire("click");
  ok("…and the filled zone survives a trip through another pane", zoneEl().value === detected);
  ok("the hint retires once the field already holds the detected zone", hint.hidden === true);

  // ── an existing profile round-trips ─────────────────────────────────────
  document.querySelector(".set-x")._fire("click"); await sleep(220);   // close() removes the node on a timer — reopening inside it would query the retiring overlay
  config({ about: { name: "Or", timeZone: "Asia/Jerusalem", notes: "Hebrew and English." } });
  openSettings();
  ok("a stored profile is shown back", nameEl().value === "Or" && zoneEl().value === "Asia/Jerusalem" && notesEl().value === "Hebrew and English.");
  ok("the counter reflects stored notes", countEl().textContent === notesEl().value.length + " / 500" && notesEl().value.length > 0);
  ws.clear();
  zoneEl().value = ""; zoneEl()._fire("change");
  ok("choosing 'Not shared' sends an EMPTY zone — a stored zone can be withdrawn", lastAbout().timeZone === "" && "timeZone" in lastAbout());

  // an unknown/older-engine zone must stay selectable rather than being silently reset to "Not shared"
  document.querySelector(".set-x")._fire("click"); await sleep(220);   // close() removes the node on a timer — reopening inside it would query the retiring overlay
  config({ about: { timeZone: "Mars/Olympus" } });
  openSettings();
  ok("a zone this browser does not list is kept and shown, not dropped", zoneEl().value === "Mars/Olympus");

  // ── a config echo must not eat the caret ────────────────────────────────
  document.querySelector(".set-x")._fire("click"); await sleep(220);   // close() removes the node on a timer — reopening inside it would query the retiring overlay
  config({ about: { name: "Or" } });
  openSettings();
  const before = notesEl();
  before.value = "half a sen"; before.focus();
  config({ about: { name: "Or" } });        // the engine's echo of an earlier save lands mid-word
  ok("an echo landing while About me has focus does NOT rebuild the pane under the caret", notesEl() === before && notesEl().value === "half a sen");
  document.body.classList.remove("x");
  document.activeElement.blur && document.activeElement.blur();
  document.activeElement = document.body;
  config({ about: { name: "Or", notes: "from the engine" } });
  ok("an echo with focus elsewhere DOES repaint from the store", notesEl() !== before && notesEl().value === "from the engine");

  // ── typing survives an echo and a trip through another pane ─────────────
  // Every rebuild of this pane reads the store. A field the user has TOUCHED is theirs until Settings closes;
  // one they have not still follows the store, so another tab's edit is not frozen out.
  document.querySelector(".set-x")._fire("click"); await sleep(220);
  config({ about: { name: "Or", notes: "stored note" } });
  openSettings();
  notesEl().value = "typed but not saved yet"; notesEl()._fire("input");
  document.activeElement = document.body;                       // focus has left; the pane WILL rebuild
  config({ about: { name: "Or", notes: "stored note" } });
  ok("a typed note survives a config echo that lands after the caret has gone", notesEl().value === "typed but not saved yet");
  ok("an untouched field still follows the store", nameEl().value === "Or");
  config({ about: { name: "Someone else", notes: "stored note" } });
  ok("…so another tab's change to an untouched field DOES arrive", nameEl().value === "Someone else");
  ws.clear();
  [...document.querySelectorAll(".set-cat")].find((el) => el.textContent === "Appearance")._fire("click");
  ok("leaving the pane flushes the pending save — the edit reaches the engine before the pane goes",
    lastAbout() && lastAbout().notes === "typed but not saved yet");
  [...document.querySelectorAll(".set-cat")].find((el) => el.textContent === "General")._fire("click");
  ok("…and the typed note is still there after a round trip through another pane", notesEl().value === "typed but not saved yet");

  // now leave one genuinely in flight, so closing has something to rescue
  notesEl().value = "still inside the debounce"; notesEl()._fire("input");
  ws.clear();
  document.querySelector(".set-x")._fire("click"); await sleep(220);
  ok("closing flushes the edit still sitting inside its debounce, rather than dropping it",
    lastAbout() && lastAbout().notes === "still inside the debounce");
  config({ about: { name: "Someone else", notes: "what the engine kept" } });
  openSettings();
  ok("a reopened pane is the store again — the draft does not outlive the surface", notesEl().value === "what the engine kept");
  document.querySelector(".set-x")._fire("click"); await sleep(220);
  config({ about: { name: "Or" } });
  openSettings();

  // ── the tour entry point lives here too ─────────────────────────────────
  const started = document.querySelector('[data-sec="started"]');
  ok("General ends with a quiet 'Take the tour' entry", started && /Take the tour/.test(started.textContent) && started.querySelector("button.set-action"));
  ok("…and it promises not to undo dismissed tips", /dismissed stay dismissed/i.test(started.textContent));
} catch (error) {
  ok("suite ran to completion", false);
  console.log(error && error.stack || error);
}

const failed = checks.filter(([, pass]) => !pass);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
