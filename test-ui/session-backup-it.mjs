// IT — Settings ▸ General ▸ Session management. The row stays a real link (Save As still works, and it
// survives without JS), but the click is guarded: `download` saves WHATEVER comes back, so a failing route
// either writes its error body out as if it were the backup or writes nothing at all and says nothing. For a
// backup, whose whole value is the user's belief that they have one, neither may pass silently.
// The file itself is the engine's to build: the client mirrors config in slices and never sees plugin
// secrets, so a client-assembled backup would quietly omit half of it.
import { installFakeDom, installFakeWs } from "./fakedom.mjs";
installFakeDom();
installFakeWs();
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform: "MacIntel", userAgent: "", clipboard: {} } });

const mk = (tag, id, parent = document.body) => { const el = document.createElement(tag); el.id = id; parent.appendChild(el); return el; };
for (const id of ["tab-all", "tab-unread", "search", "search-clear", "notify-btn", "prompts-btn", "settings-btn", "unread-cnt", "conn", "conn-text", "save-ind", "proj-btn"]) mk("button", id);

const { openSettings } = await import("../public/js/ui/settings.js");
const checks = [];
const ok = (name, pass) => { checks.push([name, !!pass]); console.log((pass ? "  ok   " : "  FAIL ") + name); };
const sleep = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

openSettings();
await sleep();

const headings = [...document.querySelectorAll(".set-sec-h")].map((node) => node.textContent);
ok("General carries a Session management section, after the preferences it is not one of",
  headings.includes("Session management") && headings.indexOf("Session management") > headings.indexOf("Behavior"));

const action = document.querySelector(".set-action");
ok("the control is a real link, not a button that fakes one", action && action.tag === "a" && action.textContent === "Download");
ok("it points at the engine's backup route and still works as a plain Save As",
  action.getAttribute("href") === "/api/session/backup" && action.hasAttribute("download"));

const row = action.parentNode;
ok("the row says what the file is", row.querySelector(".set-row-t").textContent === "Download a backup");
// A backup nobody understands the scope of is a backup nobody trusts, so the row states both halves: what is
// in it, and what is deliberately not.
const sub = row.querySelector(".set-row-s").textContent;
ok("and it states the scope in the row: what is included, and what is not",
  /sessions and project definitions/i.test(sub) && /dated JSON/i.test(sub)
  && /transcripts/i.test(sub) && /credentials are not included/i.test(sub));

// ── the click is guarded, because a failed download must never look like a backup ────────────────────────
const saves = [];
const realCreate = document.createElement.bind(document);
document.createElement = (tag) => { const node = realCreate(tag); if (tag === "a") saves.push(node); return node; };
globalThis.URL = { createObjectURL: () => "blob:backup", revokeObjectURL() {} };
let asked = null;
const clickAction = async () => { saves.length = 0; action._fire("click"); await sleep(10); };

globalThis.fetch = async (url) => {
  asked = url;
  return { ok: true, status: 200, headers: { get: () => 'attachment; filename="clideck-sessions-2026-09-05.json"' }, blob: async () => ({ size: 135 }) };
};
await clickAction();
ok("clicking asks the engine before anything is written", asked === "/api/session/backup");
const saved = saves.find((node) => node.download);
ok("a good answer is saved under the engine's own filename",
  saved && saved.download === "clideck-sessions-2026-09-05.json" && saved.href === "blob:backup");

const toasts = [];
const toastModule = await import("../public/js/ui/toast.js");
for (const kind of ["error", "info", "success", "warn"]) toastModule.toast[kind] = (options) => toasts.push([kind, options]);
globalThis.fetch = async () => ({ ok: false, status: 503, headers: { get: () => "" }, blob: async () => ({}) });
await clickAction();
await sleep(10);
ok("a refusing engine writes NO file at all", !saves.some((node) => node.download));
ok("and says so, with the status, instead of failing silently",
  toasts.length === 1 && toasts[0][0] === "error" && /Couldn.t download a backup/.test(toasts[0][1].body) && /503/.test(toasts[0][1].body));

toasts.length = 0;
globalThis.fetch = async () => { throw new Error("Network is down."); };
await clickAction();
await sleep(10);
ok("an unreachable engine is reported the same way, never as a saved file",
  !saves.some((node) => node.download) && toasts.length === 1 && /Network is down/.test(toasts[0][1].body));
document.createElement = realCreate;

if (checks.some(([, pass]) => !pass)) process.exitCode = 1;
else console.log(`\n${checks.length}/${checks.length} session backup checks passed`);
