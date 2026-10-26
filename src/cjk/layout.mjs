/**
 * Paragraph layout: item stream -> justified lines.
 *
 * A thin orchestration layer over the unmodified upstream engine. It exists so
 * callers get a usable API -- lines, ratios, per-line flags, aggregate quality
 * numbers -- without having to know the item model.
 *
 * Two design decisions are worth stating up front.
 *
 * 1. Reported metrics are recomputed from the item stream by this module rather
 *    than read out of the engine's internals. The engine's own width bookkeeping
 *    has a quirk: penalty widths are added into a breakpoint's cumulative totals
 *    but never into the running `sum`, so a non-zero-width penalty makes it
 *    under-count the following line by that amount (see `computeCost` /
 *    `computeSum` in src/linebreak.js). Recomputing here keeps the reported
 *    numbers exact while keeping the engine byte-identical, which matters more
 *    than making the engine's internals agree with ours.
 *
 * 2. `ratio` is *not* comparable across different `cjkStretchEm` settings, because
 *    it is slack divided by the declared flexibility. A paragraph set with
 *    `cjkStretchEm: 0.5` therefore reports smaller ratios than the same paragraph
 *    set with `0.05` even when the visible gap is identical. The comparable
 *    quantity is reported separately as `addedPerBoundaryEm` (the actual gap the
 *    justification inserts at each stretchable boundary, in em). Any benchmark
 *    that compares two configurations must use that field, not `ratio`.
 */
import { linebreak as upstreamLinebreak } from '../../dist/kernel.mjs';
import {
  segmentParagraph,
  validateItems,
  ensureLineBreaker,
  hasLineBreakerProvider,
  setLineBreaker,
  breakOpportunities,
  INFINITY_PENALTY,
  ITEM_BOX,
  ITEM_GLUE,
  ITEM_PENALTY,
} from './segment.mjs';
import { LINE_START_FORBIDDEN, LINE_END_FORBIDDEN } from './kinsoku.mjs';

export const DEFAULT_OPTIONS = Object.freeze({
  width: 400,
  tolerance: 2,
  maxTolerance: null,
  kinsoku: true,
  compress: true,
  cjkStretchEm: 0.25,
  cjkShrinkEm: 0,
  cjkLatinGap: true,
  emergencyBreaks: true,
  emergencyThreshold: 0.9,
  /**
   * Retry ladder used when the engine finds no feasible break sequence.
   *
   * The engine's own tolerance escalation (start -> start+4) is not enough for
   * every real paragraph: a document can contain one line that is inherently
   * incompressible, and the engine then reports the whole paragraph as unsolvable
   * and returns an empty list -- i.e. the text disappears. Rather than silently
   * emitting nothing, this module retries with progressively more permissive
   * settings and, as a last resort, falls back to a greedy filler so that every
   * paragraph produces at least one line. Each rung is recorded in
   * `diagnostics.ladder`, so a caller can tell exact layout from degraded layout.
   */
  fallbackLadder: [1.0, 2.5],
  demerits: null,
});

function resolveOptions(options) {
  const width = options.width ?? (Array.isArray(options.lineLengths) && options.lineLengths.length
    ? options.lineLengths[0]
    : DEFAULT_OPTIONS.width);
  const lineLengths = Array.isArray(options.lineLengths) && options.lineLengths.length
    ? options.lineLengths
    : [width];
  return { ...DEFAULT_OPTIONS, ...options, width, lineLengths };
}

/**
 * Width/stretch/shrink of the items between two break indices.
 *
 * A break at a glue discards that glue (standard TeX behaviour, and the same
 * convention the engine's `computeCost` uses), so a glue sitting exactly on the
 * break index is excluded.
 *
 * Two stretch totals are reported. `stretch` is what the engine sees and therefore
 * what its ratio is defined against. `stretchFinite` excludes the paragraph
 * terminator -- the `glue(0, INFINITY_PENALTY, 0)` before the forced break -- which
 * exists only so the engine can always reach the last line and must never be drawn
 * as real inter-character space. Rendering from `stretch` would put the entire
 * final-line slack into a visible gap after the last glyph.
 */
