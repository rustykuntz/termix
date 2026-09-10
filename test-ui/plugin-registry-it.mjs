import { installFakeDom } from "./fakedom.mjs";
installFakeDom();
const checks = [];
function ok(name, pass) { checks.push([name, !!pass]); console.log((pass ? "  ok   " : "  FAIL ") + name); }

const actions = await import("../public/js/ui/action-registry.js");
const viewers = await import("../public/js/ui/viewer-registry.js");

let ran = null;
const remove = actions.registerAction("voice-tool", {
  id: "read-selection", label: "Read aloud", placements: ["terminal.context", "viewer.context"], hasWhen: true,
}, async (method, id, context) => {
  if (method === "match-action") return !!context.selection.text;
  if (method === "run-action") { ran = { id, text: context.selection.text }; return true; }
});
ok("action placement is registered", actions.hasActions("terminal.context"));
ok("declarative when hides an inapplicable action", (await actions.resolveActions("terminal.context", { selection: { text: "" } })).length === 0);
const found = await actions.resolveActions("terminal.context", { selection: { text: "exact words" }, nested: { safe: true } });
ok("declarative when exposes a matching action", found.length === 1 && found[0].label === "Read aloud");
await actions.runAction(found[0], found[0].context);
ok("action invocation receives the exact immutable context", ran && ran.id === "read-selection" && ran.text === "exact words" && Object.isFrozen(found[0].context));
remove();
ok("unload removes the action", !actions.hasActions("terminal.context"));

const removeViewer = viewers.registerPluginViewer("diagram-tool", { id: "graph", kind: "graph", title: "Graph", src: "/plugins/diagram-tool/public/viewer.html" });
ok("plugin viewer kinds are namespaced by the host", viewers.viewerFor("diagram-tool/graph")?.pluginId === "diagram-tool");
ok("plugin viewer is renderable, so its content opens as a tab", viewers.isRenderableKind("diagram-tool/graph"));
const removeWorkspace = viewers.registerWorkspace("diagram-tool", { id: "canvas", title: "Canvas", src: "/plugins/diagram-tool/public/app.html" });
ok("workspace identity is namespaced and discoverable", viewers.workspaceFor("diagram-tool", "canvas")?.title === "Canvas");
removeViewer(); removeWorkspace();
ok("viewer/workspace cleanup is deterministic", !viewers.viewerFor("diagram-tool/graph") && !viewers.workspaceFor("diagram-tool", "canvas"));

if (checks.some(([, pass]) => !pass)) process.exitCode = 1;
else console.log(`\n${checks.length}/${checks.length} plugin registry checks passed`);
