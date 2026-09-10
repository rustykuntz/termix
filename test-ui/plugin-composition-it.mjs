// Host-owned composition card: accessible state, one owner, actions and strict active-session binding.
import { installFakeDom } from "./fakedom.mjs";
installFakeDom();
const panel = document.createElement("div"); panel.id = "term-panel"; document.body.appendChild(panel);

const { store } = await import("../public/js/store.js");
const { openPluginComposition, updatePluginComposition, closePluginComposition, pluginCompositionState } = await import("../public/js/ui/plugin-composition.js");
store.applyEvent({ type: "session.created", sessionId: "A", provider: "shell", cwd: "/a", name: "alpha", live: true });

const checks = [], actions = [];
const ok = (name, pass) => { checks.push([name, !!pass]); console.log((pass ? "  ok   " : "  FAIL ") + name); };
const opened = openPluginComposition("dictation-a", { state: "listening", title: "Smart Dictation", hint: "Private on-device capture", canStop: true }, (action) => actions.push(action));
let shell = document.querySelector(".plugin-composition");
ok("composition opens inside the terminal and binds its live session", opened.sessionId === "A" && shell?.parentNode === panel && pluginCompositionState()?.sessionId === "A");
ok("surface exposes an accessible region and polite state", shell?.getAttribute("role") === "region" && shell?.getAttribute("aria-label") === "Smart Dictation" && document.querySelector(".pc-state")?.getAttribute("aria-live") === "polite");
ok("listening state has a readable empty draft", shell?.classList.contains("pc-listening") && /Start speaking/.test(document.querySelector(".pc-draft")?.textContent));
const controlClasses = [...document.querySelector(".pc-controls").children].map((button) => button.className).join("|");
ok("icon controls follow Cancel, Stop, Send semantics", /pc-cancel.*\|.*pc-stop.*\|.*pc-send/.test(controlClasses) && [...document.querySelectorAll(".pc-button")].every((button) => button.innerHTML.includes("<svg")));
ok("every icon has an accessible name and explanatory tooltip", document.querySelector(".pc-cancel").getAttribute("aria-label") === "Cancel dictation" && /discard/.test(document.querySelector(".pc-cancel").getAttribute("title")) && document.querySelector(".pc-stop").getAttribute("aria-label") === "Stop dictation" && /without sending/.test(document.querySelector(".pc-stop").getAttribute("title")) && document.querySelector(".pc-send").getAttribute("aria-label") === "Send dictation" && /submit/.test(document.querySelector(".pc-send").getAttribute("title")));

updatePluginComposition("dictation-a", { state: "ready", draft: "Review the release notes.", canSend: true, canStop: true });
ok("ready draft paints without plugin DOM", shell.classList.contains("pc-ready") && document.querySelector(".pc-draft").textContent === "Review the release notes." && !document.querySelector(".pc-send").disabled);
document.querySelector(".pc-cancel")._fire("click"); document.querySelector(".pc-stop")._fire("click"); document.querySelector(".pc-send")._fire("click");
ok("native controls return bounded semantic callbacks", actions.map((action) => action.type).join(",") === "cancel,stop,send" && actions.every((action) => action.sessionId === "A"));

let locked = ""; try { openPluginComposition("dictation-b", {}, () => {}); } catch (error) { locked = error.message; }
ok("a second plugin cannot replace the active composition", /Another plugin/.test(locked));

store.applyEvent({ type: "session.created", sessionId: "B", provider: "shell", cwd: "/b", name: "beta", live: true });
store.select("B");
ok("switching sessions closes and cancels the bound composition", !document.querySelector(".plugin-composition") && actions.at(-1)?.type === "cancel" && actions.at(-1)?.reason === "session-changed");
ok("closing an already absent owner is harmless", closePluginComposition("dictation-a") === false);

store.select("A"); openPluginComposition("dictation-a", { state: "listening" }, (action) => actions.push(action));
store.applyEvent({ type: "session.created", sessionId: "A", provider: "shell", cwd: "/a", name: "alpha", live: false });
ok("a live-to-dormant transition closes the bound composition", !document.querySelector(".plugin-composition") && actions.at(-1)?.reason === "session-ended");

if (checks.some(([, pass]) => !pass)) process.exitCode = 1;
else console.log(`\n${checks.length}/${checks.length} terminal composition checks passed`);