function measureSpan(items, from, to) {
  let width = 0;
  let stretch = 0;
  let stretchFinite = 0;
  let shrink = 0;
  let stretchBoundaries = 0;
  for (let i = from + 1; i <= to; i++) {
    const it = items[i];
    if (!it) continue;
    if (it.type === ITEM_BOX) {
      width += it.width;
    } else if (it.type === ITEM_GLUE) {
      if (i === to) continue;
      width += it.width;
      stretch += it.stretch;
      shrink += it.shrink;
      if (it.stretch > 0 && it.stretch < INFINITY_PENALTY) {
        stretchFinite += it.stretch;
        stretchBoundaries++;
      }
    } else if (it.type === ITEM_PENALTY && it.penalty !== INFINITY_PENALTY) {
      width += it.width;
    }
  }
  return { width, stretch, stretchFinite, shrink, stretchBoundaries };
}

/** Text content of the items between two break indices. */
function textSpan(items, from, to) {
  let out = '';
  for (let i = from + 1; i <= to; i++) {
    const it = items[i];
    if (!it) continue;
    if (it.type === ITEM_BOX) out += it.value;
    else if (it.type === ITEM_GLUE && i !== to && it.space) out += ' ';
  }
  return out;
}

/**
 * Renderable segments for a line: the text runs in order, each carrying the gap the
 * justification inserts *after* it.
 *
 * A caller that already knows the break points (a canvas, a PDF writer, a DOM
 * renderer) still has to distribute the slack across the line's flexible
 * boundaries to draw justified text. Doing that by eye -- e.g. by spreading the
 * slack evenly over characters -- is wrong for mixed content, because the model
 * inserts different amounts of flexibility at Han-Han boundaries, word spaces and
 * script gaps. This function reports the actual per-boundary result so every
 * renderer draws what the engine decided.
 *
 * @param {Array} items the item stream
 * @param {number} from index of the previous break (-1 for the paragraph start)
 * @param {number} to index of this line's break
 * @param {number} ratio the line's justification ratio (0 for ragged/unjustified)
 */
export function lineSegments(items, from, to, ratio) {
  const segs = [];
  const r = Number.isFinite(ratio) ? ratio : 0;
  for (let i = from + 1; i <= to; i++) {
    const it = items[i];
    if (!it) continue;
    if (it.type === ITEM_BOX) {
      segs.push({ text: it.value, gapAfter: 0, space: false });
    } else if (it.type === ITEM_GLUE) {
      if (i === to) continue; // the break discards this glue
      if (it.stretch >= INFINITY_PENALTY) continue; // paragraph terminator
      const gap = it.width + it.stretch * r;
      const prev = segs[segs.length - 1];
      if (it.space && prev) { prev.gapAfter = gap; prev.space = true; }
      else if (prev) prev.gapAfter += gap;
      else segs.push({ text: '', gapAfter: gap, space: it.space === true });
    }
  }
  return segs;
}

/** Justification ratio, using the engine's own definition so it stays comparable. */
function lineRatio({ width, stretch, shrink }, target) {
  const diff = target - width;
  if (diff > 1e-9) return stretch > 0 ? diff / stretch : Infinity;
  if (diff < -1e-9) return shrink > 0 ? diff / shrink : -Infinity;
  return 0;
}

/**
 * Optimal ragged-right setting, used only as the last rung of the ladder.
 *
 * Why not first-fit: first-fit leaves avoidably short lines (measured on the
 * long-URL corpus, it produced a 40px line where a 12-line-aware fill finds a
 * 190px one). A dynamic program over the same break candidates costs about the
 * same and is optimal for the "minimise the sum of squared leftover space"
 * objective, which is the standard definition of good ragged setting.
 *
 * Why a separate routine at all: ragged right cannot be expressed in the
 * box/glue/penalty model through this engine. TeX implements it with a per-line
 * trailing glue (`\rightskip = 0pt plus 1fil`) that the line breaker re-inserts
 * at every break; this engine has no equivalent hook, and the item stream cannot
 * supply one because the trailing glue would have to exist at *every* candidate
 * break at once. So the fallback is computed here, on the same item stream and
 * with the same break candidates, rather than by modifying the engine.
 *
 * Lines produced here are marked `ragged` on the result; they are excluded from
 * the justification statistics because no justification was applied.
 */
