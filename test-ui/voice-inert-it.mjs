// Voice inert path: no terminal.voice action means a cleanly disabled microphone; speaker waits for plugins.
import { installFakeDom } from "./fakedom.mjs";
installFakeDom();

const mk = (id) => { const b = document.createElement("button"); b.id = id; document.body.appendChild(b); return b; };
const mic = mk("voice-mic"), say = mk("voice-say");

const { initVoice } = await import("../public/js/ui/voice.js");

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n); } };

try {
  initVoice();
  await new Promise((resolve) => setTimeout(resolve, 0));
  ok("mic toggle is present but disabled", !!document.getElementById("voice-mic") && mic.disabled === true && mic._cls.has("v-unsupported"));
  ok("read-aloud control waits for the plugin snapshot", !!document.getElementById("voice-say") && say.disabled === true && /Loading voice plugin/.test(say.title));
  ok("disabled mic explains that a plugin provides dictation", mic.title === "No dictation plugin available");
  // clicking an unsupported toggle is inert (no listener wired, no throw)
  let threw = false; try { mic._fire("click"); say._fire("click"); } catch { threw = true; }
  ok("clicking the inert toggles does nothing (no throw)", !threw);

  console.log(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
} catch (e) { console.log("THREW", e && e.stack || e); fail++; }
process.exit(fail === 0 ? 0 : 1);
