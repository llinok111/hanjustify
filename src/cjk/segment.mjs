/**
 * CJK-aware segmentation: text -> Knuth-Plass item stream.
 *
 * Why this module has to exist
 * ----------------------------
 * Upstream `src/formatter.js` tokenises with `text.match(/\S+/g)`. A Chinese
 * sentence has no spaces, so an entire paragraph collapses into a *single* box.
 * The Knuth-Plass engine then sees zero break opportunities and returns an empty
 * break list -- the paragraph cannot be set at all. This was reported upstream as
 * issue #18 ("Chinese Support", closed without a fix); the maintainer's reply was
 * "the algorithm itself can handle Chinese, but my implementation probably does
 * not".
 *
 * Measured on the unmodified engine with 20px uniform metrics:
 *   formatter('中文排版需要断行，但浏览器只做贪心。').justify(text)
 *     -> nodes.length === 3      (one box holding the whole sentence)
 *     -> linebreak(nodes, [200]) -> breaks.length === 0
 *   formatter('The quick brown fox').justify(text)
 *     -> nodes.length === 9      -> breaks.length === 5
 *
 * So the defect is not in the algorithm; it is in the item model for a script
 * that has no inter-word spaces. Fixing it means building the item stream the
 * algorithm actually wants.
 *
 * Item model
 * ----------
 * Text is reduced to *units*: one Han/Kana/Hangul character, one unsplittable
 * pair (`——` / `……`), one Latin run, or one word space (absorbed by the
 * following boundary). Between two adjacent units there is exactly one boundary,
 * and every boundary emits exactly one glue:
 *
 *   breakable  ->  glue(w, stretch, shrink) , penalty(0, 0, 0)
 *   blocked    ->  penalty(0, INF)         , glue(w, stretch, shrink)
 *
 * Four consequences of that choice are load-bearing:
 *
 * 1. A blocked boundary must emit `penalty(INF)` *followed by* the glue, never a
 *    bare `penalty(INF)`. The upstream main loop refuses to create a break
 *    candidate when the previous item is a penalty of INF (see `isNonDiscardable`
 *    in src/linebreak.js) but it still accumulates the glue's width/stretch/shrink
 *    into `sum`. Emitting the glue after the barrier therefore yields a gap that
 *    participates in justification yet can never be broken -- exactly what a
 *    Chinese 禁则 position means. A bare barrier would discard the justification
 *    capacity and make narrow columns unsolvable.
 *
 * 2. Never place two glues next to each other. A glue whose predecessor is a glue
 *    is not a break candidate at all (same `isNonDiscardable` check), so an
 *    accidental `glue, glue` pair silently deletes a break opportunity. This is
 *    why a word space is absorbed into the boundary that precedes it instead of
 *    being emitted as its own item: one boundary, one glue, carrying the space's
 *    width. `validateItems()` asserts this invariant so a future edit cannot
 *    regress it.
 *
 * 3. Punctuation compression (标点挤压, clreq §5.1.1.1) is modelled as *shrink on
 *    the following boundary*, not as a `box(½em) + glue(½em)` pair. Both give a
 *    1em natural width collapsible to ½em, but the pair form creates item 2's
 *    forbidden adjacent-glue pattern and destroys the next break opportunity.
 *
 * 4. A Latin run wider than the measure gets *emergency break points* inside it.
 *    Without them the engine has no feasible solution at all and returns an empty
 *    break list, i.e. the paragraph silently disappears (this is what upstream
 *    does with a long URL). The break points are flagged penalties carrying the
 *    hyphen width, so the demerits formula makes the engine prefer any normal
 *    break and fall back to splitting the token only when nothing else is
 *    possible -- the same role hyphenation plays in TeX.
 *
 * Break opportunities come from UAX#14 (`linebreak`) intersected with the kinsoku
 * rules from kinsoku.mjs. UAX#14 alone is not sufficient for Chinese: it offers a
 * break between the two em dashes of `——`, which clreq §5.1 第6项 forbids
 * (破折号不得断开).
 */
import {
  isCJK,
  isCJKText,
  LINE_START_FORBIDDEN,
  LINE_END_FORBIDDEN,
  COMPRESSIBLE_PUNCTUATION,
  isUnsplittablePair,
  CJK_LATIN_GAP_EM,
  DEFAULT_CJK_STRETCH_EM,
} from './kinsoku.mjs';

export const ITEM_BOX = 'box';
export const ITEM_GLUE = 'glue';
export const ITEM_PENALTY = 'penalty';
export const INFINITY_PENALTY = 10000;