function optimalRagged(items, targets) {
  const isBreakCandidate = i => {
    const it = items[i];
    if (!it) return false;
    if (it.type === ITEM_PENALTY) return it.penalty < INFINITY_PENALTY;
    if (it.type === ITEM_GLUE) {
      const prev = items[i - 1];
      return !!prev && (prev.type === ITEM_BOX || (prev.type === ITEM_PENALTY && prev.penalty !== INFINITY_PENALTY));
    }
    return false;
  };

  const candidates = [];
  for (let i = 1; i < items.length; i++) if (isBreakCandidate(i)) candidates.push(i);
  const forced = items.length - 1;
  if (candidates[candidates.length - 1] !== forced) candidates.push(forced);

  const targetAt = n => targets[Math.min(n, targets.length - 1)];
  /**
   * Overflow weight. Chosen so that overflowing a line is *always* worse than
   * leaving it short: the cost of an empty-ish line is bounded by target², so any
   * overflow must cost more than that. At weight 1e6 a 1px overflow costs 1e6,
   * which exceeds the worst possible underfull cost, so the DP only overflows
   * when a single unbreakable item genuinely cannot fit -- which is the only
   * situation where overflow is unavoidable.
   */
  const OVERFULL_WEIGHT = 1e6;

  // Prefix sums so each span width is O(1).
  const pref = new Array(items.length + 1).fill(0);
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    let w = it.width || 0;
    pref[i + 1] = pref[i] + w;
  }
  const spanWidth = (from, to) => {
    let w = pref[to + 1] - pref[from + 1];
    const endIt = items[to];
    // A break at a glue discards that glue.
    if (endIt && endIt.type === ITEM_GLUE) w -= endIt.width;
    // Penalty width at the break point IS part of the line (e.g. a hyphen).
    if (endIt && endIt.type === ITEM_PENALTY && endIt.penalty !== INFINITY_PENALTY) w += endIt.width;
    return w;
  };

  const INF_COST = Number.POSITIVE_INFINITY;
  const best = new Map();
  best.set(-1, { cost: 0, prev: null, line: 0 });
  for (const end of candidates) {
    let bestForEnd = null;
    for (const [start, node] of best) {
      if (start >= end) continue;
      const width = spanWidth(start, end);
      const target = targetAt(node.line);
      const isLast = end === forced;
      const over = width - target;
      const cost = over <= 0
        ? (isLast ? 0 : over * over)
        : OVERFULL_WEIGHT * over * over;
      const total = node.cost + cost;
      if (!bestForEnd || total < bestForEnd.cost) {
        bestForEnd = { cost: total, prev: start, line: node.line + 1, end };
      }
    }
    if (bestForEnd && bestForEnd.cost < INF_COST) best.set(end, bestForEnd);
  }

  if (!best.has(forced)) return null;
  const chain = [];
  let cur = forced;
  while (cur !== null && cur !== undefined) {
    if (cur >= 0) chain.push(cur);
    const node = best.get(cur);
    if (!node || node.prev === null || node.prev === undefined) break;
    cur = node.prev;
  }
  chain.reverse();
  return chain.length ? chain : null;
}

/**
 * Lay out a single paragraph.
 *
 * @returns {{lines: Array<object>, diagnostics: object, items: Array}}
 */
