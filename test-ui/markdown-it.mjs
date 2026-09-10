// IT — the markdown document view. Runs the REAL renderer over the committed torture fixture (the same file the
// browser gate renders), then the REAL dock shell for the per-tab Rendered|Source toggle.
//
// The gaps under test are the ones that made the old output look broken: nested lists (it read the indent and
// threw it away, so every README flattened), images (absent entirely), hard line breaks (reflowed away),
// h5/h6, and heading anchors.
import { readFileSync } from "node:fs";
import { installFakeDom } from "./fakedom.mjs";
const dom = installFakeDom();

const { renderMarkdown } = await import("../public/js/ui/content-renderers.js");

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n); } };
const MD = readFileSync(new URL("./fixtures/torture.md", import.meta.url), "utf8");
const kids = (el) => el._kids || [];
const findAll = (el, tag, out = []) => { for (const c of kids(el)) { if (c.tag === tag) out.push(c); findAll(c, tag, out); } return out; };
const depthOf = (el, tag, d = 0) => Math.max(d, ...kids(el).map((c) => depthOf(c, tag, d + (c.tag === tag ? 1 : 0))), d);

try {
  const doc = renderMarkdown(MD);

  // ── nested lists: the biggest visual gap ──
  ok("unordered lists nest three levels deep", depthOf(doc, "ul") >= 3);
  ok("ordered lists nest", depthOf(doc, "ol") >= 2);
  ok("a nested list lives INSIDE its parent li, not as a sibling", (() => {
    const li = findAll(doc, "li").find((x) => kids(x).some((c) => c.tag === "ul" || c.tag === "ol"));
    return !!li;
  })());
  ok("task list renders a checkbox, not literal [x]", (() => {
    const tasks = findAll(doc, "li").filter((x) => x.className.includes("md-task"));
    return tasks.length === 2 && tasks.some((t) => t.className.includes("done")) && !/\[[ xX]\]/.test(doc.textContent);
  })());

  // ── item CONTINUATION: markdown wraps one item across source lines, and every one of those lines belongs to
  //    the item. The old builder ended the whole list at the first non-marker line and dropped the remainder into
  //    top-level paragraphs, so a wrapped bullet visibly snapped back to the page margin halfway through itself. ──
  const liWith = (frag) => findAll(doc, "li").find((x) => x.textContent.includes(frag));
  ok("a wrapped item keeps its continuation inside the <li>", (() => {
    const li = liWith("ruler does");
    return !!li && li.textContent.includes("A long item the author wrapped");
  })());
  ok("NO list content escapes into a page-level paragraph", (() => {
    const stray = kids(doc).filter((c) => c.className === "md-p" &&
      /ruler does|stray paragraphs|stays inside the bullet|two source lines/.test(c.textContent));
    return stray.length === 0;
  })());
  ok("wrapped items still produce ONE item per marker, not one per line", (() => {
    const li = liWith("ruler does");
    return li && li.parentNode.tag === "ul" && kids(li.parentNode).length === 2;
  })());
  ok("an ordered item folds its continuation too", (() => {
    const li = liWith("An ordered item wrapped");     // fragment must be unique: "two source lines" also appears above
    return !!li && li.parentNode.tag === "ol" && li.textContent.includes("two source lines.") && kids(li.parentNode).length === 2;
  })());

  // ── tight vs loose: a blank line between items is the author asking for air ──
  ok("blank-separated items make the list LOOSE", (() => {
    const li = liWith("First loose item");
    return !!li && li.parentNode.className.includes("md-loose");
  })());
  ok("a list with no blank lines stays TIGHT", (() => {
    const li = liWith("ruler does");
    return !!li && !li.parentNode.className.includes("md-loose");
  })());

  // ── an item is a real block container: it holds whatever a document holds ──
  ok("an item can carry a second paragraph", (() => {
    const li = liWith("stays inside the bullet");
    return !!li && kids(li).filter((c) => c.className === "md-p").length === 2;
  })());
  ok("an item can carry a fenced code block", (() => {
    const li = liWith("a fenced block, inside a bullet");
    const pre = kids(li || {}).find((c) => c.className === "md-code");
    return !!pre && pre.dataset.lang === "txt";
  })());
  ok("a nested list under a continuation still nests inside its item", (() => {
    const li = liWith("And a nested list under the continuation");
    const sub = kids(li || {}).find((c) => c.tag === "ul");
    return !!sub && kids(sub).length === 2;
  })());

  // ── one block-start predicate for paragraphs and items alike: a rule after a paragraph is a rule ──
  ok("a horizontal rule right after a paragraph is not swallowed by it", (() => {
    const d = renderMarkdown("Text\n---\nMore");
    return kids(d).length === 3 && kids(d)[0].textContent === "Text" && kids(d)[1].tag === "hr";
  })());

  // ── images ──
  ok("images render as <img> with alt text", (() => {
    const html = kids(doc).map((c) => c.innerHTML || "").join("");
    return /<figure class="md-figure"><img class="md-img"[^>]+alt="A placeholder diagram"[^>]*><figcaption>A placeholder diagram<\/figcaption><\/figure>/.test(html);
  })());

  // ── hard breaks ──
  ok("two-space hard breaks become <br>, not reflowed text", (() => {
    const p = kids(doc).find((c) => (c.innerHTML || "").includes("two-space break"));
    return p && (p.innerHTML.match(/<br>/g) || []).length >= 2;
  })());

  // ── headings ──
  ok("h1–h6 all render", ["h1", "h2", "h3", "h4", "h5", "h6"].every((t) => findAll(doc, t).length > 0));
  ok("every heading gets a unique anchor id", (() => {
    const hs = ["h1", "h2", "h3", "h4", "h5", "h6"].flatMap((t) => findAll(doc, t));
    const ids = hs.map((x) => x.id);
    return ids.every((i) => i && i.startsWith("md-")) && new Set(ids).size === ids.length;
  })());

  // ── existing constructs must not regress ──
  ok("tables keep thead + body rows", (() => {
    const t = findAll(doc, "table")[0];
    return t && findAll(t, "th").length === 4 && findAll(t, "tr").length === 5;
  })());

  // ── editorial treatments, all earned from existing constructs (no invented syntax) ──
  ok("h1 goes two-tone across the author's em-dash", (() => {
    const h1 = findAll(doc, "h1")[0];
    return h1 && /class="md-h1-sub">—/.test(h1.innerHTML) && h1.innerHTML.indexOf("md-h1-sub") > 0;
  })());
  // The sub-half is INLINE now, so the author's space before the dash is load-bearing — without it the
  // headline reads "trades— curated". It was invisible while the span was display:block.
  ok("the space before the author's dash survives into the headline",
     / <span class="md-h1-sub">/.test(findAll(doc, "h1")[0].innerHTML));
  ok("an h1 with no dash stays one tone", !/md-h1-sub/.test((renderMarkdown("# Plain title")._kids[0].innerHTML)));
  ok("blockquote becomes a callout with a mono label from the leading bold", (() => {
    const q = findAll(doc, "blockquote")[0];
    const label = kids(q).find((c) => c.className === "md-callout-label");
    return label && label.textContent === "Note" && !/\*\*/.test(q.textContent);
  })());
  ok("a blockquote with no leading bold has no label", (() => {
    const q = findAll(renderMarkdown("> just a quote"), "blockquote")[0];
    return q && !kids(q).some((c) => c.className === "md-callout-label");
  })());
  ok("a column that is pure `code` in EVERY row becomes a badge column", findAll(doc, "td").filter((td) => td.className.includes("md-chip-cell")).length === 4);

  // ── status tones: one vocabulary, two shapes ──
  // A word carries the same meaning whether it arrives as a callout label or as a chip in a table, so both
  // resolve through the same table. The vocabulary is CLOSED: an unknown word must stay neutral rather than
  // be given a confident wrong colour.
  {
    const tone = (src, sel) => { const el = findAll(renderMarkdown(src), sel)[0]; return el ? el.className : ""; };
    ok("a Warning callout is amber", /md-tone-warn/.test(tone("> **Warning:** the disk is nearly full", "blockquote")));
    ok("a Failed callout is red", /md-tone-bad/.test(tone("> **Blocked:** waiting on review", "blockquote")));
    ok("a Done callout is green", /md-tone-good/.test(tone("> **Shipped:** v2 is live", "blockquote")));
    ok("a Note callout keeps the accent", /md-tone-info/.test(tone("> **Note:** worth knowing", "blockquote")));
    ok("a Draft callout is muted", /md-tone-muted/.test(tone("> **Draft:** not real yet", "blockquote")));
    ok("an unknown label gets NO tone rather than a guessed one",
       !/md-tone-/.test(tone("> **Deployment window:** 14:00 UTC", "blockquote")));
    ok("a callout with no label is untouched", !/md-tone-/.test(tone("> just a quote", "blockquote")));
    ok("the label is matched case-insensitively and past its colon", /md-tone-warn/.test(tone("> **CAUTION** mind the gap", "blockquote")));
  }
  // chips in a badge column take the tone of the word they hold — per CELL, because meaning is the cell's
  // even though shape is the column's
  {
    const t = renderMarkdown([
      "| Check | Result |", "| --- | --- |",
      "| lint | `PASSED` |", "| types | `FAILED` |", "| e2e | `SKIPPED` |", "| docs | `REVIEWED` |",
    ].join("\n"));
    const tds = findAll(t, "td").filter((td) => td.className.includes("md-chip-cell"));
    ok("the badge column is four chips", tds.length === 4);
    ok("PASSED is green", tds[0].className.includes("md-tone-good"));
    ok("FAILED is red", tds[1].className.includes("md-tone-bad"));
    ok("SKIPPED is amber", tds[2].className.includes("md-tone-warn"));
    ok("an unknown status stays neutral", !/md-tone-/.test(tds[3].className));
    ok("one FAILED among PASSEDs does not tone the whole column",
       !findAll(t, "th").some((th) => /md-tone-/.test(th.className)));
  }
  // signed figures take their own direction; a bare number is never guessed at
  {
    const t = renderMarkdown([
      "| Metric | Change |", "| --- | --- |",
      "| latency | -12ms |", "| throughput | +4.5% |", "| errors | 0 |", "| nodes | 8 |",
    ].join("\n"));
    const tds = findAll(t, "td");
    const cell = (n) => tds[n * 2 + 1].className;
    ok("a negative is red", cell(0).includes("md-neg"));
    ok("a positive is green", cell(1).includes("md-pos"));
    ok("a bare 0 is NOT coloured — whether zero is bad is the author's point, not the number's shape",
       !/md-(pos|neg)/.test(cell(2)));
    ok("a plain count is not coloured", !/md-(pos|neg)/.test(cell(3)));
  }
  {
    const t = renderMarkdown(["| Port | Note |", "| --- | --- |", "| 4100 | engine |", "| 8080 | proxy |"].join("\n"));
    ok("an unsigned numeric column gets no direction colouring at all",
       !findAll(t, "td").some((td) => /md-(pos|neg)/.test(td.className)));
  }
  {
    const t = renderMarkdown(["| Item | Note |", "| --- | --- |",
      "| dash | -- em dash lead |", "| minus | - 3 spaced |", "| prose | -abc not a figure |"].join("\n"));
    ok("a cell that merely OPENS with a dash is never read as a fall",
       !findAll(t, "td").some((td) => /md-(pos|neg)/.test(td.className)));
  }

  // ── column shape is a column decision, never one cell's (the step/call report) ──
  // Or's table: an index column and a content column, where only SOME content cells are pure `code`. Those
  // cells used to carry width:1% and the badge look, which declared the CONTENT column narrow — so the index
  // column took the table's whole slack and the content wrapped to a fraction of the width beside it.
  {
    const t = renderMarkdown([
      "| Step | Call |", "| --- | --- |",
      "| 1 | `RunPlan(run_id=…)` then `.validate()` |",
      "| 2 | `seal_input_manifest(manifest)` → `compute` |",
      "| 3 | `validate_dossier(dossier, project_root=…)` |",   // this row alone is pure code
    ].join("\n"));
    const ths = findAll(t, "th"), tds = findAll(t, "td");
    const stepTh = ths[0], callTh = ths[1];
    ok("the index column is narrowed to its content", stepTh.className.includes("md-col-tight"));
    ok("the content column is NOT narrowed — it takes the rest", !callTh.className.includes("md-col-tight"));
    ok("one pure-`code` row does not make its column a badge column",
       !tds.some((td) => td.className.includes("md-chip-cell")));
    ok("...and does not narrow the column it sits in",
       tds.filter((_, n) => n % 2 === 1).every((td) => !td.className.includes("md-col-tight")));
    ok("the index column is still right-aligned as figures", stepTh.className.includes("md-col-num"));
  }
  // Non-numeric identifiers count as index-shaped too: one token, short enough to hold on one line.
  {
    const t = renderMarkdown([
      "| Id | Detail |", "| --- | --- |",
      "| 3f2a9c1e-77b4-4c2f-9a11-6d5e0b8c4a92 | the first run of the evening |",
      "| 9b1d4e77-2a3c-4f10-8e55-1c7f2d9a6b03 | a second, longer explanation here |",
    ].join("\n"));
    const ths = findAll(t, "th");
    ok("a uuid column is index-shaped: narrowed, not half the table", ths[0].className.includes("md-col-tight"));
    ok("its content column stays wide", !ths[1].className.includes("md-col-tight"));
  }
  // A column of long single tokens is NOT index-shaped — narrowing it would starve the real content.
  {
    const t = renderMarkdown([
      "| Link | Note |", "| --- | --- |",
      "| https://example.dev/a/very/long/path/that/goes/on//forever/and/ever | short |",
      "| https://example.dev/another/extremely/long/path/segment/here/okay | also short |",
    ].join("\n"));
    ok("a long-URL column is left as a normal column", !findAll(t, "th")[0].className.includes("md-col-tight"));
  }
  // If EVERY column is index-shaped there is nothing to absorb the slack, so narrowing them all buys nothing.
  {
    const t = renderMarkdown(["| Id | Rank |", "| --- | --- |", "| a1 | 3 |", "| b2 | 7 |"].join("\n"));
    ok("when every column is index-shaped, none is narrowed",
       findAll(t, "th").every((th) => !th.className.includes("md-col-tight")));
  }
  ok("numeric table cells get tabular mono", findAll(doc, "td").filter((td) => td.className.includes("md-num")).length >= 3);
  ok("an all-numeric COLUMN is right-aligned, header included", (() => {
    const ths = findAll(doc, "th");
    const numTh = ths.filter((t) => t.className.includes("md-col-num"));
    const proseTh = ths.filter((t) => !t.className.includes("md-col-num"));
    return numTh.length === 1 && numTh[0].textContent === "N" && proseTh.length === 3;   // Tier/Component/Note stay left
  })());
  ok("tables sit in a scroll wrapper so a wide one never blows out the layout", (() => {
    const wraps = kids(doc).filter((c) => c.className === "md-table-wrap");
    return wraps.length === 1 && kids(wraps[0])[0].tag === "table";
  })());
  ok("an image-only paragraph becomes a block figure, not a <figure> inside a <p>", (() => {
    const blocks = kids(doc).filter((c) => c.className === "md-figure-block");
    return blocks.length === 1 && !kids(doc).some((c) => c.tag === "p" && (c.innerHTML || "").includes("md-figure"));
  })());
  ok("prose cells stay unstyled", findAll(doc, "td").some((td) => !td.className));
  ok("fenced code keeps its language hook for later highlighting", (() => {
    const codes = findAll(doc, "code");
    return codes.some((c) => c.className === "lang-js") && codes.some((c) => c.className === "lang-sh");
  })());
  ok("the declared language is surfaced as a corner label", (() => {
    const pres = findAll(doc, "pre");
    return pres.some((p2) => p2.dataset.lang === "js") && pres.some((p2) => p2.dataset.lang === "sh");
  })());
  ok("an image with no alt gets no caption furniture", !/md-figure/.test(renderMarkdown("![](/x.png)")._kids[0].innerHTML));
  ok("code content is text, never interpreted as markup", findAll(doc, "code").some((c) => c.textContent.includes('h("div", "md")')));
  ok("blockquote and hr render", findAll(doc, "blockquote").length === 1 && findAll(doc, "hr").length === 1);
  ok("links are rendered and scheme-sanitised", /<a href="https:\/\/example\.com"[^>]+rel="noopener noreferrer"/.test(kids(doc).map((c) => c.innerHTML || "").join("")));

  // ── the Rendered | Source toggle, per tab ──
  const dockEls = ["cd-tabs", "cd-body", "dock"];
  for (const id of dockEls) { const e = document.createElement("div"); e.id = id; document.body.appendChild(e); }
  const item = { id: "x", kind: "markdown", name: "torture.md", url: "blob:x" };
  const { __mdShellForTest } = await import("../public/js/ui/content-dock.js");
  if (typeof __mdShellForTest === "function") {
    const shell = __mdShellForTest(MD, item);
    const seg = shell.querySelectorAll(".md-seg button");
    ok("toggle offers exactly Rendered and Source", seg.length === 2 && seg[0].textContent === "Rendered" && seg[1].textContent === "Source");
    ok("Rendered is the default view", seg[0].className === "on" && !!shell.querySelector(".md-h"));
    seg[1]._fire("click");
    ok("Source shows the raw text verbatim", !!shell.querySelector(".md-src") && shell.querySelector(".md-src").textContent === MD);
    ok("the choice is stored ON THE ITEM (per tab, not global)", item.mdSource === true);
    seg[0]._fire("click");
    ok("toggling back restores the rendered document", !!shell.querySelector(".md-h") && item.mdSource === false);

    // ── colophon: bookends the eyebrow, carries the real file name, Rendered view only ──
    const colo = shell.querySelector(".md-colophon");
    ok("colophon reads clideck · Read-only view · figures regenerated from <name>",
       !!colo && colo.textContent === "clideck · Read-only view · figures regenerated from torture.md");
    ok("colophon is the LAST thing in the document", (() => {
      const doc2 = shell.querySelector(".md");
      const last = (doc2._kids || [])[(doc2._kids || []).length - 1];
      return last === colo;
    })());
    seg[1]._fire("click");
    ok("Source view carries NO colophon (it is our chrome, not the author's text)", !shell.querySelector(".md-colophon"));
    ok("Source is still verbatim with the colophon added", shell.querySelector(".md-src").textContent === MD);
    seg[0]._fire("click");
    // a nameless item must not render "from undefined"
    const anon = __mdShellForTest("# x", { id: "y", kind: "markdown" });
    ok("no file name → the clause is dropped, never 'from undefined'",
       anon.querySelector(".md-colophon").textContent === "clideck · Read-only view");
  } else ok("dock exposes the markdown shell for testing", false);

  console.log(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
} catch (e) { console.log("THREW", e && e.stack || e); fail++; }
process.exit(fail === 0 ? 0 : 1);
