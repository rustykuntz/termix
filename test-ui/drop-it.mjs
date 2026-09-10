// R2 IT — file-drop veil, broad type gating, and FOLDER→path. Drives the ACTUAL store + drop.js + ws.js over a
// fake WebSocket + a stubbed XMLHttpRequest (path echoes the uploaded name). Covers: veil gating + supported/
// unsupported drag state; ANY document/text/image/code uploads (blocklist — only executables & archives are
// refused); a dropped FOLDER pastes its absolute path with no upload; multi-file; mixed; no-active-session guard.
import { installFakeDom, installFakeWs } from "./fakedom.mjs";
const dom = installFakeDom();
const ws = installFakeWs();
const main = document.createElement("div"); main.className = "main"; document.body.appendChild(main);
const frame = document.createElement("div"); frame.className = "term-frame"; main.appendChild(frame);

const uploads = [];
class FakeXHR {
  open(m, u) { this.method = m; this.url = u; this.upload = {}; }
  send(body) {
    this.body = body; uploads.push({ url: this.url, body });
    const name = decodeURIComponent((/[?&]name=([^&]+)/.exec(this.url) || [])[1] || "file");
    setTimeout(() => { this.status = 200; this.responseText = JSON.stringify({ ok: true, path: "/data/uploads/" + name, name }); if (this.onload) this.onload(); }, 0);
  }
}
globalThis.XMLHttpRequest = FakeXHR;

// The pane the tab strip lives in — the strip is the OTHER drop target and needs to be mounted to be one.
const rp = document.createElement("section"); rp.className = "rp"; main.appendChild(rp);
const tabsEl = document.createElement("div"); tabsEl.id = "pane-tabs"; tabsEl.className = "cd-tabs"; rp.appendChild(tabsEl);
const bodyEl = document.createElement("div"); bodyEl.id = "pane-body"; bodyEl.className = "pane-body"; rp.appendChild(bodyEl);
const termPanel = document.createElement("div"); termPanel.id = "term-panel"; bodyEl.appendChild(termPanel);
// a mounted markdown tab fetches its body; a relative URL would throw in node, so answer it here
globalThis.fetch = async () => ({ ok: true, text: async () => "# doc", json: async () => ({}) });

const { store } = await import("../public/js/store.js");
const { connectWs } = await import("../public/js/ws.js");
const { initDrop } = await import("../public/js/ui/drop.js");
const { initContentViewer } = await import("../public/js/ui/content-viewer.js");

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const zone = () => document.querySelector(".drop-zone");
const inputs = () => ws.sent.filter((m) => m.type === "input");
const ev = (o) => ({ preventDefault() {}, ...o });

// dataTransfer builders
const file = (name, type = "", size = 2048) => ({ name, type, size });
const fitem = (f) => ({ kind: "file", type: f.type || "", getAsFile: () => f, webkitGetAsEntry: () => ({ isFile: true, isDirectory: false, name: f.name }) });
const dtFiles = (files) => ({ types: ["Files"], files, items: files.map(fitem), dropEffect: "", getData: () => "" });
const dtMime = (type) => ({ types: ["Files"], files: [], items: [{ kind: "file", type }], dropEffect: "", getData: () => "" });
const dtFolder = (path) => { const name = path.split("/").filter(Boolean).pop(); return { types: ["Files", "text/uri-list"], files: [{ name, size: 0, type: "" }], items: [{ kind: "file", type: "", getAsFile: () => ({ name, size: 0, type: "" }), webkitGetAsEntry: () => ({ isDirectory: true, isFile: false, name }) }], dropEffect: "", getData: (t) => (t === "text/uri-list" ? "file://" + path : "") }; };
// A drag from a NON-Finder file manager: real File objects and NO text/uri-list at all. This is the exact shape
// that used to fail with "carried no file path", so every tab-strip assertion below uses it — a fixture that
// supplies a uri-list would prove nothing about the bug being fixed.
const enc = new TextEncoder();
const doc = (name, body = "# " + name + "\n", size = 128) => ({ name, type: "", size,
  text: async () => body, arrayBuffer: async () => enc.encode(body).buffer });
