// Generic document kinds use the existing content.show → viewer registry → dock fetch path. This focused IT
// covers routing, safe bodies, malformed/fetch failures, and the existing replace/session-tab semantics.
import { installFakeDom } from "./fakedom.mjs";
installFakeDom();
const main = document.createElement("div"); main.className = "main"; document.body.appendChild(main);
const tabsEl = document.createElement("div"); tabsEl.id = "pane-tabs"; main.appendChild(tabsEl);
const bodyEl = document.createElement("div"); bodyEl.id = "pane-body"; main.appendChild(bodyEl);
const termPanel = document.createElement("div"); termPanel.id = "term-panel"; bodyEl.appendChild(termPanel);

const payloads = {
  "/content/text-1": { text: "booting…\n" + "a very long log field ".repeat(80) + "\ndone" },
  "/content/text-2": { text: "replacement text" },
  "/content/json-1": { text: '{"name":"CliDeck","items":[1,2],"safe":"<script>no</script>"}' },
  "/content/json-bad": { text: '{"unfinished":' },
};
globalThis.fetch = async (url) => {
  const payload = payloads[url];
  if (!payload) return { ok: false, status: 404, text: async () => "" };
  return { ok: true, status: 200, text: async () => payload.text };
};

const { store } = await import("../public/js/store.js");
const { initContentViewer } = await import("../public/js/ui/content-viewer.js");
const { renderableKind } = await import("../public/js/ui/content-dock.js");
let pass = 0, fail = 0;
const ok = (name, condition) => { if (condition) { pass++; console.log("  ok   " + name); } else { fail++; console.log("  FAIL " + name); } };
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const show = (contentId, kind, name, extra = {}) => store.applyEvent({ type: "content.show", sessionId: "A", contentId, kind, name, url: "/content/" + contentId, ...extra });
const docTabs = () => [...document.querySelectorAll(".cd-tab")].filter((tab) => !tab.classList.contains("cd-tab-term"));

try {
  store.applyEvent({ type: "session.created", sessionId: "A", cwd: "/a", name: "alpha", live: true, pid: 1 });
  store.applyEvent({ type: "session.created", sessionId: "B", cwd: "/b", name: "beta", live: true, pid: 2 });
  initContentViewer();
  ok("text and JSON are registered viewers, so they open as tabs", renderableKind("text") && renderableKind("json"));

  show("text-1", "text", "engine.log"); await flush();
  ok("text opens in the existing tab strip", docTabs().length === 1 && docTabs()[0].textContent.includes("engine.log") && termPanel.hidden === true);
  ok("text fetches byte-faithful into the wrapping document body", document.querySelector(".ct-text-body")?.textContent === payloads["/content/text-1"].text);

  show("json-1", "json", "state.json"); await flush();
  ok("JSON opens beside text and becomes the active formatted document", docTabs().length === 2 && !!document.querySelector(".ct-json-code") && document.querySelectorAll(".json-key").length === 3);
  ok("JSON content cannot inject DOM", !document.querySelector(".ct-json script") && document.querySelector(".ct-json-code").textContent.includes("<script>no</script>"));

  show("json-bad", "json", "broken.json"); await flush();
  ok("malformed JSON stays open with a clear recovery surface", docTabs().length === 3 && document.querySelector(".ct-json-error")?.getAttribute("role") === "alert" && document.querySelector(".ct-json-raw")?.textContent === payloads["/content/json-bad"].text);

  show("missing", "text", "gone.txt"); await flush();
  ok("fetch failure is contained in an accessible tab state", docTabs().length === 4 && document.querySelector(".cd-error")?.getAttribute("role") === "alert" && /HTTP 404/.test(document.querySelector(".cd-error")?.textContent || ""));

  show("text-2", "text", "engine.log", { replaces: "text-1" }); await flush();
  ok("replace swaps the existing text asset without adding a tab", docTabs().length === 4 && document.querySelector(".ct-text-body")?.textContent === "replacement text");
  store.select("B"); await flush();
  ok("another session remains isolated with its terminal bare", tabsEl.hidden === true && termPanel.hidden === false);
  store.select("A"); await flush();
  ok("switching back restores all generic document tabs", tabsEl.hidden === false && docTabs().length === 4);

  console.log(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
} catch (error) { console.log("THREW", error && error.stack || error); fail++; }
process.exit(fail === 0 ? 0 : 1);
