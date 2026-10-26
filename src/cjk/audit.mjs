/**
 * Audit: independent verification of a layout result.
 *
 * Everything here re-derives facts from the output lines rather than trusting the
 * flags attached to them, so a bug in `layout()` shows up as a contradiction
 * between the two instead of being reported as a pass. `hanjustify audit` exits
 * non-zero when any check fails, which makes the checks usable in CI.
 *
 * Checks
 * ------
 * A1 文本完整性    the concatenation of all lines (plus the spaces a break eats)
 *                  equals the input, ignoring collapsed whitespace. Catches any
 *                  silent character loss -- the failure mode this project exists
 *                  to remove.
 * A2 行首禁则      no line begins with a line-start-forbidden glyph.
 * A3 行尾禁则      no non-final line ends with a line-end-forbidden glyph.
 * A4 宽度不溢出    no line exceeds its measure beyond the shrink it actually has.
 * A5 可调性        every non-final, non-ragged line has a finite ratio.
 * A6 断点合法性    every break falls on a UAX#14 opportunity that the kinsoku
 *                  rules did not veto. This is the check that would catch a
 *                  segmentation regression which happened to still produce
 *                  plausible-looking lines.
 * A7 结构不变量    the item stream satisfies validateItems().
 */
import { validateItems, breakOpportunities, INFINITY_PENALTY, ITEM_BOX, ITEM_GLUE, ITEM_PENALTY } from './segment.mjs';
import { LINE_START_FORBIDDEN, LINE_END_FORBIDDEN, isUnsplittablePair } from './kinsoku.mjs';

const CHECKS = [
  { id: 'A1', name: '文本完整性', en: 'text integrity' },
  { id: 'A2', name: '行首禁则', en: 'line-start prohibition' },
  { id: 'A3', name: '行尾禁则', en: 'line-end prohibition' },
  { id: 'A4', name: '宽度不溢出', en: 'no overflow' },
  { id: 'A5', name: '行可调整', en: 'justifiability' },
  { id: 'A6', name: '断点合法', en: 'legal break points' },
  { id: 'A7', name: '结构不变量', en: 'item-stream invariants' },
];

/** Normalise for A1: drop all whitespace, since breaks may eat spaces. */
const squeeze = s => String(s).replace(/\s+/g, '');

/**
 * Map each wrap point back to a code-point offset in the source paragraph.
 *
 * Matching by cumulative `text.length` is wrong: a break lands on a glue and
 * discards it, so each wrap eats the space that was written there and the running
 * offset drifts by one per wrapped line. Aligning on non-whitespace characters
 * instead makes the mapping exact regardless of how many spaces a break consumed.
 */
function wrapOffsets(source, lines) {
  const src = [...source];
  const offsets = [];
  let si = 0;
  for (let i = 0; i < lines.length - 1; i++) {
    for (const c of [...lines[i].text]) {
      if (/\s/.test(c)) continue;
      while (si < src.length && /\s/.test(src[si])) si++;
      if (si < src.length && src[si] === c) si++;
      else return offsets; // structural mismatch; A1 will have already failed
    }
    while (si < src.length && /\s/.test(src[si])) si++;
    offsets.push(si);
  }
  return offsets;
}

/**
 * @param {object} result output of layoutParagraph() / a single paragraph of layout()
 * @param {string} source the original paragraph text
 * @returns {{ok: boolean, checks: Array<{id, name, en, ok, detail}>}}
 */
