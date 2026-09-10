// Footer master switch. Detailed preferences live in Settings > Notifications; this control only pauses or
// restores delivery and never touches browser permission or the saved per-channel choices.
import { getPrefs, onPrefs, setPref } from "../notify.js";

function paint(button, prefs) {
  const on = prefs.enabled !== false;
  button.classList.toggle("notify-off", !on);
  button.setAttribute("aria-pressed", String(on));
  button.setAttribute("aria-label", on ? "Turn notifications off" : "Turn notifications on");
  button.title = on ? "Notifications on — click to turn off" : "Notifications off — click to turn on";
}

export function initNotificationToggle(button = document.getElementById("notify-btn")) {
  if (!button) return () => {};
  paint(button, getPrefs());
  button.onclick = (event) => { event?.stopPropagation?.(); setPref("enabled", getPrefs().enabled === false); };
  return onPrefs((prefs) => paint(button, prefs));
}
