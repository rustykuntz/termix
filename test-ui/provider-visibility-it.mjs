// Built-in visibility is one persisted picker preference: optimistic Settings toggles, config echo sync,
// custom-command preservation, and zero effect on existing live/dormant sessions or availability.
import { installFakeDom, installFakeWs } from "./fakedom.mjs";
installFakeDom();
const ws = installFakeWs();
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform: "MacIntel", userAgent: "", clipboard: {} } });

const mk = (tag, id, parent = document.body) => { const el = document.createElement(tag); el.id = id; parent.appendChild(el); return el; };
const list = mk("div", "list"); mk("div", "list-empty", list);
for (const id of ["tab-all", "tab-unread", "search", "search-clear", "notify-btn", "prompts-btn", "settings-btn", "unread-cnt", "conn", "conn-text", "save-ind", "proj-btn"]) mk("button", id);
const sideHead = document.createElement("div"); sideHead.className = "side-head"; const newWrap = document.createElement("div"); newWrap.className = "new-wrap"; sideHead.appendChild(newWrap); document.body.appendChild(sideHead);
const newBtn = mk("button", "new-btn");

const { store } = await import("../public/js/store.js");
const { connectWs } = await import("../public/js/ws.js");
const { initSidebar } = await import("../public/js/ui/sidebar.js");
const { openSettings } = await import("../public/js/ui/settings.js");
const { closeMenu } = await import("../public/js/ui/menu.js");
const { PROVIDER_LIST } = await import("../public/js/providers-ui.js");
const checks = [];
const ok = (name, pass) => { checks.push([name, !!pass]); console.log((pass ? "  ok   " : "  FAIL ") + name); };
const sleep = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
const config = (extra = {}) => store.applyEvent({ type: "config", config: { projects: [], commands: [], ...extra } });
const rowFor = (name) => [...document.querySelectorAll(".set-agent-row")].find((row) => row.querySelector(".set-agent-name")?.textContent === name);
const pickerLabels = () => [...document.querySelectorAll(".pv-opt .lbl")].map((el) => el.textContent);
function openPicker() { newBtn._fire("click", { currentTarget: newBtn, detail: 1 }); }
function selectNoneAndEnter() {
  const select = document.querySelector(".pv-project-select"); select.value = "__none__"; select._fire("change");
  document.querySelector(".pv-name-input")._fire("keydown", { key: "Enter" });
}

try {
  connectWs(); await sleep(); initSidebar();
  const custom = { id: "my-agent", label: "My Agent", icon: "terminal", command: "my-agent", enabled: true, isAgent: true, canResume: false, env: {} };
  config({ commands: [custom] });
  store.applyEvent({ type: "session.created", sessionId: "live-codex", provider: "codex", cwd: "/work", name: "Live Codex", live: true, pid: 10 });
  store.applyEvent({ type: "session.created", sessionId: "old-codex", provider: "codex", cwd: "/work", name: "Old Codex", live: false });
  store.applyEvent({ type: "availability.result", providers: [{ id: "codex", available: true, version: "1.2.3" }], commands: [{ id: "my-agent", available: true }] });

  openSettings(); [...document.querySelectorAll(".set-cat")].find((button) => button.textContent === "CLI Agents")._fire("click");
  ok("every built-in defaults to shown", document.querySelectorAll(".set-agent-row").length === PROVIDER_LIST.length && [...document.querySelectorAll(".set-agent-toggle .set-switch")].every((toggle) => toggle.getAttribute("aria-checked") === "true"));
  const codexToggle = rowFor("Codex").querySelector(".set-switch");
  ok("visibility control is compact, named and visibly explained", codexToggle.getAttribute("role") === "switch" && codexToggle.getAttribute("aria-label") === "Show Codex in New Session" && rowFor("Codex").querySelector(".set-agent-toggle").textContent.includes("Show in New Session"));

  ws.clear(); codexToggle._fire("click");
  const patch = ws.last("config.update");
  ok("hide is immediate and persists one minimal key", codexToggle.getAttribute("aria-checked") === "false" && store.hiddenProviders.includes("codex") && Object.keys(patch.config).join() === "hiddenProviders" && patch.config.hiddenProviders.join() === "codex");

  const sameCodexToggle = codexToggle;
  config({ hiddenProviders: ["codex", "gemini"], commands: [custom] });
  ok("config echo syncs switches without rebuilding in-flight agent settings", sameCodexToggle.isConnected && sameCodexToggle.getAttribute("aria-checked") === "false" && rowFor("Gemini").querySelector(".set-switch").getAttribute("aria-checked") === "false");
  ok("visibility does not mutate sessions or availability", store.sessions.get("live-codex")?.live === true && store.sessions.get("old-codex")?.live === false && store.availability.providers.get("codex")?.available === true);

  openSettings(); await sleep(180); // close Settings; its visual exit is intentionally animated
  openPicker();
  const labels = pickerLabels();
  ok("hidden built-ins disappear only from New Session", !labels.some((label) => label.startsWith("Codex")) && !labels.some((label) => label.startsWith("Gemini")));
  ok("custom commands remain visible", labels.some((label) => label.startsWith("My Agent")));
  store.applyEvent({ type: "availability.result", providers: [{ id: "codex", available: true }], commands: [{ id: "my-agent", available: true }] });
  ok("availability refresh cannot reinsert a hidden provider", !pickerLabels().some((label) => label.startsWith("Codex")));
  closeMenu();

  config({ hiddenProviders: ["claude-code"] }); ws.clear(); openPicker(); selectNoneAndEnter();
  ok("Enter never spawns a hidden default provider", ws.last("session.create")?.provider === "antigravity");

  config({ hiddenProviders: PROVIDER_LIST.map((provider) => provider.id), commands: [custom] }); ws.clear(); openPicker();
  ok("all-hidden built-ins still leave custom commands available", pickerLabels().length === 1 && pickerLabels()[0].startsWith("My Agent"));
  selectNoneAndEnter();
  ok("Enter falls back to the visible custom command", ws.last("session.create")?.commandId === "my-agent" && !("provider" in ws.last("session.create")));

  config({ hiddenProviders: PROVIDER_LIST.map((provider) => provider.id) }); ws.clear(); openPicker();
  ok("an intentionally empty picker explains how to recover", /Enable one in Settings/.test(document.querySelector(".pv-empty")?.textContent));
  selectNoneAndEnter();
  ok("an empty picker cannot silently spawn the engine default", !ws.last("session.create") && /Show an agent/.test(document.querySelector(".pv-error")?.textContent));
  closeMenu();

  config();
  ok("missing persisted preference reloads as default-on", store.hiddenProviders.length === 0);

  if (checks.some(([, pass]) => !pass)) process.exitCode = 1;
  else console.log(`\n${checks.length}/${checks.length} provider visibility checks passed`);
} catch (error) { console.log("THREW", error && error.stack || error); process.exitCode = 1; }
process.exit(process.exitCode || 0);