/** Penalty attached to an emergency break inside an overlong Latin token. */
export const EMERGENCY_BREAK_PENALTY = 5000;

const makeBox = (width, value) => ({ type: ITEM_BOX, width, value });
const makeGlue = (width, stretch, shrink, isSpace = false) =>
  ({ type: ITEM_GLUE, width, stretch, shrink, space: isSpace });
const makePenalty = (width, p, flagged = 0) => ({ type: ITEM_PENALTY, width, penalty: p, flagged });

/* ------------------------------------------------------------------ *
 * UAX#14 break opportunities
 * ------------------------------------------------------------------ */

let LineBreaker = null;
let lineBreakerUnavailable = false;

/** Synchronous injection point for tests and pre-bundled browser builds. */
export function setLineBreaker(ctor) {
  LineBreaker = ctor;
  lineBreakerUnavailable = false;
}

/** True when the UAX#14 provider is installed and loaded. */
export function hasLineBreakerProvider() {
  return LineBreaker !== null;
}

/**
 * `linebreak` is a dependency, not a peer. Load it once and remember the failure
 * so the CLI can print an actionable message instead of a stack trace.
 */
export async function ensureLineBreaker() {
  if (LineBreaker) return LineBreaker;
  if (lineBreakerUnavailable) return null;
  try {
    const mod = await import('linebreak');
    LineBreaker = mod.default ?? mod;
  } catch {
    lineBreakerUnavailable = true;
  }
  return LineBreaker;
}

/**
 * Degraded break opportunities for environments without UAX#14.
 *
 * Deliberately conservative: it offers a break only between two Han characters,
 * and after a space. Both are unconditionally breakable under UAX#14 (ideographic
 * characters are class ID, spaces are class SP and LB18 allows a break after
 * them), so the set is a strict *subset* of the real answer -- it can under-break
 * but never over-break.
 *
 * What it intentionally does not attempt: script edges, punctuation clustering, or
 * anything depending on a character's line-break class. An earlier version added a
 * break at every Han↔non-Han edge and was measurably wrong -- it offered breaks
 * immediately before `。` and immediately before a space, neither of which UAX#14
 * permits (LB7 forbids a break before SP; closing punctuation is class CL and
 * forbids a break before it). Because the segmenter feeds these positions straight
 * into the item stream, an over-permissive fallback would silently relax 禁则 on
 * exactly the machines least able to detect it. `test/segment.test.mjs` pins the
 * subset property against real UAX#14 output.
 */
export function fallbackBreakOpportunities(text) {
  const cps = [...text];
  const out = new Set();
  for (let i = 1; i < cps.length; i++) {
    const prev = cps[i - 1];
    const next = cps[i];
    // Intersecting with the kinsoku tables is what makes this a subset rather
    // than merely a different answer. Two Han characters are normally breakable,
    // but not when the second one is a closing mark: `果` followed by `。` is
    // class ID followed by class CL, and LB13 forbids a break before CL. Without
    // this filter the fallback reported `果|。` as breakable while UAX#14 did not
    // -- an over-permissive degraded mode, which is the one direction that must
    // never happen.
    if (LINE_START_FORBIDDEN.has(next) || LINE_END_FORBIDDEN.has(prev)) continue;
    if (prev === ' ' || prev === '\t') { out.add(i); continue; }
    if (isCJK(prev.codePointAt(0)) && isCJK(next.codePointAt(0))) out.add(i);
  }
  return out;
}

/**
 * Set of code-point indices where UAX#14 permits a break.
 * Index `i` means "a line may end after code point i-1 and begin at i".
 */
