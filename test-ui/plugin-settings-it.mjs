import { installFakeDom, installFakeWs } from "./fakedom.mjs";
const { body } = installFakeDom();
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform: "MacIntel", userAgent: "", clipboard: { writeText: async () => {} } } });
const ws = installFakeWs();
for (const id of ["settings-btn", "theme-btn"]) { const el = document.createElement("button"); el.id = id; body.append(el); }
const checks = [];
function ok(name, pass) { checks.push([name, !!pass]); console.log((pass ? "  ok   " : "  FAIL ") + name); }
const tick = () => new Promise((resolve) => setTimeout(resolve, 8));

const { connectWs } = await import("../public/js/ws.js");
const { store } = await import("../public/js/store.js");
const { openSettings } = await import("../public/js/ui/settings.js");
connectWs(); await tick(); openSettings(); await tick();
const echo = {
  id: "echo-tool", name: "Echo Tool", version: "1.2.0", apiVersion: 1, description: "A focused test plugin.", source: "user", enabled: true, status: "ready", error: "", commands: [{ name: "echo", description: "Echo text", usage: "echo-tool/echo" }],
  settings: [{ key: "prefix", label: "Prefix", type: "text", default: "echo:" }, { key: "token", label: "API token", type: "secret", default: "" }], values: { prefix: "say:" }, configured: { token: true }, clientUrl: "", hasWorkspaceAssets: false,
};
const helper = { id: "helper", name: "Helper", version: "0.2.0", description: "Another local extension.", source: "user", enabled: true, status: "ready", settings: [], values: {}, configured: {} };
store.applyEvent({ type: "plugins", plugins: [echo, helper] });
const pluginsCat = [...document.querySelectorAll(".set-cat")].find((el) => el.textContent === "Plugins");
pluginsCat._fire("click");
ok("Settings exposes a Plugins category", !!pluginsCat && !!document.querySelector(".plg-list"));
ok("inventory renders identity, version and ready state", document.querySelector(".plg-name")?.textContent === "Echo Tool" && document.querySelector(".plg-version")?.textContent === "v1.2.0" && !!document.querySelector(".plg-status.ready"));
const search = document.querySelector(".plg-search input"), originalSearch = search; search.focus();
for (const char of "echo tool") { search.value += char; search._fire("input"); }
ok("multi-character search preserves focus and caret node", document.querySelector(".plg-search input") === originalSearch && document.activeElement === originalSearch && search.value === "echo tool");
ok("search filters existing rows without rebuilding the list", [...document.querySelectorAll(".plg-row")].filter((row) => !row.hidden).length === 1 && document.querySelector(".plg-name")?.textContent === "Echo Tool");
// ⚠️ The empty-state card is BUILT hidden and revealed by the filter, so "hidden" is a claim that has to hold
// while there are still matches. It did not: `.plg-state`'s own `display:flex` beat the UA `[hidden]` rule and
// the card sat under three healthy rows on every Plugins pane (found in a release capture, 09-10). This
// asserts the attribute contract; whether it is actually INVISIBLE is CSS, and cdp-gate-plugindefaults owns it.
const emptyCard = () => document.querySelector(".plg-state.empty");
ok("a search that still matches something keeps the empty-state card hidden", emptyCard() && emptyCard().hidden === true);
for (const char of " zzz") { search.value += char; search._fire("input"); }
ok("filtering everything out hides every row", [...document.querySelectorAll(".plg-row")].every((row) => row.hidden));
ok("…and only then is the empty-state card unhidden", emptyCard() && emptyCard().hidden === false);
search.value = ""; search._fire("input");
ok("clearing the search brings the rows back and hides the card again",
  [...document.querySelectorAll(".plg-row")].every((row) => !row.hidden) && emptyCard().hidden === true);
document.querySelector(".plg-row-main")._fire("click");
ok("plugin row opens a focused detail view", document.querySelector(".plg-detail-name")?.textContent === "Echo Tool" && !!document.querySelector(".plg-back"));
const secret = document.querySelector("#plugin-setting-echo-tool-token");
ok("masked secrets are never projected back into the input", secret && secret.value === "" && /Saved/.test(secret.placeholder));
const clear = document.querySelector(".plg-clear"); clear._fire("click"); await tick();
const cleared = ws.last("plugin.settings.update");
ok("saved secrets have an explicit immediate clear action", cleared && cleared.settings.token === "" && clear.disabled === true && clear.textContent === "Cleared");
const stateSwitch = document.querySelector(".plg-detail-head")?.parentNode?.querySelector(".set-switch");
stateSwitch?._fire("click"); await tick();
const enable = ws.last("plugin.setEnabled");
ok("enable/disable uses a correlated plugin control", enable && enable.pluginId === "echo-tool" && enable.enabled === false && /^ui-/.test(enable.requestId));
store.applyEvent({ type: "plugin.result", operation: "setEnabled", success: true, pluginId: "echo-tool", requestId: enable.requestId });
ok("matching result clears the busy state and reports success", !!document.querySelector(".plg-notice.ok"));
const prefix = document.querySelector("#plugin-setting-echo-tool-prefix"); prefix.focus(); prefix.value = "next:"; prefix._fire("input");
await new Promise((resolve) => setTimeout(resolve, 480));
const setting = ws.last("plugin.settings.update");
ok("text settings save quietly with a correlated request", setting && setting.settings.prefix === "next:" && /^ui-/.test(setting.requestId));
store.applyEvent({ type: "plugins", plugins: [{ ...store.plugins[0], values: { prefix: "next:" } }, store.plugins[1]] });
ok("the settings echo does not replace the focused input", document.querySelector("#plugin-setting-echo-tool-prefix") === prefix && document.activeElement === prefix);
store.applyEvent({ type: "plugin.result", operation: "settings", success: false, error: "invalid value", pluginId: "echo-tool", requestId: setting.requestId });
ok("a quiet settings failure is still surfaced", !!document.querySelector(".plg-notice.bad") && /invalid value/.test(document.querySelector(".plg-notice.bad").textContent));
store.applyEvent({ type: "plugins", plugins: [{ ...store.plugins[0], status: "failed", error: "backend exploded" }, store.plugins[1]] });
ok("failed plugins expose a concise accessible failure panel", document.querySelector(".plg-failure")?.getAttribute("role") === "alert" && /backend exploded/.test(document.querySelector(".plg-failure")?.textContent || ""));

if (checks.some(([, pass]) => !pass)) process.exitCode = 1;
else console.log(`\n${checks.length}/${checks.length} plugin settings checks passed`);