export function layoutParagraph(text, measure, options = {}) {
  const opts = resolveOptions(options);
  const maxWidth = Math.max(...opts.lineLengths);
  const { items, diagnostics } = segmentParagraph(text, measure, { ...opts, maxWidth });
  const problems = validateItems(items);
  if (problems.length) {
    const err = new Error(`invalid item stream: ${problems.join('; ')}`);
    err.problems = problems;
    throw err;
  }

  // --- solve, walking the fallback ladder until a break sequence exists ---
  const ladder = [];
  let breaks = [];
  let usedTolerance = opts.tolerance;
  let loosened = false;

  const attempt = (tolerance, extraStretchEm, label) => {
    let stream = items;
    if (extraStretchEm > 0) {
      // Loosen every boundary by an extra amount of stretch. This does not move
      // any break point that was already feasible at a tighter setting -- it only
      // widens the set of lines the engine is willing to accept -- so the first
      // rung (extraStretchEm === 0) is always the exact answer when one exists.
      stream = items.map(it => it.type === ITEM_GLUE && it.stretch > 0 && it.stretch < INFINITY_PENALTY
        ? { ...it, stretch: it.stretch + measure('中') * extraStretchEm }
        : it);
      loosened = true;
    }
    const settings = { tolerance };
    if (opts.maxTolerance != null) settings.maxTolerance = opts.maxTolerance;
    if (opts.demerits) settings.demerits = opts.demerits;
    const br = upstreamLinebreak(stream, opts.lineLengths, settings);
    ladder.push({ rung: label, tolerance, extraStretchEm, breaks: br.length });
    return { br, stream };
  };

  let activeItems = items;
  {
    const r = attempt(opts.tolerance, 0, 'exact');
    breaks = r.br;
    activeItems = r.stream;
  }
  if (breaks.length === 0) {
    usedTolerance = opts.tolerance + 4;
    const r = attempt(usedTolerance, 0, 'tolerance+4');
    breaks = r.br;
    activeItems = r.stream;
  }
  for (const extra of opts.fallbackLadder) {
    if (breaks.length) break;
    const r = attempt(opts.tolerance, extra, `stretch+${extra}em`);
    breaks = r.br;
    activeItems = r.stream;
  }

  const diag = { ...diagnostics, ladder, loosened, ragged: false };

  if (breaks.length === 0) {
    // Last resort: never lose the paragraph. Set it ragged-right using an
    // optimal dynamic program over the same break candidates.
    const chain = optimalRagged(activeItems, opts.lineLengths);
    if (chain === null) {
      // Cannot even be set ragged (a single unbreakable item wider than the
      // measure with no candidate after it). Report it rather than emit nothing.
      const err = new Error('paragraph cannot be set: no reachable break candidate');
      err.code = 'EUNSETTABLE';
      err.diagnostics = { ...diag, forcedLine: true };
      throw err;
    }
    diag.ragged = true;
    diag.unsettable = true;
    breaks = [{ position: -1, ratio: NaN }, ...chain.map(pos => ({ position: pos, ratio: NaN }))];
  }

  const lines = [];
  let prev = -1;
  const lastIndex = breaks.length - 1;
  for (let b = 1; b < breaks.length; b++) {
    const end = breaks[b].position;
    const target = opts.lineLengths[Math.min(b - 1, opts.lineLengths.length - 1)];
    const span = measureSpan(activeItems, prev, end);
    const isRagged = diag.ragged;
    // Ragged lines are set at their natural width by definition, so they have no
    // justification ratio and no added gap. Reporting a ratio for them would
    // pollute every downstream statistic.
    const ratio = isRagged
      ? NaN
      : (Number.isFinite(breaks[b].ratio) ? breaks[b].ratio : lineRatio(span, target));
    const isFinalLine = b === lastIndex;
    // A final line is set at its natural width: the paragraph terminator supplies
    // effectively unlimited stretch so the engine can always reach the end, but
    // that flexibility is an algorithmic device, not something to draw.
    const justifiedWidth = (isRagged || isFinalLine)
      ? span.width
      : (Number.isFinite(ratio) ? span.width + ratio * (ratio >= 0 ? span.stretch : span.shrink) : span.width);
    const txt = textSpan(activeItems, prev, end);
    const first = [...txt][0] ?? '';
    const last = txt[txt.length - 1] ?? '';

    lines.push({
      text: txt,
      width: span.width,
      justifiedWidth,
      target,
      ratio,
      stretch: span.stretch,
      stretchFinite: span.stretchFinite,
      shrink: span.shrink,
      /**
       * Gap the justification actually inserts at each stretchable boundary, in em.
       * This is the comparable quality number; `ratio` is not (see the module
       * comment). The paragraph terminator is excluded, so a short final line
       * reports zero added gap rather than the whole leftover width.
       */
      addedPerBoundaryEm: !isRagged && !isFinalLine && Number.isFinite(ratio) && ratio > 0 && span.stretchBoundaries > 0
        ? (ratio * span.stretchFinite) / span.stretchBoundaries / measure('中')
        : 0,
      stretchBoundaries: span.stretchBoundaries,
      finalLine: isFinalLine,
      /** Set ragged because the engine found no feasible justification. */
      ragged: isRagged,
      /** No flexibility in the required direction; cannot be justified at all. */
      unsettable: !isRagged && !Number.isFinite(ratio),
      /** Wider than the measure even at full shrink. */
      overfull: (isRagged ? span.width : justifiedWidth) > target + 0.5,
      /** Stretched harder than tolerance allows; visually loose. */
      loose: !isRagged && Number.isFinite(ratio) && ratio > usedTolerance && !isFinalLine,
      /**
       * 行首禁则 violation. Segmentation suppresses every break before a
       * line-start-forbidden glyph, so this should always be false; the flag
       * exists so a rule-table regression becomes visible instead of silent.
       */
      startsWithForbidden: LINE_START_FORBIDDEN.has(first),
      /** 行尾禁则 violation at a real wrap point (final line excluded). */
      endsWithForbidden: !isFinalLine && LINE_END_FORBIDDEN.has(last),
      /**
       * Renderable runs with the gap to insert after each one, so any renderer can
       * draw exactly what the engine decided. See `lineSegments()`.
       */
      segments: lineSegments(activeItems, prev, end, isRagged ? 0 : ratio),
    });
    prev = end;
  }

  /**
   * The tightest tolerance at which this layout is valid.
   *
   * The engine escalates its own tolerance internally (from `tolerance` to
   * `maxTolerance`, default +4) and does not report which step it converged at, so
   * a caller cannot tell an exact setting from a tolerated one by looking at
   * `ratio` alone. This value is derived from the result: a layout is valid at
   * tolerance T iff every non-final line has ratio <= T.
   */
  const bodyRatios = lines.filter(l => !l.finalLine && !l.ragged).map(l => l.ratio).filter(Number.isFinite);
  diag.requiredTolerance = bodyRatios.length ? Math.max(...bodyRatios) : 0;
  diag.exactAtNominalTolerance = diag.requiredTolerance <= usedTolerance + 1e-9;

  return { lines, diagnostics: diag, items: activeItems };
}

