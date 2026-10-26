/**
 * Segmentation tests.
 *
 * These pin the item model itself, because every visible property of the output
 * (no 行首禁则 violation, no gaps inside a split token, no silently dropped
 * paragraph) follows from the shape of this item stream. Each test states the
 * consequence it is protecting, not just the mechanic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  segmentParagraph,
  validateItems,
  classifyBoundary,
  fallbackBreakOpportunities,
  breakOpportunities,
  setLineBreaker,
  INFINITY_PENALTY,
  EMERGENCY_BREAK_PENALTY,
} from '../src/cjk/segment.mjs';
import { uniformMeasure } from '../src/cjk/metrics.mjs';
import LineBreaker from 'linebreak';

setLineBreaker(LineBreaker);

const EM = 20;
const measure = uniformMeasure(EM);
const seg = (text, opts) => segmentParagraph(text, measure, { em: EM, ...opts });

test('every Han character becomes its own box', () => {
  // This is the whole fix in one assertion: upstream produces 1 box for a Chinese
  // sentence, this produces one per character, which is what gives the engine
  // break opportunities at all.
  const { items } = seg('中文排版');
  const boxes = items.filter(i => i.type === 'box');
  assert.equal(boxes.length, 4);
  assert.deepEqual(boxes.map(b => b.value), ['中', '文', '排', '版']);
});

test('a Latin run stays a single box so words are not split arbitrarily', () => {
  const { items } = seg('使用 KnuthPlass 算法');
  const latin = items.filter(i => i.type === 'box' && /[A-Za-z]/.test(i.value));
  assert.equal(latin.length, 1);
  assert.equal(latin[0].value, 'KnuthPlass');
});

test('no two glues are ever adjacent', () => {
  // A glue preceded by a glue is not a break candidate, so an adjacent pair
  // silently deletes a break opportunity. validateItems() must therefore reject
  // it, and the segmenter must never produce it.
  const samples = [
    '中文排版需要断行，但浏览器只做贪心。',
    '使用 Knuth-Plass 算法优化 text-align: justify 效果。',
    '他说：“这样可以。”然后就走了。',
    '  前导空格 与 尾随空格  ',
    'a b c d e f',
  ];
  for (const s of samples) {
    const { items } = seg(s);
    assert.deepEqual(validateItems(items), [], `样例 ${JSON.stringify(s)} 产生了非法 item 流`);
  }
});

test('the stream always terminates with a forced break', () => {
  for (const s of ['短', '稍长一些的中文内容。', 'mixed 混排 content']) {
    const { items } = seg(s);
    const last = items[items.length - 1];
    assert.equal(last.type, 'penalty');
    assert.equal(last.penalty, -INFINITY_PENALTY);
  }
});

test('a line-start-forbidden glyph is preceded by a barrier, never a break', () => {
  // 行首禁则 is enforced structurally: the boundary before `。` is a penalty(INF)
  // followed by a glue, so the glue contributes flexibility but is invisible to
  // the break-candidate loop.
  const { items } = seg('这是句子。');
  const dotIndex = items.findIndex(i => i.type === 'box' && i.value === '。');
  assert.ok(dotIndex > 0);
  assert.equal(items[dotIndex - 2].type, 'penalty');
  assert.equal(items[dotIndex - 2].penalty, INFINITY_PENALTY);
  assert.equal(items[dotIndex - 1].type, 'glue');
});

test('a barrier still leaves the boundary stretchable for justification', () => {
  // The reason the barrier is a penalty+glue pair rather than a lone penalty: a
  // lone barrier would drop the stretch and make narrow columns unsolvable.
  const { items } = seg('这是句子。后面还有');
  const dotIndex = items.findIndex(i => i.type === 'box' && i.value === '。');
  assert.ok(items[dotIndex - 1].stretch > 0, '禁则边界必须保留可伸缩量');
});

test('an opening bracket is never left at the end of a line', () => {
  // 行尾禁则: the boundary after `（` is blocked.
  const { items } = seg('参见（附注）');
  const openIndex = items.findIndex(i => i.type === 'box' && i.value === '（');
  assert.ok(openIndex >= 0);
  const after = items[openIndex + 1];
  assert.equal(after.type, 'penalty');
  assert.equal(after.penalty, INFINITY_PENALTY);
});

test('a two-em dash is emitted as one unbreakable box', () => {
  // clreq §5.1 第6项: 破折号不得断开. UAX#14 offers a break between the two em
  // dashes (measured: for `他说——不行` it reports positions [1,2,4,5], including
  // 4 = 「—|不」), so the segmenter must override it by consuming both code points
  // into a single box. The invariant the segmenter owns is "one box, value `——`,
  // width equal to the metric's advance for the pair"; with a real CJK font that
  // advance is 2em, but the crude uniform fallback metric measures the dash at
  // 0.5em, so the width is asserted against `measure()` rather than hard-coded.
  const { items } = seg('他说——不行');
  const dashes = items.filter(i => i.type === 'box' && i.value.includes('—'));
  assert.equal(dashes.length, 1, '两个破折号必须合成一个 box');
  assert.equal(dashes[0].value, '——');
  assert.equal(dashes[0].width, measure('——'));
});

test('no break opportunity is offered inside an unbreakable pair', () => {
  // The consequence that matters: the stream contains no glue or breakable penalty
  // between the two dash code points, so no layout can ever split them.
  const { items } = seg('他说——不行');
  const idx = items.findIndex(i => i.type === 'box' && i.value === '——');
  assert.ok(idx >= 0);
  // Exactly one item carries the pair; neighbouring boundaries are separate items.
  const between = items.slice(0, idx + 1).filter(i => i.type === 'glue' || i.type === 'penalty');
  const after = items.slice(idx + 1).filter(i => i.type === 'glue' || i.type === 'penalty');
  assert.ok(between.length > 0 && after.length > 0, '断点只应存在于 pair 的两侧，而非内部');
  assert.equal([...items[idx].value].length, 2, 'pair 内部不含任何 item');
});

test('an ellipsis is likewise unbreakable', () => {
  const { items } = seg('不行……然后');
  assert.ok(items.find(i => i.type === 'box' && i.value === '……'));
});

test('a two-em dash may end a line but may not start one', () => {
  // The two rules are not symmetric and getting them backwards is a silent
  // typographic defect, so both directions are pinned:
  //   - the boundary *before* the pair carries a barrier (行首禁则: a line may not
  //     open with a dash), and
  //   - the boundary *after* the pair is an ordinary glue (a line may end with one).
  //
  // Note the barrier's position: a blocked boundary is emitted as
  // `penalty(INF) , glue`, so the barrier sits two items before the box and the
  // glue one item before it. Asserting on `items[idx - 1]` would be asserting on
  // the glue.
  const { items } = seg('他说——不行');
  const idx = items.findIndex(i => i.type === 'box' && i.value === '——');
  assert.ok(idx >= 2);
  assert.equal(items[idx - 1].type, 'glue', 'pair 之前应保留可伸缩 glue');
  assert.equal(items[idx - 2].type, 'penalty');
  assert.equal(items[idx - 2].penalty, INFINITY_PENALTY, '破折号不得居行首');
  assert.equal(items[idx + 1].type, 'glue', 'pair 之后应保留断点，破折号可以居行尾');
});

test('compressible punctuation donates shrink to the following boundary', () => {
  // 标点挤压 modelled as shrink on the next boundary, not as box+glue, because the
  // latter would create an adjacent-glue pair and delete the next break.
  const { items, diagnostics } = seg('第一句，第二句。');
  const commaShrink = items.filter(i => i.type === 'glue' && i.shrink >= EM * 0.5);
  assert.ok(commaShrink.length >= 1, '全角标点应提供半字宽的收缩量');
  assert.ok(diagnostics.compressedMarks >= 1);
});

test('compression can be turned off', () => {
  const on = seg('第一句，第二句。', { compress: true });
  const off = seg('第一句，第二句。', { compress: false });
  const maxShrink = x => Math.max(...x.items.filter(i => i.type === 'glue').map(i => i.shrink));
  assert.ok(maxShrink(on) > maxShrink(off), 'compress=false 时不应有挤压量');
});

test('a Han↔Latin boundary receives the clreq script gap and nothing else does', () => {
  const { items, diagnostics } = seg('中文abc 中文');
  // Han↔Latin boundaries present: 中文|abc and abc|中文. The space case does not
  // add the gap because a real space already provides one.
  assert.ok(diagnostics.scriptGaps >= 1, '中西边界应插入 1/4 em 间距');
  const gaps = items.filter(i => i.type === 'glue' && i.width >= EM * 0.25 && !i.space);
  for (const g of gaps) {
    assert.ok(g.width <= EM * 0.25 + 1e-9, '混排间距不得超过 1/4 汉字宽');
    assert.ok(g.shrink >= g.width - 1e-9, '混排间距应可在行末收起');
  }
});

test('the script gap is disabled when a real space is already present', () => {
  const withSpace = seg('中文 abc');
  const withoutSpace = seg('中文abc');
  assert.ok(withoutSpace.diagnostics.scriptGaps >= 1);
  // With an explicit space, the boundary carries the space width and is not
  // additionally widened by the 1/4 em gap.
  const spaceGlue = withSpace.items.find(i => i.type === 'glue' && i.space);
  assert.ok(spaceGlue, '空格边界应被标记为 space');
  assert.ok(spaceGlue.width <= EM * 0.5);
});

test('multiple spaces collapse to one boundary but are counted', () => {
  const { items, diagnostics } = seg('中文    英文');
  const spaces = items.filter(i => i.type === 'glue' && i.space);
  assert.equal(spaces.length, 1, '连续空格应折叠为单个边界');
  assert.equal(diagnostics.collapsedSpaces, 3, '应记录被折叠的空格数');
});

test('an overlong Latin token is split with emergency penalties and no glue inside', () => {
  // Glue inside a split token would be stretched and open a hole in the middle of
  // the word when both fragments share a line, so the break is a bare penalty.
  const token = 'SupercalifragilisticexpialidociousToken';
  const { items, diagnostics } = seg(`前缀 ${token} 后缀`, { maxWidth: 200 });
  assert.ok(diagnostics.emergencyBreakTokens >= 1, '超长 token 应被切分');
  assert.ok(diagnostics.emergencyBreakPoints >= 1);
  const penaltyIdx = items.findIndex(i => i.type === 'penalty' && i.penalty === EMERGENCY_BREAK_PENALTY);
  assert.ok(penaltyIdx > 0);
  assert.notEqual(items[penaltyIdx + 1]?.type, 'glue', '应急断点后不得紧跟 glue');
  assert.equal(items[penaltyIdx].width, 0, '应急断点宽度应为 0（不插入连字符）');
});

test('a token that fits is not split', () => {
  const { diagnostics } = seg('前缀 microservices 后缀', { maxWidth: 400 });
  assert.equal(diagnostics.emergencyBreakTokens, 0);
});

test('emergency break offsets are reported for the auditor', () => {
  const text = `前缀 SupercalifragilisticexpialidociousToken 后缀`;
  const { diagnostics } = seg(text, { maxWidth: 200 });
  assert.ok(diagnostics.emergencyBreakOffsets instanceof Set);
  assert.ok(diagnostics.emergencyBreakOffsets.size >= 1);
  // Each reported offset must be a real code-point index inside the token.
  for (const off of diagnostics.emergencyBreakOffsets) {
    assert.ok(off >= 0 && off <= [...text].length, `偏移 ${off} 越界`);
  }
});

test('classifyBoundary reports the rule that blocked a boundary', () => {
  const em = EM;
  const start = classifyBoundary('句', '。', { uax14Allows: true, kinsoku: true, compress: true, em });
  assert.equal(start.breakable, false);
  assert.equal(start.reason, 'line-start-forbidden');

  const end = classifyBoundary('（', '注', { uax14Allows: true, kinsoku: true, compress: true, em });
  assert.equal(end.breakable, false);
  assert.equal(end.reason, 'line-end-forbidden');

  const ok = classifyBoundary('中', '文', { uax14Allows: true, kinsoku: true, compress: true, em });
  assert.equal(ok.breakable, true);
  assert.equal(ok.reason, null);

  const noOpp = classifyBoundary('中', '文', { uax14Allows: false, kinsoku: true, compress: true, em });
  assert.equal(noOpp.breakable, false);
  assert.equal(noOpp.reason, 'uax14');
});

test('kinsoku can be disabled, which lets a forbidden break reappear', () => {
  const withK = classifyBoundary('句', '。', { uax14Allows: true, kinsoku: true, compress: false, em: EM });
  const withoutK = classifyBoundary('句', '。', { uax14Allows: true, kinsoku: false, compress: false, em: EM });
  assert.equal(withK.breakable, false);
  assert.equal(withoutK.breakable, true);
});

test('the fallback break provider is a strict subset of UAX#14 for Han text', () => {
  // The degraded provider must never offer a break UAX#14 would not, or it would
  // silently relax the rules on machines without the dependency installed.
  const samples = [
    '中文排版需要断行。',
    '使用 Knuth-Plass 算法优化效果。',
    '他说：“这样可以。”然后就走了。',
  ];
  for (const s of samples) {
    const real = breakOpportunities(s, LineBreaker);
    const fb = fallbackBreakOpportunities(s);
    for (const p of fb) {
      assert.ok(real.has(p), `降级断点 ${p}（${JSON.stringify([...s][p - 1] + [...s][p])}）不在 UAX#14 结果中`);
    }
  }
});

test('a paragraph consisting of a single Han character is valid', () => {
  const { items } = seg('中');
  assert.deepEqual(validateItems(items), []);
});

test('validateItems rejects a stream with two adjacent glues', () => {
  const bad = [
    { type: 'box', width: 10, value: 'a' },
    { type: 'glue', width: 0, stretch: 1, shrink: 0 },
    { type: 'glue', width: 0, stretch: 1, shrink: 0 },
    { type: 'penalty', width: 0, penalty: -INFINITY_PENALTY, flagged: 1 },
  ];
  const problems = validateItems(bad);
  assert.ok(problems.some(p => p.includes('adjacent glue')));
});

test('validateItems rejects a stream with no forced break at the end', () => {
  const bad = [
    { type: 'box', width: 10, value: 'a' },
    { type: 'glue', width: 0, stretch: 1, shrink: 0 },
  ];
  assert.ok(validateItems(bad).some(p => p.includes('forced-break')));
});

test('validateItems rejects non-finite widths', () => {
  const bad = [
    { type: 'box', width: NaN, value: 'a' },
    { type: 'glue', width: 0, stretch: 1, shrink: 0 },
    { type: 'penalty', width: 0, penalty: -INFINITY_PENALTY, flagged: 1 },
  ];
  assert.ok(validateItems(bad).some(p => p.includes('non-finite width')));
});
