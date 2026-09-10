// Clickable document paths in the terminal.
//
// An agent prints "docs/STRATEGY-IMPLEMENTATION-SPEC.md" and that should open in the viewer. The rule that
// shapes everything here: a printed path MAY NOT EXIST — it can be relative to a directory we are not in, or
// simply wrong — so EXISTENCE IS TESTED FIRST and only real files are ever decorated. A dead link is worse than
// plain text, because plain text does not promise anything.
//
// Three parts, nothing more: a matcher, a per-session cache, and one debounced batch probe.
//   • candidatesIn(text)      — path-like tokens on one line, with their 1-based xterm columns
//   • linkFor(sid, candidate) — the absolute path, or null (probed, does not exist), or undefined (not yet probed)
//   • probe(sid, texts)       — resolve only candidates this session has never seen; results land in the cache
// The terminal asks linkFor() while building links, so an unprobed or missing path is simply not a link.
import { store } from "../store.js";
import { resolveContentPaths } from "../ws.js";
import { debounce } from "../util.js";

// The extensions the ENGINE actually renders — kept in step with CONTENT_TYPES in src/content-store.js, and
// deliberately not a wishlist. `.csv` reads like an obvious candidate but the viewer has no renderer for it, so
// every .csv would cost a stat and resolve to null. `.markdown` is out for the same reason — the engine's table
// has `.md` only.
const EXT = "txt|log|json|md|html|htm|pdf|mmd|patch|diff|png|jpe?g|gif|webp|mp4|webm";
// A path-like token: an optional leading slash, then NON-EMPTY directory segments, then a filename ending in
// one of those extensions. The \b after the extension keeps trailing sentence punctuation out ("…SPEC.md." →
// "…SPEC.md") and rejects ".md5". Segments must be non-empty or "https://host/x.md" matches from its own "//",
// which puts the scheme out of reach of the guard below.
const PATH_RE = new RegExp("/?(?:[\\w.~+-]+/)*[\\w.~+-]+\\.(?:" + EXT + ")\\b", "gi");
// A token sitting inside a URL belongs to the URL provider, which already handles it — two providers decorating
// one range would double-underline it and race for the click. One-or-more slashes, because the match may itself
// have started on the second slash of "://".
const IN_URL = /[a-z][a-z0-9+.-]*:\/+\S*$/i;
const MAX_BATCH = 50;

const cache = new Map();          // sessionId -> Map(candidate -> absolutePath | null)
const pendingBySession = new Map();  // sessionId -> Set(candidate) awaiting a reply
let wired = false;

function bucket(sid) { let m = cache.get(sid); if (!m) { m = new Map(); cache.set(sid, m); } return m; }

export function candidatesIn(text) {
  const out = [];
  if (!text) return out;
  PATH_RE.lastIndex = 0;
  let m;
  while ((m = PATH_RE.exec(text))) {
    if (IN_URL.test(text.slice(0, m.index))) continue;
    out.push({ text: m[0], start: m.index + 1, end: m.index + m[0].length });   // xterm columns: 1-based, end inclusive
  }
  return out;
}

// undefined = never probed · null = probed, not a renderable file · string = the absolute path
export function linkFor(sid, candidate) { const m = cache.get(sid); return m ? m.get(candidate) : undefined; }

// Probe only what this session has never seen. Called debounced, over the VISIBLE lines only — the whole
// scrollback on every frame would be a stat storm for text nobody is looking at.
export function probe(sid, texts) {
  if (!sid || !Array.isArray(texts)) return;
  wire();
  const seen = bucket(sid);
  const pend = pendingBySession.get(sid) || new Set();
  const fresh = [];
  for (const t of texts) {
    for (const c of candidatesIn(t)) {
      if (seen.has(c.text) || pend.has(c.text) || fresh.includes(c.text)) continue;
      fresh.push(c.text);
      if (fresh.length >= MAX_BATCH) break;
    }
    if (fresh.length >= MAX_BATCH) break;
  }
  if (!fresh.length) return;
  fresh.forEach((c) => pend.add(c));
  pendingBySession.set(sid, pend);
  resolveContentPaths(sid, fresh);
}

export const probeDebounced = debounce((sid, texts) => probe(sid, texts), 220);

function wire() {
  if (wired) return;
  wired = true;
  store.on("content:resolved", (ev) => {
    const sid = ev && ev.sessionId; if (!sid) return;
    const seen = bucket(sid);
    const pend = pendingBySession.get(sid);
    const resolved = (ev && ev.resolved) || {};
    // Record MISSES as null too — that is the whole point of the cache. Without it a path that does not exist is
    // re-probed on every scan for as long as it stays on screen.
    for (const k of Object.keys(resolved)) {
      seen.set(k, typeof resolved[k] === "string" && resolved[k] ? resolved[k] : null);
      if (pend) pend.delete(k);
    }
  });
  store.on("session:remove", (id) => { cache.delete(id); pendingBySession.delete(id); });
  store.on("reset", () => { cache.clear(); pendingBySession.clear(); });
}

// test seam — the cache is module state and a test must be able to start from empty
export function __resetPathCache() { cache.clear(); pendingBySession.clear(); wired = false; }
