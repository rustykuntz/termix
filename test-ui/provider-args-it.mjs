// Built-in launch args are one advanced, future-spawn-only config projection. This IT covers disclosure UX,
// optimistic persistence/echo/reopen, empty omission, bypass warnings, and zero mutation of existing sessions.
import { installFakeDom, installFakeWs } from "./fakedom.mjs";
installFakeDom();
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform: "MacIntel", userAgent: "", clipboard: {} } });
const ws = installFakeWs();
for (const id of ["settings-btn", "theme-btn"]) { const el = document.createElement("button"); el.id = id; document.body.appendChild(el); }

const { connectWs } = await import("../public/js/ws.js");
const { store } = await import("../public/js/store.js");
const { openSettings } = await import("../public/js/ui/settings.js");
const { PROVIDER_LIST } = await import("../public/js/providers-ui.js");
const checks = [];
const ok = (name, pass) => { checks.push([name, !!pass]); console.log((pass ? "  ok   " : "  FAIL ") + name); };
const sleep = (ms = 8) => new Promise((resolve) => setTimeout(resolve, ms));
const config = (providerArgs = {}) => store.applyEvent({ type: "config", config: { projects: [], commands: [], providerArgs } });
const field = (id) => document.querySelector("#provider-args-" + id);

try {
  connectWs(); await sleep();
  config({ "claude-code": "--model opus", future_provider: "--future-value" });
  store.applyEvent({ type: "session.created", sessionId: "live", provider: "claude-code", cwd: "/work", name: "Live", live: true, pid: 10, status: "idle" });
  store.applyEvent({ type: "session.created", sessionId: "dormant", provider: "claude-code", cwd: "/work", name: "Dormant", live: false });
  const liveSession = store.sessions.get("live"), dormantSession = store.sessions.get("dormant");
  openSettings(); [...document.querySelectorAll(".set-cat")].find((el) => el.textContent === "CLI Agents")._fire("click");

  const disclosure = document.querySelector(".set-agent-advanced-toggle"), body = document.querySelector(".set-agent-advanced-body");
  ok("advanced launch arguments stay compact by default", disclosure.getAttribute("aria-expanded") === "false" && body.hidden === true && /Optional · advanced/.test(disclosure.textContent));
  disclosure._fire("click");
  ok("disclosure explains exact lifecycle scope", disclosure.getAttribute("aria-expanded") === "true" && !body.hidden && /next create, resume, or restart/.test(body.textContent) && /Running sessions are not changed/.test(body.textContent));
  ok("only known built-ins receive accessible fields", document.querySelectorAll(".set-agent-arg-input").length === PROVIDER_LIST.length && !field("future_provider") && field("claude-code").value === "--model opus" && document.querySelector('label[for="provider-args-claude-code"]'));

  const claude = field("claude-code"), warning = document.querySelector("#provider-args-claude-code-warning");
  claude.focus(); ws.clear(); claude.value = "--dangerously-skip-permissions"; claude._fire("input");
  ok("permission bypass warns immediately but remains a valid editable setting", warning.hidden === false && /permission checks/.test(warning.textContent) && claude.classList.contains("warn") && claude.getAttribute("aria-describedby") === warning.id && claude.getAttribute("aria-invalid") === null);
  await sleep(430);
  const dangerous = ws.last("config.update");
  ok("edit persists one providerArgs map and preserves untouched future data", dangerous?.config?.providerArgs?.["claude-code"] === "--dangerously-skip-permissions" && dangerous.config.providerArgs.future_provider === "--future-value" && Object.keys(dangerous.config).join() === "providerArgs");
  ok("optimistic launch-arg edits never touch live or dormant sessions", store.sessions.get("live") === liveSession && liveSession.live === true && liveSession.name === "Live" && store.sessions.get("dormant") === dormantSession && dormantSession.live === false);

  config(dangerous.config.providerArgs);
  store.applyEvent({ type: "availability.result", providers: [], commands: [] });
  ok("config echo and Settings rerender preserve expansion and value", document.querySelector(".set-agent-advanced-toggle").getAttribute("aria-expanded") === "true" && field("claude-code").value === "--dangerously-skip-permissions");
  document.querySelector(".set-x")._fire("click"); await sleep(180); openSettings(); [...document.querySelectorAll(".set-cat")].find((el) => el.textContent === "CLI Agents")._fire("click"); document.querySelector(".set-agent-advanced-toggle")._fire("click");
  ok("persisted argument survives Settings close and reopen", field("claude-code").value === "--dangerously-skip-permissions");

  const reopened = field("claude-code"), reopenedWarning = document.querySelector("#provider-args-claude-code-warning");
  reopened.focus(); ws.clear(); reopened.value = ""; reopened._fire("input");
  ok("removing the bypass clears its warning immediately", reopenedWarning.hidden === true && !reopened.classList.contains("warn"));
  await sleep(430);
  const cleared = ws.last("config.update");
  ok("empty values are omitted from the persisted map", !("claude-code" in cleared.config.providerArgs) && cleared.config.providerArgs.future_provider === "--future-value");

  if (checks.some(([, pass]) => !pass)) process.exitCode = 1;
  else console.log(`\n${checks.length}/${checks.length} provider launch-argument checks passed`);
} catch (error) { console.log("THREW", error && error.stack || error); process.exitCode = 1; }
process.exit(process.exitCode || 0);