export function auditParagraph(result, source) {
  const checks = [];
  const lines = result.lines ?? [];
  const items = result.items ?? [];

  // --- A1 text integrity ---
  const produced = squeeze(lines.map(l => l.text).join(''));
  const expected = squeeze(source);
  const integrityOk = produced === expected;
  checks.push({
    ...pick('A1'),
    ok: integrityOk,
    detail: integrityOk
      ? `${produced.length} 字符全部保留`
      : `期望 ${expected.length} 字符、实际 ${produced.length}；首个差异 @ ${firstDiff(expected, produced)}`,
  });

  // --- A2 / A3 kinsoku ---
  const startBad = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => { const f = [...l.text][0]; return f !== undefined && LINE_START_FORBIDDEN.has(f); });
  checks.push({
    ...pick('A2'),
    ok: startBad.length === 0,
    detail: startBad.length === 0
      ? `${lines.length} 行均无行首禁则字符`
      : startBad.map(({ l, i }) => `行 ${i + 1} 以 ${JSON.stringify([...l.text][0])} 开头`).join('; '),
  });

  const endBad = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l, i }) => i !== lines.length - 1 && LINE_END_FORBIDDEN.has(l.text[l.text.length - 1]));
  checks.push({
    ...pick('A3'),
    ok: endBad.length === 0,
    detail: endBad.length === 0
      ? '无行尾禁则字符'
      : endBad.map(({ l, i }) => `行 ${i + 1} 以 ${JSON.stringify(l.text[l.text.length - 1])} 结尾`).join('; '),
  });

  // --- A4 overflow ---
  const overfull = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => l.width - l.shrink > l.target + 0.5);
  checks.push({
    ...pick('A4'),
    ok: overfull.length === 0,
    detail: overfull.length === 0
      ? '无行超出可用收缩量'
      : overfull.map(({ l, i }) => `行 ${i + 1} 宽 ${l.width.toFixed(1)} > 目标 ${l.target}（可缩 ${l.shrink.toFixed(1)}）`).join('; '),
  });

  // --- A5 justifiability ---
  const unsettable = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l, i }) => i !== lines.length - 1 && !l.ragged && !Number.isFinite(l.ratio));
  checks.push({
    ...pick('A5'),
    ok: unsettable.length === 0,
    detail: unsettable.length === 0
      ? '所有非末行 ratio 有限'
      : unsettable.map(({ i }) => `行 ${i + 1} ratio 非有限`).join('; '),
  });

  // --- A6 legal break points ---
  //
  // Two accepted sources of a break:
  //   (a) a UAX#14 opportunity that the kinsoku rules did not veto, and
  //   (b) an emergency discretionary break inserted inside an overlong Latin
  //       token -- deliberately outside UAX#14, and reported by the segmenter as
  //       `emergencyBreakOffsets` so it can be distinguished from a regression.
  // Anything else is a genuine defect.
  const legal = breakOpportunities(source, result.diagnostics?.breaker);
  const emergencyOffsets = result.diagnostics?.emergencyBreakOffsets ?? new Set();
  const problemsA6 = [];
  const srcCps = [...source];
  for (const off of wrapOffsets(source, lines)) {
    const prev = srcCps[off - 1];
    const next = srcCps[off];
    if (prev === undefined || next === undefined) continue;
    if (LINE_START_FORBIDDEN.has(next)) problemsA6.push(`断点 ${off}: 下一字符 ${JSON.stringify(next)} 触发行首禁则`);
    else if (LINE_END_FORBIDDEN.has(prev)) problemsA6.push(`断点 ${off}: 上一字符 ${JSON.stringify(prev)} 触发行尾禁则`);
    else if (isUnsplittablePair(prev, next)) problemsA6.push(`断点 ${off}: 拆开了不可分序列 ${JSON.stringify(prev + next)}`);
    else if (!legal.has(off) && !emergencyOffsets.has(off)) {
      problemsA6.push(`断点 ${off}: UAX#14 未提供断点机会，且不是应急断点`);
    }
  }
  const emergencyUsed = wrapOffsets(source, lines).filter(o => emergencyOffsets.has(o)).length;
  checks.push({
    ...pick('A6'),
    ok: problemsA6.length === 0,
    detail: problemsA6.length === 0
      ? `${lines.length - 1} 个断点全部合法${emergencyUsed ? `（含 ${emergencyUsed} 个应急断点）` : ''}`
      : problemsA6.join('; '),
  });

  // --- A7 invariants ---
  const invariantProblems = validateItems(items);
  checks.push({
    ...pick('A7'),
    ok: invariantProblems.length === 0,
    detail: invariantProblems.length === 0
      ? `item 流 ${items.length} 项，结构合法`
      : invariantProblems.join('; '),
  });

  return { ok: checks.every(c => c.ok), checks };
}

function pick(id) {
  const c = CHECKS.find(x => x.id === id);
  return { id: c.id, name: c.name, en: c.en };
}

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return n;
}

export { CHECKS };

/**
 * Audit a whole layout() result, paragraph by paragraph.
 * @returns {{ok: boolean, paragraphs: Array, summary: object}}
 */
export function auditLayout(result, source) {
  const paragraphs = String(source).split(/\r\n|\r|\n/);
  const out = [];
  const byParagraph = new Map();
  for (const l of result.lines) {
    if (!byParagraph.has(l.paragraph)) byParagraph.set(l.paragraph, []);
    byParagraph.get(l.paragraph).push(l);
  }

  for (let p = 0; p < paragraphs.length; p++) {
    const raw = paragraphs[p];
    if (raw.trim() === '') continue;
    const stats = result.paragraphs[p] ?? {};
    const lines = byParagraph.get(p) ?? [];
    const diag = stats.diagnostics ?? {};
    const items = stats.items ?? diag.items ?? [];
    const a = auditParagraph({ lines, items, diagnostics: diag }, raw);
    out.push({ paragraph: p, ...a });
  }

  const counts = {};
  for (const c of CHECKS) counts[c.id] = 0;
  for (const p of out) for (const c of p.checks) if (!c.ok) counts[c.id]++;

  return {
    ok: out.every(p => p.ok),
    paragraphs: out,
    summary: {
      paragraphCount: out.length,
      failedChecks: Object.entries(counts).filter(([, n]) => n > 0).map(([id, n]) => ({ id, failures: n })),
    },
  };
}