export function breakOpportunities(text, ctor) {
  const impl = ctor ?? LineBreaker;
  if (!impl) return fallbackBreakOpportunities(text);
  const length = [...text].length;
  const out = new Set();
  const breaker = new impl(text);
  let bk;
  while ((bk = breaker.nextBreak())) {
    if (bk.position > 0 && bk.position < length) out.add(bk.position);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Boundary classification
 * ------------------------------------------------------------------ */

/**
 * Decide whether the boundary between `prev` and `next` may break.
 *
 * Priority is deliberate: both prohibition rules are checked against the same
 * boundary, and the line-start rule is evaluated first. When the two conflict --
 * e.g. `（` (line-end forbidden) immediately followed by `）` (line-start
 * forbidden) -- the boundary is blocked either way, so the order only changes
 * which reason is reported. `hanjustify audit` counts both reasons separately, so
 * a regression in the rule tables shows up as a shift in those counts.
 */
export function classifyBoundary(prev, next, { uax14Allows, kinsoku = true, compress = true, em }) {
  let breakable = !!uax14Allows;
  let reason = breakable ? null : 'uax14';

  if (kinsoku) {
    if (LINE_START_FORBIDDEN.has(next)) {
      breakable = false;               // 行首禁则: `next` may not open a line
      reason = 'line-start-forbidden';
    } else if (LINE_END_FORBIDDEN.has(prev)) {
      breakable = false;               // 行尾禁则: `prev` may not close a line
      reason = 'line-end-forbidden';
    }
  }
  if (isUnsplittablePair(prev, next)) {
    breakable = false;
    reason = 'unsplittable-pair';
  }

  // clreq §5.1.1.1 / GB/T 15834: a fullwidth stop mark may compress toward half
  // an em when a line would otherwise be loose or overfull.
  const shrink = compress && COMPRESSIBLE_PUNCTUATION.has(prev) ? em * 0.5 : 0;
  return { breakable, shrink, reason };
}

const KINSOKU_REASONS = new Set(['line-start-forbidden', 'line-end-forbidden', 'unsplittable-pair']);

/* ------------------------------------------------------------------ *
 * Tokenization
 * ------------------------------------------------------------------ */

/**
 * Split into units. A unit is one Han char, one unsplittable pair, one maximal
 * Latin run, or one collapsed space run.
 */
function tokenize(cps) {
  const units = [];
  let i = 0;
  while (i < cps.length) {
    const ch = cps[i];

    if (ch === ' ' || ch === '\t') {
      let j = i;
      while (j < cps.length && (cps[j] === ' ' || cps[j] === '\t')) j++;
      units.push({ type: 'space', text: ' ', count: j - i });
      i = j;
      continue;
    }

    if (i + 1 < cps.length && isUnsplittablePair(ch, cps[i + 1])) {
      units.push({ type: 'pair', text: ch + cps[i + 1] });
      i += 2;
      continue;
    }

    if (isCJKText(ch.codePointAt(0))) {
      units.push({ type: 'cjk', text: ch });
      i++;
      continue;
    }

    let j = i;
    while (j < cps.length) {
      const c = cps[j];
      if (c === ' ' || c === '\t') break;
      if (isCJKText(c.codePointAt(0))) break;
      if (j + 1 < cps.length && isUnsplittablePair(c, cps[j + 1])) break;
      j++;
    }
    units.push({ type: 'latin', text: cps.slice(i, j).join('') });
    i = j;
  }
  return units;
}

/* ------------------------------------------------------------------ *
 * Segmentation
 * ------------------------------------------------------------------ */

/**
 * Segment one paragraph (no newlines) into an item stream.
 *
 * @param {string} text
 * @param {(s: string) => number} measure advance-width function
 * @param {object} [options]
 * @param {Iterable<number>} [options.opportunities] precomputed UAX#14 positions
 * @param {boolean}  [options.kinsoku=true]
 * @param {boolean}  [options.compress=true]
 * @param {number}   [options.em] ideographic em in px; defaults to measure('中')
 * @param {number}   [options.cjkStretchEm=0.05] inter-character stretch / em
 * @param {number}   [options.cjkShrinkEm=0]     inter-character shrink / em
 * @param {boolean}  [options.cjkLatinGap=true]  clreq §2.1.3 gap at script edges
 * @param {number}   [options.maxWidth] measure for emergency-break detection
 * @returns {{items: Array, diagnostics: object}}
 */
export function segmentParagraph(text, measure, options = {}) {
  const {
    opportunities,
    kinsoku = true,
    compress = true,
    em = measure('中'),
    cjkStretchEm = DEFAULT_CJK_STRETCH_EM,
    cjkShrinkEm = 0,
    cjkLatinGap = true,
    maxWidth = Infinity,
    emergencyBreaks = true,
    emergencyThreshold = 0.9,
    breaker = undefined,
  } = options;

  const cps = [...text];
  const units = tokenize(cps);
  const allowed = new Set(opportunities ?? breakOpportunities(text, breaker));

  const items = [];
  const diagnostics = {
    units: units.length,
    boxes: 0,
    breakableBoundaries: 0,
    blockedByKinsoku: 0,
    blockedByUax14: 0,
    compressedMarks: 0,
    scriptGaps: 0,
    collapsedSpaces: 0,
    emergencyBreakTokens: 0,
    emergencyBreakPoints: 0,
    /**
     * Paragraph-relative code-point offsets of the discretionary breaks inserted
     * inside overlong Latin tokens. These are *deliberately* not UAX#14
     * opportunities -- they are the override that keeps an unbreakable token from
     * making the paragraph unsolvable -- so the auditor needs to know about them
     * or it would report a legitimate break as illegal.
     */
    emergencyBreakOffsets: new Set(),
  };

  const charWidth = cp => {
    const w = measure(String.fromCodePoint(cp));
    return Number.isFinite(w) ? w : em * 0.5;
  };

  // Record each unit's starting code-point index so boundary decisions can be
  // cross-checked against the UAX#14 position set.
  let cpIndex = 0;
  for (const u of units) {
    u.start = cpIndex;
    cpIndex += [...u.text].length;
  }

  const hyphenWidth = measure('-');

  /**
   * A Latin run that is too long to share a line gets discretionary break points.
   *
   * Why this is required and not cosmetic: the engine rejects a line whose items
   * carry zero flexibility. A line holding one unbreakable box narrower than the
   * measure has `stretch === 0`, so its ratio is `Infinity`, `isFeasibleRatio()`
   * rejects it, and the paragraph ends up with *no* feasible break sequence at all
   * -- the engine returns an empty list and the text vanishes instead of being set
   * badly. Any token that occupies most of a line and cannot be joined by a
   * neighbouring unit hits this, which is exactly the long-URL / long-identifier
   * case.
   *
   * The break points are flagged penalties with a value high enough that the
   * engine only ever uses them as a last resort: whenever a normal break sequence
   * exists it wins on demerits, so inserting these costs nothing in the common
   * case and rescues the pathological one.
   */
  function emitLatinUnit(u) {
    const runCps = [...u.text];
    const fullWidth = measure(u.text);
    const needsSplit = emergencyBreaks
      && Number.isFinite(maxWidth)
      && runCps.length > 1
      && fullWidth > maxWidth * emergencyThreshold;

    if (!needsSplit) {
      items.push(makeBox(fullWidth, u.text));
      diagnostics.boxes++;
      return;
    }

    // Split into `ceil(width / measure)` chunks (at least two, so the token is
    // actually broken) distributed evenly over code points. Greedy "fill to the
    // measure" would yield a single chunk for a token that is merely close to the
    // measure and insert no break points at all.
    const chunkCount = Math.max(2, Math.ceil(fullWidth / maxWidth));
    const perChunk = Math.ceil(runCps.length / chunkCount);
    const chunks = [];
    for (let a = 0; a < runCps.length; a += perChunk) {
      chunks.push(runCps.slice(a, Math.min(a + perChunk, runCps.length)).join(''));
    }

    diagnostics.emergencyBreakTokens++;
    let consumed = 0;
    for (let c = 0; c < chunks.length; c++) {
      items.push(makeBox(measure(chunks[c]), chunks[c]));
      diagnostics.boxes++;
      consumed += [...chunks[c]].length;
      if (c < chunks.length - 1) {
        // Penalty only -- deliberately no glue.
        //
        // A word split across lines must not gain a stretchable gap *inside*
        // itself: if the engine keeps both fragments on one line, a glue here
        // would be stretched and open a hole in the middle of the token. A bare
        // penalty is already a valid break candidate for the engine (the main loop
        // runs `mainLoop` for every penalty whose value is below infinity), so no
        // glue is needed to create the opportunity.
        //
        // Width is 0: no hyphen glyph is inserted, matching CSS
        // `overflow-wrap: anywhere`. Also keeps the engine's internal width
        // bookkeeping exact -- its cumulative totals add penalty widths while its
        // running sum does not, so a non-zero-width penalty skews the next line.
        items.push(makePenalty(0, EMERGENCY_BREAK_PENALTY, 1));
        diagnostics.emergencyBreakPoints++;
        diagnostics.emergencyBreakOffsets.add(u.start + consumed);
      }
    }
  }

  for (let k = 0; k < units.length; k++) {
    const u = units[k];

    if (u.type === 'space') continue; // absorbed into the following boundary

    if (u.type === 'pair') {
      const w = [...u.text].reduce((a, ch) => a + charWidth(ch.codePointAt(0)), 0);
      items.push(makeBox(w, u.text));
      diagnostics.boxes++;
    } else if (u.type === 'cjk') {
      items.push(makeBox(charWidth(u.text.codePointAt(0)), u.text));
      diagnostics.boxes++;
    } else {
      emitLatinUnit(u);
    }

    // --- boundary to the next non-space unit ---
    let n = k + 1;
    let sawSpace = false;
    while (n < units.length && units[n].type === 'space') {
      sawSpace = true;
      diagnostics.collapsedSpaces += units[n].count - 1;
      n++;
    }
    if (n >= units.length) break;

    const nextUnit = units[n];
    const prevText = u.text;
    const prevLast = prevText[prevText.length - 1];
    const nextFirst = [...nextUnit.text][0];

    const cls = classifyBoundary(prevLast, nextFirst, {
      uax14Allows: allowed.has(nextUnit.start),
      kinsoku,
      compress,
      em,
    });

    let width = 0;
    let stretch = em * cjkStretchEm;
    let shrink = cls.shrink + em * cjkShrinkEm;

    if (sawSpace) {
      width = measure(' ');
      stretch = Math.max(stretch, em * 0.2);
      shrink += em * 0.1;
    } else if (cjkLatinGap) {
      // clreq §2.1.3 第2项: at most 1/4 em where Han meets Western text, and the
      // gap is closable so it disappears at a line edge (行末不加空白).
      const prevIsCJK = isCJKText(prevLast.codePointAt(0));
      const nextIsCJK = isCJKText(nextFirst.codePointAt(0));
      if (prevIsCJK !== nextIsCJK) {
        const gap = em * CJK_LATIN_GAP_EM;
        width += gap;
        shrink += gap;
        diagnostics.scriptGaps++;
      }
    }

    if (cls.breakable) {
      // Exactly one glue, no trailing penalty.
      //
      // This mirrors upstream's own inter-word break convention: `justify()` in
      // src/formatter.js emits a bare `glue(spaceWidth, stretch, shrink)` between
      // words and nothing else, because a glue whose predecessor is a box is
      // already a break candidate and a break at a glue discards it. Adding a
      // `penalty(0)` after the glue would create a *second* candidate at the same
      // position -- one where the glue is retained in the line -- which lets the
      // engine buy flexibility by ending a line on a space. The visible symptom is
      // a right edge that stops short by one space width, i.e. upstream issue #19
      // ("many lines include a space before the closing tag, which leaves the
      // right edge of the text slightly mis-aligned").
      items.push(makeGlue(width, stretch, shrink, sawSpace));
      diagnostics.breakableBoundaries++;
    } else {
      items.push(makePenalty(0, INFINITY_PENALTY, 0));
      items.push(makeGlue(width, stretch, shrink, sawSpace));
      if (KINSOKU_REASONS.has(cls.reason)) diagnostics.blockedByKinsoku++;
      else diagnostics.blockedByUax14++;
    }
    if (cls.shrink > 0) diagnostics.compressedMarks++;
  }

  // Paragraph terminator: infinite stretch so the last line is never stretched to
  // full measure, then a forced break the engine can always reach.
  items.push(makeGlue(0, INFINITY_PENALTY, 0));
  items.push(makePenalty(0, -INFINITY_PENALTY, 1));

  return { items, diagnostics };
}

/**
 * Cheap structural invariants. Used by tests and by `hanjustify audit` so a bad
 * item stream is caught before it reaches the engine, where the symptom would be
 * a silently empty break list rather than an error.
 */
export function validateItems(items) {
  const problems = [];
  if (!Array.isArray(items) || items.length === 0) {
    problems.push('item stream is empty');
    return problems;
  }
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (![ITEM_BOX, ITEM_GLUE, ITEM_PENALTY].includes(it.type)) {
      problems.push(`item ${i}: unknown type ${JSON.stringify(it.type)}`);
      continue;
    }
    if (!Number.isFinite(it.width)) problems.push(`item ${i}: non-finite width`);
    if (it.type === ITEM_GLUE) {
      if (!Number.isFinite(it.stretch)) problems.push(`item ${i}: non-finite stretch`);
      if (!Number.isFinite(it.shrink)) problems.push(`item ${i}: non-finite shrink`);
      if (i > 0 && items[i - 1].type === ITEM_GLUE) {
        problems.push(`item ${i}: adjacent glue -- the second can never be a break candidate`);
      }
    }
  }
  const last = items[items.length - 1];
  if (!(last.type === ITEM_PENALTY && last.penalty === -INFINITY_PENALTY)) {
    problems.push('item stream does not end with a forced-break penalty');
  }
  if (!items.some(it => it.type === ITEM_BOX)) problems.push('item stream contains no boxes');
  return problems;
}
