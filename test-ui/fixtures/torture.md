###### Document View · 2026-08-02

# CliDeck Document View — and what the house style earns

A deliberately punishing document: every construct the renderer supports, at the sizes real
READMEs actually use. If this page looks good, the house style holds.

## Typography and inline formatting

Body copy sits on a measured column so long paragraphs stay readable instead of running the full
width of the panel. Inline you get **bold**, *italic*, `inline_code()`, and a [link](https://example.com)
that underlines on hover. Numbers align: 1,024 · 2,048 · 4,096.

Hard breaks are honoured.  
This line follows a two-space break.  
And this one follows another.

### Nested lists, three deep

- Top level item
  - Second level, which is where the old renderer collapsed
    - Third level, still structured
    - A sibling at depth three
  - Back to second
- Another top level item

1. Ordered at the top
2. Second entry
   1. Nested ordered becomes lettered
   2. Another nested entry
3. Third entry

- [ ] An open task
- [x] A completed task

### Wrapped, loose and block-bearing items

- A long item the author wrapped across two source lines, because that is what an editor with a
  ruler does — and every one of those lines belongs to this bullet, not to the page.
- A second wrapped item, indented continuation and all, so the pair reads as a list instead of as
  bullets interleaved with stray paragraphs.

Blank lines between items are a request for air, and the list is rendered loose:

- First loose item.

- Second loose item, which carries a second paragraph of its own.

  That paragraph is indented into the item, so it stays inside the bullet.

- Third loose item, carrying a block:

  ```txt
  a fenced block, inside a bullet
  ```

  And a nested list under the continuation:

  - Nested under a wrapped item
  - A sibling of it

1. An ordered item wrapped across
   two source lines.
2. A second ordered item.

#### Blockquote

> **Note** A callout gets an accent spine, a page ground and a mono label taken from the leading bold run —
> the same form GitHub alerts already use, so no syntax was invented for it.

##### Fifth-level heading

###### Sixth-level heading

## Table

| Tier | Component | N | Note |
| --- | --- | --- | --- |
| `A` | Renderer | 18 of 18 | nested lists, images, hard breaks |
| `A` | Dock tab | 16 of 16 | rendered/source, per tab |
| `D` | Highlighting | 0 of 5 | deferred until asked |
| `E` | Table of contents | 0 | noise at this width |

## Code

```js
export function renderMarkdown(src) {
  const root = h("div", "md");
  // no dependencies, no build step
  return root;
}
```

```sh
clideck show notes.md
```

## Image

![A placeholder diagram](./diagram.png)

---

Closing paragraph after a horizontal rule, to confirm the rule's spacing and fade.
