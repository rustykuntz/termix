// IT — the sidebar footer's identity.
//
// ⚠️ THIS SHIPPED AS A HARDCODED NAME. `index.html` carried `<div class="av">or</div><span class="who">Or ·
// local</span>` and no code ever touched it, so every user of a released build would have read somebody else's
// name in their own sidebar. Found in the 09-10 release check, not by a test — nothing asserted that the
// footer had anything to do with the person using it.
//
// The rule now: the footer follows the About me profile, and says "You" until there is a profile. That makes
// it a LABEL rather than a claim, which is what the About me contract requires — a blank profile is not
// shared, so the footer must not invent a name to show.
import { installFakeDom, installFakeWs } from "./fakedom.mjs";
installFakeDom();
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform: "MacIntel", userAgent: "", clipboard: {} } });
installFakeWs();
const mk = (id) => { const e = document.createElement("div"); e.id = id; document.body.appendChild(e); return e; };
const list = mk("list"); list.appendChild(mk("list-empty"));
for (const id of ["tab-all", "tab-unread", "search", "search-clear", "notify-btn", "prompts-btn", "settings-btn", "unread-cnt", "conn", "conn-text", "save-ind", "new-btn", "proj-btn", "theme-btn"]) mk(id);
const sideHead = document.createElement("div"); sideHead.className = "side-head";
const nw = document.createElement("div"); nw.className = "new-wrap"; sideHead.appendChild(nw); document.body.appendChild(sideHead);
// The footer as index.html ships it — neutral, not anyone's name.
const foot = document.createElement("div"); foot.className = "side-foot";
const av = document.createElement("div"); av.className = "av"; av.textContent = "y";
const who = document.createElement("span"); who.className = "who"; who.textContent = "You · local";
foot.append(av, who); document.body.appendChild(foot);

const { connectWs } = await import("../public/js/ws.js");
const { store } = await import("../public/js/store.js");
const { initSidebar } = await import("../public/js/ui/sidebar.js");

const checks = [];
const ok = (name, pass) => { checks.push([name, !!pass]); console.log((pass ? "  ok   " : "  FAIL ") + name); };
const sleep = (ms = 8) => new Promise((r) => setTimeout(r, ms));
const config = (about) => store.applyEvent({ type: "config", config: { projects: [], commands: [], ...(about === undefined ? {} : { about }) } });
const shown = () => ({ who: who.textContent, av: av.textContent });

try {
  connectWs(); await sleep();
  initSidebar();

  // ⚠️ The markup itself is part of the contract. A test that only checks the repaint would still pass with a
  // name baked into index.html, because the first frame repaints it away — but a user with no profile, or a
  // client that never gets a config, would sit looking at it.
  ok("the shipped markup names nobody", shown().who === "You · local" && shown().av === "y");

  config({});
  ok("an empty profile leaves it neutral rather than blank", shown().who === "You · local" && shown().av === "y");
  ok("…and specifically does NOT say Or", !/\bOr\b/.test(shown().who));

  config({ name: "Dana" });
  ok("a profile name is what the footer shows", shown().who === "Dana · local");
  ok("…and the avatar takes its initial", shown().av === "d");

  config({ name: "  Rivka  " });
  ok("a padded name is trimmed, not shown with its spaces", shown().who === "Rivka · local" && shown().av === "r");

  config({ name: "" });
  ok("clearing the profile returns the footer to You, it does not keep the old name",
    shown().who === "You · local" && shown().av === "y");

  config({ name: "Dana" });
  config(undefined);
  ok("a config with no about at all is also You — an absent profile is not a remembered one",
    shown().who === "You · local");

  // The footer says "· local" about the ENGINE, not about the person, so it survives every name.
  config({ name: "Dana" });
  ok("whatever the name, the footer still says where the engine is", / · local$/.test(shown().who));
} catch (error) {
  ok("suite ran to completion", false);
  console.log(error && error.stack || error);
}

const failed = checks.filter(([, pass]) => !pass);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
