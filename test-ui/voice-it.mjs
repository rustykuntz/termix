// Voice IT — the mic is a generic terminal.voice plugin action; browser SpeechRecognition is retired.
import { installFakeDom, installFakeWs } from "./fakedom.mjs";
installFakeDom();
const ws = installFakeWs();

let speechConstructed = 0;
window.SpeechRecognition = class { constructor() { speechConstructed++; } };
const mk = (id) => { const b = document.createElement("button"); b.id = id; document.body.appendChild(b); return b; };
const mic = mk("voice-mic"), say = mk("voice-say");
const panel = document.createElement("div"); panel.id = "term-panel"; document.body.appendChild(panel);

const { store } = await import("../public/js/store.js");
const { connectWs } = await import("../public/js/ws.js");
const { registerAction } = await import("../public/js/ui/action-registry.js");
const { openPluginComposition, closePluginComposition } = await import("../public/js/ui/plugin-composition.js");
const { initVoice } = await import("../public/js/ui/voice.js");

let pass = 0, fail = 0, invoked = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n); } };
const sleep = (ms = 8) => new Promise((r) => setTimeout(r, ms));

try {
  connectWs(); await sleep();
  store.applyEvent({ type: "session.created", sessionId: "A", provider: "shell", cwd: "/a", name: "alpha", live: true, pid: 1 });
  store.applyEvent({ type: "plugins", plugins: [{ id: "supertonic", name: "Supertonic Voice", enabled: true, status: "ready", values: { "auto-read": false } }] });
  registerAction("dictation-fixture", { id: "dictate", label: "Local Dictation", placements: ["terminal.voice"] }, async (method) => { if (method === "run-action") invoked++; });
  initVoice(); await sleep();
  ok("mic enables only when a generic dictation action exists", !mic.disabled && !mic.classList.contains("v-unsupported") && mic.title === "Local Dictation");
  ok("Supertonic read-aloud control remains available", !say.disabled && !say.classList.contains("v-unsupported"));

  mic._fire("click", { detail: 1 }); await sleep();
  ok("mic invokes the terminal.voice action directly", invoked === 1);
  ok("retired browser SpeechRecognition is never constructed", speechConstructed === 0);

  openPluginComposition("dictation-fixture", { state: "listening", title: "Local Dictation" }, () => {}); await sleep();
  ok("mic reflects the host composition's active state", mic.classList.contains("on") && mic.getAttribute("aria-pressed") === "true");
  closePluginComposition("dictation-fixture"); await sleep();
  ok("mic clears when composition closes", !mic.classList.contains("on") && mic.getAttribute("aria-pressed") === "false");

  ws.clear(); say._fire("click");
  const cfg = ws.last("plugin.settings.update");
  ok("read-aloud still toggles Supertonic auto-read", cfg?.pluginId === "supertonic" && cfg.settings?.["auto-read"] === true);
  ok("no Web Speech TTS path is introduced", typeof window.speechSynthesis === "undefined");

  console.log(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
} catch (e) { console.log("THREW", e && e.stack || e); fail++; }
process.exit(fail === 0 ? 0 : 1);