/**
 * Lay out a whole document. Newlines are hard paragraph breaks; each paragraph is
 * solved independently, which is how the algorithm is defined (it optimises within
 * one paragraph and never across a forced break).
 */
export function layout(text, measure, options = {}) {
  const opts = resolveOptions(options);
  const paragraphs = String(text).split(/\r\n|\r|\n/);
  const allLines = [];
  const paragraphStats = [];

  for (let p = 0; p < paragraphs.length; p++) {
    const raw = paragraphs[p];
    if (raw.trim() === '') {
      paragraphStats.push({ index: p, empty: true, lineCount: 0 });
      continue;
    }
    const res = layoutParagraph(raw, measure, opts);
    for (const l of res.lines) allLines.push({ ...l, paragraph: p });
    paragraphStats.push({
      index: p,
      empty: false,
      lineCount: res.lines.length,
      diagnostics: res.diagnostics,
      /**
       * The resolved item stream. Kept so `auditLayout()` can re-verify structural
       * invariants (A7) against exactly what the engine was handed, rather than
       * against a re-segmentation that could differ.
       */
      items: res.items,
    });
  }

  return { lines: allLines, paragraphs: paragraphStats, options: opts, stats: summarize(allLines) };
}

/** Aggregate quality numbers, used by the CLI, the tests and the demo. */
export function summarize(lines) {
  const ratios = lines.map(l => l.ratio);
  const finite = ratios.filter(Number.isFinite);
  const body = lines.filter(l => !l.finalLine && !l.greedy);
  const badness = body.reduce((a, l) => {
    const r = l.ratio;
    return Number.isFinite(r) ? a + 100 * Math.abs(r) ** 3 : Number.POSITIVE_INFINITY;
  }, 0);
  const gaps = body.map(l => l.addedPerBoundaryEm).filter(Number.isFinite);
  return {
    lineCount: lines.length,
    bodyLineCount: body.length,
    maxAbsRatio: finite.length ? Math.max(...finite.map(Math.abs)) : 0,
    meanAbsRatio: finite.length ? finite.reduce((a, r) => a + Math.abs(r), 0) / finite.length : 0,
    /** Comparable across configurations, unlike `ratio`. */
    maxAddedPerBoundaryEm: gaps.length ? Math.max(...gaps) : 0,
    meanAddedPerBoundaryEm: gaps.length ? gaps.reduce((a, g) => a + g, 0) / gaps.length : 0,
    totalBadness: badness,
    unsettableLines: lines.filter(l => l.unsettable).length,
    overfullLines: lines.filter(l => l.overfull).length,
    looseLines: lines.filter(l => l.loose).length,
    raggedLines: lines.filter(l => l.ragged).length,
    kinsokuLineStartViolations: lines.filter(l => l.startsWithForbidden).length,
    kinsokuLineEndViolations: lines.filter(l => l.endsWithForbidden).length,
  };
}

export {
  ensureLineBreaker,
  hasLineBreakerProvider,
  setLineBreaker,
  breakOpportunities,
  validateItems,
  segmentParagraph,
};
