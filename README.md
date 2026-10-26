# hanjustify

CJK-aware Knuth-Plass paragraph justification for JavaScript.

The upstream engine in this repository ([bramstein/typeset](https://github.com/bramstein/typeset)) implements
the Knuth-Plass line-breaking algorithm correctly. It cannot set Chinese text — not
because the algorithm is wrong, but because its input model assumes words are separated
by spaces:

```
$ node scripts/baseline.mjs
基线对比  width=360px  font-size=20px  metrics=uniform(Han=1em, Latin=0.5em)

  用例            上游 typeset (未改动)                         hanjustify
                  items  boxes  最宽box  断点  行数 |  UAX14  items  行数  首禁  溢出
  ----------------------------------------------------------------------------------------------
  纯中文段落             3      1     940     0     0 |     42     47     3     0     0
  含禁则标点             3      1     560     0     0 |     16     29     2     0     0
  中西混排             21     10     300     0     0 |     27     28     3     0     0
  英文对照             47     23      60     4     3 |     15     16     3     0     0
```

A 47-character Chinese paragraph becomes **one box of 940px** with **zero break
opportunities**, so the engine returns an empty break list and **zero lines**. The
English control row in the same table proves the engine itself is healthy.

This project supplies the missing input model, plus the tooling needed to trust the
output. The engine is byte-identical to upstream — pinned by SHA-256 in
`test/upstream-parity.test.mjs`.

---

## What it does

| Capability | Where | Evidence |
|---|---|---|
| Per-character item model for Han/Kana/Hangul | `src/cjk/segment.mjs` | `test/segment.test.mjs` |
| Break opportunities from UAX #14 | `linebreak` 1.1.0 | `scripts/baseline.mjs` (UAX14 column) |
| 禁则 (kinsoku): 行首 / 行尾 prohibition | `src/cjk/kinsoku.mjs` | `test/layout.test.mjs` |
| 标点挤压 (punctuation compression) | `src/cjk/segment.mjs` | `test/segment.test.mjs` |
| 破折号 / 省略号 must not split | `src/cjk/kinsoku.mjs` | `test/segment.test.mjs` |
| clreq §2.1.3 Han↔Latin gap (≤ ¼ em) | `src/cjk/segment.mjs` | `test/segment.test.mjs` |
| Headless font metrics (no DOM) | `src/cjk/font.mjs` | `test/layout.test.mjs` |
| Never lose a paragraph (fallback ladder) | `src/cjk/layout.mjs` | `test/layout.test.mjs` |
| Seven-check audit with exit codes | `src/cjk/audit.mjs` | `test/audit.test.mjs` |

## Install and run

Node 18 or newer. No native modules, no build step for library consumers.

```bash
npm install
npm run build          # generates dist/kernel.mjs from the upstream sources
npm test               # 83 tests
```

Set text and see the result:

```bash
node bin/hanjustify.js set --width 420 '中文排版长期缺少全局优化。浏览器用贪心算法逐行决定断点。'
```

```
hanjustify set — 行宽 420px · 等宽模型 20px

   1   0.00    420.0/420  |中文排版长期缺少全局优化。浏览器用贪心算法逐行决定断|
   2   0.02    240.0/420  |点。|   [末行]

  2 行 · 最大 |ratio| 0.02 · 边界最大均摊空隙 0.000em · 首禁违规 0 · 溢出 0
```

Run the audit gate (exits non-zero on failure, so it works in CI):

```bash
node bin/hanjustify.js audit --width 400 '他说：“这样可以。”然后就走了。（参见《中文排版需求》。）'
```

```
  段落 1: 通过
    ✓ A1 文本完整性        16 字符全部保留
    ✓ A2 行首禁则         1 行均无行首禁则字符
    ✓ A3 行尾禁则         无行尾禁则字符
    ✓ A4 宽度不溢出        无行超出可用收缩量
    ✓ A5 行可调整         所有非末行 ratio 有限
    ✓ A6 断点合法         0 个断点全部合法
    ✓ A7 结构不变量        item 流 40 项，结构合法
```

Use a real font instead of the fallback metrics:

```bash
node bin/hanjustify.js set --font /path/to/NotoSansSC-Regular.otf --size 18 --width 420 --file article.txt
```

Inspect the item stream that reaches the engine — this is what makes the model auditable:

```bash
node bin/hanjustify.js inspect --width 200 '他说：“好。”'
```

Library use:

```js
import { layout } from 'hanjustify';
import { loadFont } from './src/cjk/metrics.mjs';

const { measure } = loadFont('/path/to/font.ttf', { size: 18 });
const result = layout(text, measure, { width: 420 });

for (const line of result.lines) {
  console.log(line.ratio.toFixed(2), line.text);
}
```

## CLI

```
hanjustify set      [options] [text...]    lay out and print
hanjustify audit    [options] [text...]    lay out and run the 7 checks
hanjustify inspect  [options] [text...]    dump the item stream
hanjustify baseline [--json]               upstream comparison
```

Exit codes: `0` success · `1` usage or input error · `2` audit failure · `3` indeterminate.

Options: `--width`, `--line-lengths a,b,c`, `--size`, `--font`, `--face`,
`--kinsoku/--no-kinsoku`, `--compress/--no-compress`, `--stretch`, `--tolerance`,
`--no-emergency-breaks`, `--file`, `--stdin`, `--json`, `--quiet`.

## The item model

A Chinese sentence has no spaces, so the upstream formatter (`text.match(/\S+/g)`)
yields one box. The fix is an item stream built for a script without inter-word spaces:
every Han character is its own box, and every boundary between two units emits
**exactly one glue**.

```
breakable boundary   glue(width, stretch, shrink)
blocked boundary     penalty(0, INF)  then  glue(width, stretch, shrink)
```

Four consequences are load-bearing, and each is a place where a naive port silently
produces bad output:

1. **A blocked boundary must be `penalty(INF)` followed by the glue, never a bare
   barrier.** The engine's main loop refuses to create a break candidate when the
   previous item is a penalty of INF, but it still accumulates the glue's
   stretch/shrink into the running totals. Emitting the glue *after* the barrier
   therefore yields a gap that participates in justification yet can never be
   broken — which is exactly what a 禁则 position means. A bare barrier throws away
   the justification capacity and makes narrow columns unsolvable.

2. **Never place two glues next to each other.** A glue whose predecessor is a glue is
   not a break candidate at all, so an accidental `glue, glue` pair silently deletes a
   break opportunity. This is why a word space is absorbed *into* the preceding
   boundary rather than emitted as its own item: one boundary, one glue.
   `validateItems()` asserts the invariant so a future edit cannot regress it.

3. **Punctuation compression is shrink on the following boundary**, not a
   `box(½em) + glue(½em)` pair. Both give a 1em natural width collapsible to ½em, but
   the pair form creates consequence 2 and destroys the next break.

4. **A Latin token wider than the measure gets emergency break points**, otherwise the
   engine finds no feasible sequence at all and returns an empty list — the paragraph
   disappears. That is what upstream does with a long URL.

## What the kinsoku layer actually adds

Being precise about this matters, because the obvious claim is wrong. Measured over the
closing set (`。，、；：？！）》」』”`) and the opening set (`（《「“`), UAX #14 **already**
forbids a break in the required direction — they are classes CL/CP and OP — so for those
characters the kinsoku layer changes nothing. `test/layout.test.mjs` pins that with 64
controlled cases that must show zero difference.

The real increment is narrow and specific:

| Case | UAX #14 | This project | Measured |
|---|---|---|---|
| `。，、；：？！）》」』”` before-break | forbidden (CL/CP) | also forbidden | no difference, 64/64 cases |
| `（《「“` after-break | forbidden (OP) | also forbidden | no difference |
| break immediately before `——` | **allowed** (B2) | forbidden | line opens with a dash when off |
| break between `—` and `—` | forbidden | forbidden (one box) | — |
| Han↔Latin gap | no opinion | ≤ ¼ em, closable | `test/segment.test.mjs` |

So the value here is **not** "we added kinsoku to UAX #14". It is: *the engine now
receives an item stream at all*, and on top of that four narrow rules UAX #14 leaves
open — the em-dash line-start rule, the unsplittable dash/ellipsis pair, punctuation
compression, and the script gap.

The em-dash case is reproducible end to end. With the rules off a line really does open
with a dash; with them on it does not, and the browser verification asserts both
directions (B8).

## Audit

`src/cjk/audit.mjs` re-derives every fact from the output instead of trusting the flags
attached to it, so a bug in `layout()` shows up as a contradiction rather than a pass.

| Check | What it catches |
|---|---|
| A1 文本完整性 | any silently dropped or duplicated character |
| A2 行首禁则 | a line opening with a forbidden glyph |
| A3 行尾禁则 | a non-final line closing with an opening bracket |
| A4 宽度不溢出 | a line wider than its measure beyond its shrink |
| A5 行可调整 | a body line with no finite ratio |
| A6 断点合法 | a break UAX #14 did not offer and the segmenter did not declare |
| A7 结构不变量 | adjacent glues, missing terminator, non-finite widths |

A gate that always passes is worse than no gate, so most of `test/audit.test.mjs` is
negative testing: nine deliberate corruptions, each of which the corresponding check
must catch.

## Browser demo

```bash
node scripts/build-demo.mjs          # bundle demo/hanjustify.bundle.js
node scripts/verify-demo.mjs         # 12 browser assertions + screenshot
```

`demo/index.html` sets the same paragraph twice at the same measure and font — once with
browser-native `text-align: justify`, once with hanjustify's break points. The verifier
drives headless Edge/Chrome over the DevTools Protocol using Node's built-in
`WebSocket` (no puppeteer, no playwright), then checks the result **twice**: against the
DOM geometry and against the pixels of the screenshot.

The pixel pass is not decoration. It is what caught a rendering defect that every DOM
assertion had passed: the block width equalled the measure, so a DOM probe reported
"0.000px error" while the text actually stopped 27px short of the margin.

## Tests

```bash
npm test                 # 83 tests, 4 files
node scripts/test.mjs --test-name-pattern "kinsoku"
```

`scripts/test.mjs` exists because `node --test test/` fails on Windows and a *quoted*
glob argument is a Node 22 feature that silently matches nothing on Node 18/20 — a suite
that finds no files must not report success.

Current state on Node 22.22.2 / Windows 11:

```
发现 4 个测试文件
# tests 83
# pass 83
# fail 0
```

## Known limitations

- **Metrics must match the renderer.** The layout is only as good as `measure()`.
  `src/cjk/font.mjs` reads advances from `cmap`/`hmtx`, which ignores kerning, `palt`
  and variable-font axes; a page rendering with different settings will differ. Measure
  with the same engine that paints when exactness matters.
- **`ratio` is not comparable across `cjkStretchEm` settings.** It is slack divided by
  declared flexibility, so a paragraph set with `--stretch 0.5` reports smaller ratios
  than the same paragraph at `0.05` even when the visible gap is identical. Use
  `addedPerBoundaryEm` for comparisons.
- **Emergency breaks do not hyphenate.** Splitting a long Latin token inserts no hyphen
  glyph (CSS `overflow-wrap: anywhere` semantics).
- **Vertical text is out of scope.** clreq's 直排 rules are not modelled.
- **No Chinese hyphenation.** clreq does not require it and pinyin hyphenation is not
  standard practice; only Western runs inside Chinese text can be hyphenated.
- **`ragged` is a fallback, not a feature.** When no justified solution exists the
  paragraph is set ragged-right by an optimal dynamic program and the lines are flagged
  `ragged`. This is reported, never silent.
- **Browser rendering note.** The demo originally emitted one `<span>` per character and
  set the model's per-boundary gap as `margin-right`. Measured in Chromium 152: four
  punctuation glyphs (`“`, `。`, `（`, `》`) reported a 9px inline width at font-size
  18px where the correct advance is 18px; the affected lines stopped 27px short. A fresh
  element with identical markup, parent and *every* computed style property (diffed in
  full: zero differences) measured the correct 18px, so this is a browser shaping
  behaviour rather than a CSS mistake here. The demo therefore renders one text node per
  line and lets `text-align-last: justify` distribute the slack, so what the pixel check
  measures is what a reader sees.

## Licence

BSD 2-Clause, the same as upstream, so the combined work is uniformly licensed. See
`LICENSE` (upstream's text, retained as required) and `NOTICE` for the full derivation
record: which files are byte-identical upstream sources, their SHA-256, and which files
are new.

Upstream: [bramstein/typeset](https://github.com/bramstein/typeset) by Bram Stein,
commit `48ebb55`, BSD 2-Clause. Upstream's original README is preserved at
`docs/UPSTREAM-README.md`.
