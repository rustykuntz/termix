import { installFakeDom } from "./fakedom.mjs";
installFakeDom();
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform: "MacIntel", userAgent: "" } });
const checks = [];
function ok(name, pass) { checks.push([name, !!pass]); console.log((pass ? "  ok   " : "  FAIL ") + name); }

const { PROVIDER_LIST, providerOf, sessionFace } = await import("../public/js/providers-ui.js");
const { AGENT_PRESETS, providerHealth } = await import("../public/js/agent-presets.js");
const provider = providerOf("antigravity"), face = sessionFace({ provider: "antigravity" }), mark = provider.mark();
ok("provider list exposes one native Antigravity choice", PROVIDER_LIST.filter((entry) => entry.id === "antigravity").length === 1 && provider.label === "Antigravity");
ok("picker, row and header share a distinct Antigravity identity", face.id === "antigravity" && face.label === "Antigravity" && face.cls === "pv-antigravity" && mark.tag === "svg" && mark.innerHTML !== providerOf("claude-code").mark().innerHTML);
ok("Settings metadata uses the native agy command", AGENT_PRESETS.antigravity.command === "agy");
ok("availability health handles installed and missing Antigravity", providerHealth("antigravity", { available: true, version: "1.4.0" }).state === "ok" && providerHealth("antigravity", { available: false }).state === "missing");

let providerId = "antigravity", keyHandler = null, input = "";
const term = {
  parser: { registerOscHandler() {} },
  attachCustomKeyEventHandler(fn) { keyHandler = fn; },
  input(value) { input += value; },
};
const { attachToTerminal } = await import("../public/js/ui/hotkeys.js");
attachToTerminal(term, () => providerId);
const shiftEnter = () => {
  let prevented = false;
  const accepted = keyHandler({ type: "keydown", key: "Enter", code: "Enter", shiftKey: true, ctrlKey: false, altKey: false, metaKey: false, preventDefault() { prevented = true; }, stopPropagation() {} });
  return { accepted, prevented };
};
const antigravityKey = shiftEnter();
ok("Antigravity gets Claude-compatible Shift+Enter input", antigravityKey.accepted === false && antigravityKey.prevented && input === "\x1b[13;2u");
providerId = "codex"; input = ""; const codexKey = shiftEnter();
ok("Shift+Enter remains provider-scoped", codexKey.accepted === true && !codexKey.prevented && input === "");

if (checks.some(([, pass]) => !pass)) process.exitCode = 1;
else console.log(`\n${checks.length}/${checks.length} Antigravity UI checks passed`);