const b64 = (s2) => Buffer.from(s2, "utf8").toString("base64");
const dtDocs = (files) => ({ types: ["Files"], files,
  items: files.map((f) => ({ kind: "file", type: "", getAsFile: () => f, webkitGetAsEntry: () => ({ isFile: true, isDirectory: false, name: f.name }) })),
  dropEffect: "", getData: () => "" });
const rect = (el, h2) => { el._rect = { left: 0, top: 0, right: 900, bottom: h2, width: 900, height: h2 }; return el; };
const opens = () => ws.sent.filter((m) => m.type === "content.open");

try {
  connectWs(); await sleep(5);
  initDrop();
  ok("drop veil exists, hidden at rest", !!zone() && !zone()._cls.has("show"));

  main._fire("dragenter", ev({ dataTransfer: dtFiles([]) }));
  ok("no active session → veil stays hidden", !zone()._cls.has("show"));
  store.applyEvent({ type: "session.created", sessionId: "A", cwd: "/a", name: "alpha", live: true, pid: 1 });

  main._fire("dragenter", ev({ dataTransfer: dtFiles([]) }));
  ok("dragenter (files + live session) → veil shows + names session", zone()._cls.has("show") && /Drop to send to.*alpha/.test(document.querySelector(".drop-title").textContent));
  const over = ev({ dataTransfer: dtFiles([]) }); main._fire("dragover", over);
  ok("dragover sets dropEffect=copy", over.dataTransfer.dropEffect === "copy");
  main._fire("dragover", ev({ dataTransfer: dtMime("application/x-msdownload") }));
  ok("binary drag MIME → veil reject state", zone()._cls.has("reject"));
  main._fire("dragleave", ev({ dataTransfer: dtFiles([]) }));
  ok("dragleave hides the veil", !zone()._cls.has("show"));
  // an in-app drag (a session row dragged to a project) is NOT a file drag → the veil must stay hidden
  main._fire("dragenter", ev({ dataTransfer: { types: ["text/plain"], files: [], items: [], getData: () => "" } }));
  ok("a non-file (in-app row) drag does NOT open the veil", !zone()._cls.has("show"));

  // ── ALL doc types upload (blocklist): images, office, ebook, tex, no-extension ──
  ws.clear(); uploads.length = 0;
  main._fire("drop", ev({ dataTransfer: dtFiles([file("shot.png", "image/png"), file("report.docx"), file("book.epub"), file("paper.tex"), file("Makefile")]) }));
  await sleep(8);
  ok("every document/image/no-ext file uploads", uploads.length === 5);
  ok("each returned path pasted (bracketed, not auto-sent)", inputs().length === 5 && inputs().every((m) => m.data.indexOf("\x1b[200~") === 0 && m.data.indexOf("\r") === -1));

  // ── executables + archives refused, no upload ──
  ws.clear(); uploads.length = 0;
  main._fire("drop", ev({ dataTransfer: dtFiles([file("installer.exe", "application/x-msdownload"), file("bundle.zip", "application/zip")]) }));
  await sleep(5);
  ok("executables + archives → NO upload", uploads.length === 0 && inputs().length === 0);
  ok("refused files → gentle toast", !!document.getElementById("toast-drop-reject"));

  // ── FOLDER → its path is pasted, no upload ──
  ws.clear(); uploads.length = 0;
  main._fire("drop", ev({ dataTransfer: dtFolder("/Users/rusty/Projects/clideck-next") }));
  await sleep(5);
  ok("folder drop → NO upload", uploads.length === 0);
  ok("folder path pasted verbatim (bracketed, not auto-sent)", (() => { const p = ws.last("input"); return p && p.data === "\x1b[200~/Users/rusty/Projects/clideck-next\x1b[201~"; })());
  ok("folder drop → a 'path pasted' success toast", !!document.getElementById("toast-drop-path:/Users/rusty/Projects/clideck-next"));

  // ── mixed: doc uploads, executable refused ──
  ws.clear(); uploads.length = 0;
  main._fire("drop", ev({ dataTransfer: dtFiles([file("keep.pdf", "application/pdf"), file("skip.exe", "application/x-msdownload")]) }));
  await sleep(6);
  ok("mixed → only the document uploads", uploads.length === 1 && /name=keep\.pdf/.test(uploads[0].url));
  ok("mixed → the executable is toast-refused", !!document.getElementById("toast-drop-reject"));

  // ── THE TAB STRIP AS A SECOND TARGET ───────────────────────────────────────────────────────────────────
  // Same drag, two meanings, chosen by where you let go: on the strip it OPENS as a document (path → engine,
  // no upload, no blob: URL); anywhere else the terminal meaning is untouched.
  initContentViewer();
  const rail = () => document.querySelector(".cd-rail");
  ok("no rail at rest — the target only exists during a drag", !rail());

  main._fire("dragenter", ev({ dataTransfer: dtDocs([doc("notes.md")]), clientX: 400, clientY: 300 }));
  ok("a file drag with nothing open REVEALS the strip as a rail", !!rail());
  ok("the rail overlays the pane body, it does not reflow the terminal into a new position",
     rail().parentNode === bodyEl && termPanel.parentNode === bodyEl);
  ok("the rail says what letting go here will do", /open as a document/i.test(rail().textContent));
  rect(rail(), 38);

  // over the rail the veil states the OTHER intention, so the two targets read as one choice
  main._fire("dragover", ev({ dataTransfer: dtDocs([doc("notes.md")]), clientX: 400, clientY: 20 }));
  ok("pointer over the rail → the veil switches to 'Open as a document'", /Open as a\s*document/i.test(document.querySelector(".drop-title").textContent));
  ok("pointer over the rail → the rail marks itself as the live target", rail()._cls.has("drop-over"));
  main._fire("dragover", ev({ dataTransfer: dtDocs([doc("notes.md")]), clientX: 400, clientY: 300 }));
  ok("pointer back over the terminal → the veil returns to 'send to <session>'", /Drop to send to.*alpha/.test(document.querySelector(".drop-title").textContent));

  // ── THE BUG THIS REPLACED: no text/uri-list anywhere in the drag, and it must still open ──
  ws.clear(); uploads.length = 0;
  main._fire("drop", ev({ dataTransfer: dtDocs([doc("notes.md", "# Notes\n\n- one\n")]), clientX: 400, clientY: 20 }));
  await sleep(8);
  ok("a drag with NO uri-list still opens — the file's own bytes are sent, not a recovered path", (() => {
    const m = opens()[0];
    return opens().length === 1 && m.sessionId === "A" && m.name === "notes.md" && m.kind === "markdown"
      && m.data === "# Notes\n\n- one\n" && !("path" in m);
  })());
  ok("drop ON the rail does NOT upload and does NOT paste into the terminal", uploads.length === 0 && inputs().length === 0);
  ok("the rail is torn down after the drop", !rail());

  // the terminal's meaning must not change — the same file dropped there still uploads
  ws.clear(); uploads.length = 0;
  main._fire("dragenter", ev({ dataTransfer: dtDocs([doc("notes.md")]), clientX: 400, clientY: 300 }));
  rect(rail(), 38);
  main._fire("drop", ev({ dataTransfer: dtDocs([doc("notes.md")]), clientX: 400, clientY: 300 }));
  await sleep(10);
  ok("the SAME markdown file dropped on the terminal still uploads + pastes (its meaning is unchanged)",
     opens().length === 0 && uploads.length === 1 && inputs().length === 1);

  // kinds the document view cannot render are refused before a byte is read
  ws.clear(); uploads.length = 0;
  main._fire("dragenter", ev({ dataTransfer: dtDocs([doc("photo.png")]), clientX: 400, clientY: 300 }));
  rect(rail(), 38);
  main._fire("drop", ev({ dataTransfer: dtDocs([doc("photo.png")]), clientX: 400, clientY: 20 }));
  await sleep(6);
  ok("a kind the document view can't render is refused, and says what can", opens().length === 0 && !!document.getElementById("toast-tabdrop-kind:photo.png"));

  // multi-file → one tab each, each carrying its own bytes and kind
  ws.clear();
  main._fire("dragenter", ev({ dataTransfer: dtDocs([doc("one.md", "# One\n"), doc("two.patch", "@@ -1 +1 @@\n")]), clientX: 400, clientY: 300 }));
  rect(rail(), 38);
  main._fire("drop", ev({ dataTransfer: dtDocs([doc("one.md", "# One\n"), doc("two.patch", "@@ -1 +1 @@\n")]), clientX: 400, clientY: 20 }));
  await sleep(10);
  ok("multi-file drop opens one document per file, each with its own kind + bytes",
     opens().length === 2 && opens().map((m) => m.name + ":" + m.kind).join() === "one.md:markdown,two.patch:diff"
     && opens()[1].data === "@@ -1 +1 @@\n");

  ws.clear();
  main._fire("dragenter", ev({ dataTransfer: dtDocs([doc("trace.log", "ready\n"), doc("state.json", '{"ready":true}')]), clientX: 400, clientY: 300 }));
  rect(rail(), 38);
  main._fire("drop", ev({ dataTransfer: dtDocs([doc("trace.log", "ready\n"), doc("state.json", '{"ready":true}')]), clientX: 400, clientY: 20 }));
  await sleep(10);
  ok("plain text and JSON drops use their generic document kinds",
     opens().length === 2 && opens().map((m) => m.name + ":" + m.kind).join() === "trace.log:text,state.json:json");

  // binary vs text encoding: the engine decodes base64 only for binary kinds, so the client must split the same
  // way — a README sent as base64 would render as its own base64.
  ws.clear();
  main._fire("dragenter", ev({ dataTransfer: dtDocs([doc("paper.pdf", "%PDF-1.4\n")]), clientX: 400, clientY: 300 }));
  rect(rail(), 38);
  main._fire("drop", ev({ dataTransfer: dtDocs([doc("paper.pdf", "%PDF-1.4\n")]), clientX: 400, clientY: 20 }));
  await sleep(10);
  ok("a BINARY kind (pdf) is sent base64; a text kind is not",
     opens().length === 1 && opens()[0].kind === "pdf" && opens()[0].data === b64("%PDF-1.4\n"));

  // with a document already open the STRIP itself is the target — no second surface is invented
  store.applyEvent({ type: "content.show", sessionId: "A", contentId: "c1", kind: "markdown", name: "a.md", url: "/content/c1" });
  await sleep(5);
  ok("a document tab is open", !tabsEl.hidden && tabsEl._childList.length >= 2);
  ws.clear();
  main._fire("dragenter", ev({ dataTransfer: dtDocs([doc("three.md")]), clientX: 400, clientY: 300 }));
  ok("with tabs on screen no rail is drawn — the strip IS the target", !rail());
  ok("an armed strip is lifted above the drop veil", tabsEl._cls.has("drop-armed"));
  rect(tabsEl, 34);
  main._fire("dragover", ev({ dataTransfer: dtDocs([doc("three.md")]), clientX: 400, clientY: 12 }));
  ok("the strip marks itself as the live target", tabsEl._cls.has("drop-over"));
  main._fire("drop", ev({ dataTransfer: dtDocs([doc("three.md")]), clientX: 400, clientY: 12 }));
  await sleep(8);
  ok("drop on the strip opens another document", opens().length === 1 && opens()[0].name === "three.md");
  ok("the strip drops its target marking afterwards", !tabsEl._cls.has("drop-over"));

  // The engine reports a failed content.open on the SESSION SNAPSHOT + error channel — the same one that carries
  // create/rename/setProject/restart repairs. It must be routed by operation, or an unopenable file lands in the
  // create-repair surface and reads as "that name is already taken".
  let createRejected = 0;
  store.on("session:createRejected", () => { createRejected++; });
  store.applyEvent({ type: "session.created", sessionId: "A", cwd: "/a", name: "alpha", live: true, pid: 1,
    error: { code: "content_failed", operation: "content.open", path: "/a/gone.md", message: "Could not open this content." } });
  ok("a failed content.open is toasted with the engine's own message", (() => {
    const t = document.getElementById("toast-content-open:/a/gone.md");
    return !!t && /gone\.md/.test(t.textContent) && /Could not open this content/.test(t.textContent);
  })());
  ok("a failed content.open is NOT mistaken for a rejected session create", createRejected === 0);
  ok("the session itself is untouched by the failure", store.sessions.get("A").live === true);

  console.log(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
} catch (e) { console.log("THREW", e && e.stack || e); fail++; }
process.exit(fail === 0 ? 0 : 1);
