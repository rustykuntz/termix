// IT — the footer bell is a persisted master delivery switch, not a settings launcher. Detailed preferences
// remain intact and visible in Settings while the master gate suppresses every notification channel.
import { installFakeDom, installFakeWs } from "./fakedom.mjs";
installFakeDom();
const ws = installFakeWs();
for (const id of ["notify-btn", "settings-btn", "theme-btn"]) {
  const button = document.createElement("button"); button.id = id; document.body.appendChild(button);
}
Object.defineProperty(document, "hidden", { configurable: true, value: true });

let audioPlays = 0, delivered = 0, permissionRequests = 0;
class FakeAudio {
  constructor() { this.currentTime = 0; }
  play() { audioPlays++; return Promise.resolve(); }
}
class FakeNotification {
  static permission = "granted";
  static requestPermission() { permissionRequests++; return Promise.resolve("granted"); }
  constructor() { delivered++; }
  close() {}
}
globalThis.Audio = FakeAudio;
globalThis.Notification = FakeNotification;

const { store } = await import("../public/js/store.js");
const { connectWs } = await import("../public/js/ws.js");
const { initNotify, previewSound } = await import("../public/js/notify.js");
const { initNotificationToggle } = await import("../public/js/ui/notification-toggle.js");
const { openSettings } = await import("../public/js/ui/settings.js");
const checks = [];
const ok = (name, pass) => { checks.push([name, !!pass]); console.log((pass ? "  ok   " : "  FAIL ") + name); };
const tick = async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const button = document.getElementById("notify-btn");
const masterSwitch = () => [...document.querySelectorAll(".set-row")]
  .find((row) => row.querySelector(".set-row-t")?.textContent === "Notifications")?.querySelector(".set-switch");

connectWs(); await tick(); initNotify(); initNotificationToggle(button);
ok("master notifications default ON when the persisted field is absent", button.getAttribute("aria-pressed") === "true" && !button.classList.contains("notify-off") && /Turn notifications off/.test(button.getAttribute("aria-label")));

button._fire("click");
const disabled = ws.last("config.update");
ok("footer toggle persists the complete notification preferences with master OFF", disabled?.config?.notify?.enabled === false && disabled.config.notify.sound === true && disabled.config.notify.dispatch === true);
ok("OFF state is explicit in icon class, tooltip, label and pressed state", button.classList.contains("notify-off") && button.getAttribute("aria-pressed") === "false" && /Notifications off/.test(button.title) && /Turn notifications on/.test(button.getAttribute("aria-label")));
ok("footer toggle does not open settings or the retired notification popover", !document.querySelector(".set-overlay") && !document.querySelector(".ns-panel"));

const configured = { sound: true, pick: "default-beep", minWorkSec: 0, browser: true, dispatch: true, dispatchPick: "agent-dispatch-ambient" };
store.applyEvent({ type: "config", config: { notify: { ...configured, enabled: true } } });
ok("a config echo from another client repaints the footer ON", button.getAttribute("aria-pressed") === "true" && !button.classList.contains("notify-off"));
store.applyEvent({ type: "config", config: { notify: { ...configured, enabled: false } } });
ok("a config echo repaints the footer OFF without opening another surface", button.getAttribute("aria-pressed") === "false" && button.classList.contains("notify-off") && !document.querySelector(".set-overlay"));
store.applyEvent({ type: "session.created", sessionId: "A", provider: "shell", name: "A", cwd: "/tmp", live: true });
store.applyEvent({ type: "session.created", sessionId: "B", provider: "shell", name: "B", cwd: "/tmp", live: true });
store.applyEvent({ type: "session.dispatch", fromId: "A", toId: "B" });
store.applyEvent({ type: "status", sessionId: "B", state: "working" });
store.applyEvent({ type: "status", sessionId: "B", state: "idle" });
ok("master OFF suppresses dispatch sound, idle sound and browser delivery", audioPlays === 0 && delivered === 0);
previewSound("sound");
ok("an explicit Settings preview remains audible while automatic delivery is paused", audioPlays === 1);

openSettings();
[...document.querySelectorAll(".set-cat")].find((entry) => entry.textContent === "Notifications")._fire("click");
ok("Settings > Notifications reflects the same master OFF state", masterSwitch()?.getAttribute("aria-checked") === "false" && /Delivery is paused/.test(document.querySelector(".set-body").textContent));
ok("disabling delivery does not revoke the existing browser permission", FakeNotification.permission === "granted");

FakeNotification.permission = "default";
button._fire("click");
const enabled = ws.last("config.update");
ok("re-enabling preserves configured channel choices", enabled?.config?.notify?.enabled === true && enabled.config.notify.browser === true && enabled.config.notify.sound === true && enabled.config.notify.dispatch === true);
ok("the open Settings view reflects the optimistic master change immediately", masterSwitch()?.getAttribute("aria-checked") === "true");
ok("a simple master toggle never prompts when browser permission is absent", permissionRequests === 0 && FakeNotification.permission === "default");

FakeNotification.permission = "granted";
store.applyEvent({ type: "session.dispatch", fromId: "A", toId: "B" });
store.applyEvent({ type: "status", sessionId: "B", state: "working" });
store.applyEvent({ type: "status", sessionId: "B", state: "idle" });
ok("master ON restores the saved dispatch, idle sound and browser behavior", audioPlays === 3 && delivered === 1);

if (checks.some(([, pass]) => !pass)) process.exitCode = 1;
else console.log(`\n${checks.length}/${checks.length} notification master-toggle checks passed`);
