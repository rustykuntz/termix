// IT — the generic plugin requester for active document text. The host returns only the text currently visible
// in a core text/markdown/html viewer, never its controls or another tab's content.
import { installFakeDom } from "./fakedom.mjs";
installFakeDom();
for (const id of ["pane-tabs", "pane-body", "term-panel"]) {
  const node = document.createElement("div"); node.id = id; document.body.appendChild(node);
}

const payloads = {
  "/text": "First line\nSecond line",
  "/markdown": "# Heading\n\nVisible **paragraph**",
};
let resolveHtml;
globalThis.fetch = async (url) => {
  if (url === "/slow-html") return new Promise((resolve) => { resolveHtml = resolve; });
  return { ok: true, text: async () => payloads[url] || "", json: async () => ({ type: "bar", series: [] }) };
};

const { store } = await import("../public/js/store.js");
const { initContentDock, presentInDock, getActiveViewerText, getActiveViewerTextSnapshot } = await import("../public/js/ui/content-dock.js");
const checks = [];
const ok = (name, pass) => { checks.push([name, !!pass]); console.log((pass ? "  ok   " : "  FAIL ") + name); };
const tick = async () => { for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };

store.applyEvent({ type: "session.created", sessionId: "S", provider: "shell", name: "Shell", cwd: "/tmp", live: true });
initContentDock();

presentInDock({ sessionId: "S", contentId: "text-1", kind: "text", name: "notes.txt", url: "/text" });
await tick();
ok("plain text returns the rendered document body without host metadata", await getActiveViewerText("text-1") === "First line\nSecond line");
const textBody = document.querySelector(".ct-text-body");
let selected = "First line";
window.getSelection = () => ({ rangeCount: 1, getRangeAt: () => ({ commonAncestorContainer: textBody }), toString: () => selected });
const selectedA = await getActiveViewerTextSnapshot();
selected = "Second line";
const selectedB = await getActiveViewerTextSnapshot();
ok("viewer snapshots track changed selections without changing full text", selectedA?.selection === "First line" && selectedB?.selection === "Second line" && selectedA.text === selectedB.text && selectedA.text === "First line\nSecond line");
selected = "x".repeat(300 * 1024);
ok("viewer selection is capped at 256 KiB", (await getActiveViewerTextSnapshot()).selection.length === 256 * 1024);
window.getSelection = () => ({ rangeCount: 0, toString: () => "" });

payloads["/long"] = "x".repeat(300 * 1024);
presentInDock({ sessionId: "S", contentId: "text-long", kind: "text", name: "long.txt", url: "/long" });
await tick();
ok("viewer text is capped at 256 KiB", (await getActiveViewerText("text-long")).length === 256 * 1024);

presentInDock({ sessionId: "S", contentId: "md-1", kind: "markdown", name: "notes.md", url: "/markdown" });
await tick();
const markdown = await getActiveViewerText("md-1");
ok("markdown returns the active rendered prose", markdown.includes("Heading") && markdown.includes("Visible paragraph"));
ok("markdown excludes viewer controls and colophon", !/Rendered|Source|clideck|Read-only view/.test(markdown));
const snapshot = await getActiveViewerTextSnapshot();
ok("hotkey snapshot binds active viewer identity to its rendered text", snapshot?.id === "md-1" && snapshot.kind === "markdown" && snapshot.text === markdown && snapshot.selection === "");

document.querySelector(".cd-tab-term")._fire("click");
ok("terminal-active requests return empty", await getActiveViewerText("md-1") === "");
ok("hotkey snapshot returns null only for the Terminal surface", await getActiveViewerTextSnapshot() === null);

presentInDock({ sessionId: "S", contentId: "chart-1", kind: "chart", name: "chart", url: "/chart" });
await tick();
ok("unsupported active viewers return empty", await getActiveViewerText("chart-1") === "");
const unsupported = await getActiveViewerTextSnapshot();
ok("unsupported active viewers still return identity so hotkeys cannot fall through to terminal text", unsupported?.id === "chart-1" && unsupported.kind === "chart" && unsupported.text === "" && unsupported.selection === "");

presentInDock({ sessionId: "S", contentId: "html-1", kind: "html", name: "page.html", url: "/slow-html" });
const stale = getActiveViewerTextSnapshot();
await tick();
document.querySelector(".cd-tab-term")._fire("click");
resolveHtml({ ok: true, text: async () => "<h1>Wrong tab</h1>" });
const staleResult = await stale;
ok("a changed tab discards HTML text and selection without falling through to terminal selection", staleResult?.id === "html-1" && staleResult.kind === "html" && staleResult.text === "" && staleResult.selection === "");

if (checks.some(([, pass]) => !pass)) process.exitCode = 1;
else console.log(`\n${checks.length}/${checks.length} viewer text checks passed`);
