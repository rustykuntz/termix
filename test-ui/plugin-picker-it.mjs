import { installFakeDom } from "./fakedom.mjs";
const { docFire } = installFakeDom();
const { openPluginPicker, closePluginPicker } = await import("../public/js/ui/plugin-picker.js");

const checks = [];
const ok = (name, pass) => { checks.push([name, !!pass]); console.log((pass ? "  ok   " : "  FAIL ") + name); };
const tick = () => new Promise((resolve) => setTimeout(resolve, 4));
const options = {
  id: "symbols", title: "Choose a symbol", placeholder: "Search symbols",
  items: [
    { id: "spark", glyph: "✦", label: "Spark", keywords: ["star", "bright"], group: "Shapes" },
    { id: "wave", glyph: "≋", label: "Wave", keywords: ["sound"], group: "Lines" },
    { id: "circle", glyph: "○", label: "Circle", group: "Shapes" },
  ], recentLimit: 2,
};

const first = openPluginPicker("fixture", options); await tick();
ok("picker is one accessible host-owned modal with search focused", document.querySelectorAll(".pk-overlay").length === 1 && document.querySelector(".pk-modal").getAttribute("role") === "dialog" && document.activeElement === document.querySelector(".pk-input"));
ok("category chips are derived from bounded group text", [...document.querySelectorAll(".pk-chip")].map((chip) => chip.textContent).join("|") === "All|Shapes|Lines");
const input = document.querySelector(".pk-input"); input.value = "sound"; input._fire("input");
ok("search includes declarative keywords and filters the grid", document.querySelectorAll(".pk-item").length === 1 && document.querySelector(".pk-label").textContent === "Wave");
input.value = ""; input._fire("input");
docFire("keydown", { key: "ArrowDown", preventDefault() {}, stopPropagation() {} });
const before = document.activeElement; docFire("keydown", { key: "ArrowRight", preventDefault() {}, stopPropagation() {} });
ok("keyboard enters and roams the item grid", before?.dataset.itemId === "spark" && document.activeElement?.dataset.itemId === "wave");
document.activeElement._fire("click");
ok("selection resolves the exact declarative id", await first === "wave" && !document.querySelector(".pk-overlay"));

const reopened = openPluginPicker("fixture", options); await tick();
ok("recent choices persist under the plugin and picker identity", document.querySelector(".pk-recent .pk-item")?.dataset.itemId === "wave");
document.querySelector(".pk-overlay")._fire("mousedown", { target: document.querySelector(".pk-overlay") });
ok("outside click cancels with null", await reopened === null);

const superseded = openPluginPicker("fixture", options); await tick();
const latest = openPluginPicker("other-plugin", { ...options, id: "other" }); await tick();
ok("opening a second picker cancels the first", await superseded === null && document.querySelectorAll(".pk-overlay").length === 1);
ok("teardown is owner-scoped", closePluginPicker("fixture") === false && closePluginPicker("other-plugin") === true && await latest === null);

let bounded = false;
try { openPluginPicker("fixture", { ...options, items: Array.from({ length: 257 }, (_, i) => ({ id: String(i), label: String(i) })) }); }
catch (error) { bounded = /at most 256/.test(error.message); }
ok("host rejects oversized declarative payloads", bounded && !document.querySelector(".pk-overlay"));

if (checks.some(([, pass]) => !pass)) process.exitCode = 1;
else console.log(`\n${checks.length}/${checks.length} plugin picker checks passed`);
