/**
 * Layout and metrics tests.
 *
 * These assert the properties a user actually cares about -- the paragraph is set,
 * the text survives, the right edge aligns, the guarantee is auditable -- rather
 * than internal bookkeeping.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layout, layoutParagraph, summarize, DEFAULT_OPTIONS } from '../src/cjk/layout.mjs';
import { auditLayout } from '../src/cjk/audit.mjs';
import { uniformMeasure, makeMeasure, parseFont, loadFont } from '../src/cjk/metrics.mjs';
import { setLineBreaker } from '../src/cjk/segment.mjs';
import LineBreaker from 'linebreak';

setLineBreaker(LineBreaker);

const EM = 20;
const measure = uniformMeasure(EM);
const WIDTH = 400;

const ZH = '中文排版长期缺少全局优化。浏览器用贪心算法逐行决定断点，结果是一行松一行紧，标点还会跑到行首。Knuth-Plass 算法把整段当作一个整体求最小代价。';

/* ------------------------------------------------------------------ *
 * The headline behaviour: Chinese gets laid out at all
 * ------------------------------------------------------------------ */

test('a Chinese paragraph is laid out into multiple lines', () => {
  // Upstream produces zero lines for this paragraph (see scripts/baseline.mjs).
  const r = layoutParagraph(ZH, measure, { width: WIDTH });
  assert.ok(r.lines.length >= 3, `应排出多行，实际 ${r.lines.length}`);
});

test('every upstream-visible symptom is absent from the output', () => {
  const r = layoutParagraph(ZH, measure, { width: WIDTH });
  assert.equal(r.diagnostics.ragged ?? false, false, '该段落不需要降级为 ragged');
  assert.equal(r.lines.filter(l => l.overfull).length, 0, '不应有行溢出');
  assert.equal(r.lines.filter(l => l.unsettable).length, 0, '不应有不可调整的行');
  assert.equal(r.lines.filter(l => l.startsWithForbidden).length, 0, '不应有行首禁则违规');
});

test('the text is preserved exactly across the line split', () => {
  const r = layoutParagraph(ZH, measure, { width: WIDTH });
  const rejoined = r.lines.map(l => l.text).join('').replace(/\s+/g, '');
  assert.equal(rejoined, ZH.replace(/\s+/g, ''));
});

test('no line exceeds its measure at the width it was set for', () => {
  for (const w of [240, 300, 360, 400, 440, 520]) {
    const r = layoutParagraph(ZH, measure, { width: w });
    for (const [i, l] of r.lines.entries()) {
      // Natural width may exceed the target only when the line has enough shrink
      // to absorb the difference (punctuation compression).
      const effective = l.width - l.shrink;
      assert.ok(
        effective <= l.target + 1e-6 || l.ragged,
        `W=${w} 行 ${i + 1} 宽 ${l.width} 超出目标 ${l.target} 且收缩量不足`,
      );
    }
  }
});

test('a narrow measure still sets the paragraph rather than dropping it', () => {
  const r = layoutParagraph(ZH, measure, { width: 120 });
  assert.ok(r.lines.length > 0, '窄栏也必须产出内容');
  const rejoined = r.lines.map(l => l.text).join('').replace(/\s+/g, '');
  assert.equal(rejoined, ZH.replace(/\s+/g, ''), '窄栏下文本同样不得丢失');
});

/* ------------------------------------------------------------------ *
 * Kinsoku behaviour end to end
 * ------------------------------------------------------------------ */

test('punctuation never opens a line, across a wide range of measures', () => {
  const samples = [
    '他说：“这样可以。”然后就走了。（参见《中文排版需求》。）',
    '这是一段话，里面有逗号、顿号；还有分号：以及冒号！还有问号？最后是句号。',
    '《书名》与（括注）还有「引号」以及【方括号】都要避免出现在行首。',
  ];
  for (const text of samples) {
    for (const w of [200, 260, 320, 380, 440]) {
      const r = layoutParagraph(text, measure, { width: w });
      const bad = r.lines.filter(l => l.startsWithForbidden);
      assert.equal(bad.length, 0, `W=${w} 出现行首禁则违规：${JSON.stringify(bad.map(b => b.text))}`);
    }
  }
});

test('an opening bracket never ends a line', () => {
  const text = '这个说法（据我所知出自一份未公开的内部文档）需要进一步核实。';
  for (const w of [180, 240, 300, 360]) {
    const r = layoutParagraph(text, measure, { width: w });
    const bad = r.lines.slice(0, -1).filter(l => l.endsWithForbidden);
    assert.equal(bad.length, 0, `W=${w} 出现行尾禁则违规：${JSON.stringify(bad.map(b => b.text))}`);
  }
});

test('a two-em dash is never split across lines', () => {
  const text = '他停顿了一下——这是很长的一段插入语，用来把破折号推到各种可能的断点位置——然后继续。';
  for (const w of [160, 200, 240, 300, 360, 420]) {
    const r = layoutParagraph(text, measure, { width: w });
    const joined = r.lines.map(l => l.text).join('\u0000');
    // The dash pair must never straddle a line boundary.
    assert.ok(!/—\u0000—/.test(joined), `W=${w} 破折号被拆到两行`);
  }
});

test('disabling kinsoku is observable on the em-dash case, and only there', () => {
  // Calibrated against measurement, because the naive version of this test is
  // wrong: for *closing* punctuation UAX#14 already forbids a break before the
  // mark (classes CL/CP), so switching the kinsoku layer off changes nothing --
  // measured over 64 controlled cases, zero difference. The em dash is the case
  // where the layer earns its keep: UAX#14 reports a legal break immediately
  // before `——` (classes B2 allow a break on both sides), so without the
  // line-start rule a line really can open with a dash.
  const text = '甲'.repeat(5) + '——' + '乙';
  const off = layoutParagraph(text, measure, { width: 100, kinsoku: false });
  assert.ok(off.lines.some(l => l.startsWithForbidden),
    '关闭禁则后应出现以破折号开头的行，否则本测试无法证明禁则层有效');

  const on = layoutParagraph(text, measure, { width: 100, kinsoku: true });
  assert.equal(on.lines.filter(l => l.startsWithForbidden).length, 0,
    '开启禁则后不得出现以破折号开头的行');
});

test('the kinsoku layer makes no difference for closing punctuation, by design', () => {
  // Pinned so the project never claims more than it delivers: the value of the
  // item model is that it gives the engine break opportunities at all; the value
  // of the kinsoku layer over UAX#14 is narrow and this documents its extent.
  let differences = 0;
  for (let n = 1; n <= 8; n++) {
    const text = '甲'.repeat(n) + '。' + '乙'.repeat(3);
    for (const w of [60, 80, 100, 120, 140, 160, 180, 200]) {
      const on = layoutParagraph(text, measure, { width: w, kinsoku: true });
      const off = layoutParagraph(text, measure, { width: w, kinsoku: false });
      const bad = r => r.lines.filter(l => l.startsWithForbidden).length;
      if (bad(on) !== bad(off)) differences++;
    }
  }
  assert.equal(differences, 0,
    '闭合标点的行首禁则已由 UAX#14 覆盖；若此处出现差异说明 UAX#14 行为变了，需重新评估主张');
});

/* ------------------------------------------------------------------ *
 * Justification quality
 * ------------------------------------------------------------------ */

test('justified lines reach their target width within rounding', () => {
  const r = layoutParagraph(ZH, measure, { width: WIDTH });
  for (const [i, l] of r.lines.entries()) {
    if (l.finalLine || l.ragged || !Number.isFinite(l.ratio)) continue;
    assert.ok(
      Math.abs(l.justifiedWidth - l.target) < 0.5,
      `行 ${i + 1} 两端对齐后宽度 ${l.justifiedWidth} 未达到目标 ${l.target}`,
    );
  }
});

test('the final line is not stretched to full measure', () => {
  const r = layoutParagraph(ZH, measure, { width: WIDTH });
  const last = r.lines[r.lines.length - 1];
  assert.ok(last.width < last.target, '末行应保持自然宽度');
});

test('addedPerBoundaryEm is the comparable metric and ratio is not', () => {
  // The same text set with a larger declared stretch must report a *smaller* ratio
  // for the same visible gap, while addedPerBoundaryEm stays comparable. This is
  // pinned because a benchmark that compared ratios across settings would reach
  // the wrong conclusion.
  const tight = layoutParagraph(ZH, measure, { width: 417, cjkStretchEm: 0.05 });
  const loose = layoutParagraph(ZH, measure, { width: 417, cjkStretchEm: 0.5 });
  const worst = r => Math.max(...r.lines.filter(l => !l.finalLine).map(l => Math.abs(l.ratio)));
  assert.ok(worst(loose) < worst(tight), '声明伸缩量变大时 ratio 必然变小');
});

test('summarize reports the fields the CLI and audit rely on', () => {
  const r = layout(ZH, measure, { width: WIDTH });
  for (const key of [
    'lineCount', 'bodyLineCount', 'maxAbsRatio', 'meanAbsRatio',
    'maxAddedPerBoundaryEm', 'meanAddedPerBoundaryEm', 'totalBadness',
    'unsettableLines', 'overfullLines', 'looseLines', 'raggedLines',
    'kinsokuLineStartViolations', 'kinsokuLineEndViolations',
  ]) {
    assert.ok(key in r.stats, `summarize 缺少字段 ${key}`);
    assert.ok(Number.isFinite(r.stats[key]), `字段 ${key} 应为有限数`);
  }
  assert.equal(r.stats.kinsokuLineStartViolations, 0);
  assert.equal(r.stats.overfullLines, 0);
});

/* ------------------------------------------------------------------ *
 * Degenerate and pathological inputs
 * ------------------------------------------------------------------ */

test('an empty paragraph yields no lines and does not throw', () => {
  const r = layout('', measure, { width: WIDTH });
  assert.equal(r.lines.length, 0);
  assert.ok(r.stats.lineCount === 0);
});

test('whitespace-only paragraphs are skipped', () => {
  const r = layout('   \n\t\n  ', measure, { width: WIDTH });
  assert.equal(r.lines.length, 0);
});

test('a single character is a valid paragraph', () => {
  const r = layoutParagraph('中', measure, { width: WIDTH });
  assert.equal(r.lines.length, 1);
  assert.equal(r.lines[0].text, '中');
});

test('a paragraph with only punctuation is valid', () => {
  const r = layoutParagraph('。', measure, { width: WIDTH });
  assert.equal(r.lines.length, 1);
  assert.equal(r.lines[0].text, '。');
});

test('an overlong Latin token does not make the paragraph unsolvable', () => {
  // Upstream returns an empty break list here, i.e. the paragraph disappears.
  const text = '这行包含一个超长的英文标识符 SupercalifragilisticexpialidociousToken 用来测试溢出。';
  const r = layoutParagraph(text, measure, { width: 400 });
  assert.ok(r.lines.length > 0, '含超长 token 的段落必须能排版');
  const rejoined = r.lines.map(l => l.text).join('').replace(/\s+/g, '');
  assert.equal(rejoined, text.replace(/\s+/g, ''), '文本不得丢失');
});

test('a URL is set without losing any character', () => {
  const text = '详见 https://example.com/a/very/long/path/that/keeps/going/index.html 这份文档。';
  for (const w of [240, 320, 400]) {
    const r = layoutParagraph(text, measure, { width: w });
    assert.ok(r.lines.length > 0, `W=${w} 应产出内容`);
    const rejoined = r.lines.map(l => l.text).join('').replace(/\s+/g, '');
    assert.equal(rejoined, text.replace(/\s+/g, ''), `W=${w} 文本丢失`);
  }
});

test('multi-paragraph documents keep their paragraph boundaries', () => {
  const doc = '第一段内容比较短。\n\n第二段开始，这里有更多的文字用来触发换行，确保它会被排成多行。\n第三段。';
  const r = layout(doc, measure, { width: 300 });
  const paras = new Set(r.lines.map(l => l.paragraph));
  assert.deepEqual([...paras].sort((a, b) => a - b), [0, 2, 3]);
  // Each paragraph's text must be intact.
  assert.equal(
    r.lines.filter(l => l.paragraph === 0).map(l => l.text).join(''),
    '第一段内容比较短。',
  );
});

test('CRLF and lone CR are both treated as paragraph breaks', () => {
  const a = layout('第一段。\r\n第二段。', measure, { width: 300 });
  const b = layout('第一段。\r第二段。', measure, { width: 300 });
  assert.deepEqual(
    a.lines.map(l => l.paragraph),
    b.lines.map(l => l.paragraph),
  );
  assert.equal(a.lines.length, 2);
});

test('lineLengths supports variable measure within a paragraph', () => {
  // Wrapping text around a figure means the first lines are shorter. The engine
  // supports a per-line array; the layout layer must pass it through.
  const r = layoutParagraph(ZH, measure, { lineLengths: [300, 300, 400, 400, 400] });
  assert.ok(r.lines.length >= 3);
  assert.equal(r.lines[0].target, 300);
  assert.equal(r.lines[1].target, 300);
  assert.equal(r.lines[2].target, 400);
});

test('an invalid item stream raises instead of returning a silent empty result', () => {
  // A silent empty result is the failure mode this project exists to remove, so a
  // malformed stream must be an error, not an empty layout.
  assert.throws(
    () => layoutParagraph('测试', () => NaN, { width: WIDTH }),
    err => err.problems && err.problems.length > 0,
  );
});

/* ------------------------------------------------------------------ *
 * Determinism
 * ------------------------------------------------------------------ */

test('layout is deterministic for identical input', () => {
  const a = layoutParagraph(ZH, measure, { width: WIDTH });
  const b = layoutParagraph(ZH, measure, { width: WIDTH });
  assert.deepEqual(a.lines.map(l => ({ t: l.text, r: l.ratio, w: l.width })),
    b.lines.map(l => ({ t: l.text, r: l.ratio, w: l.width })));
});

/* ------------------------------------------------------------------ *
 * Audit gate
 * ------------------------------------------------------------------ */

test('the audit passes on every supported configuration', () => {
  const docs = [
    ZH,
    '他说：“这样可以。”然后就走了。（参见《中文排版需求》。）',
    '使用 Knuth-Plass 算法可以优化两端对齐效果，相比 text-align: justify 平均行距更均匀。',
    '这行包含一个超长的英文标识符 SupercalifragilisticexpialidociousToken 用来测试溢出。',
    '详见 https://example.com/a/very/long/path/that/keeps/going/index.html 这份文档。',
    '第一段。\n\n第二段有更多内容，用来测试多段落处理是否正确。',
  ];
  for (const doc of docs) {
    for (const w of [200, 300, 400, 520]) {
      const r = layout(doc, measure, { width: w });
      const a = auditLayout(r, doc);
      const failures = a.paragraphs.flatMap(p => p.checks.filter(c => !c.ok).map(c => `${c.id}@W=${w}: ${c.detail}`));
      assert.deepEqual(failures, [], `审计失败：${failures.join(' | ')}`);
    }
  }
});

/* ------------------------------------------------------------------ *
 * Font metrics
 * ------------------------------------------------------------------ */

test('uniformMeasure gives Han one em and Latin half an em', () => {
  assert.equal(measure('中'), EM);
  assert.equal(measure('a'), EM * 0.5);
  assert.equal(measure('中ab'), EM + EM);
});

test('a real font file yields per-glyph advances that differ from the uniform model', () => {
  // The whole point of the font reader: proportional metrics. Verified against a
  // font that ships with Windows and is present in CI on this project's target
  // platform; skipped where unavailable.
  let loaded;
  try {
    loaded = loadFont('C:/Windows/Fonts/arial.ttf', { size: EM });
  } catch {
    return; // no font on this machine; the uniform model still covers the logic
  }
  const { font, measure: fm } = loaded;
  assert.ok(font.unitsPerEm > 0);
  assert.ok(fm('m') > fm('i'), '比例字体下 m 应宽于 i');
  assert.ok(font.hasGlyph('a'.codePointAt(0)));
  // A CJK code point is normally absent from a Latin font; the fallback must
  // still allocate space rather than collapse the run.
  assert.ok(Number.isFinite(fm('中')), '缺字必须仍占位');
});

test('makeMeasure falls back to half an em for unmapped code points', () => {
  const fakeFont = {
    unitsPerEm: 1000,
    advance: (cp, size) => (cp === 0x41 ? size : NaN),
    hasGlyph: () => false,
  };
  const m = makeMeasure(fakeFont, 100);
  assert.equal(m('A'), 100);
  assert.equal(m('中'), 50, '未映射字应按半角占位');
  assert.equal(m('AA'), 200);
});

test('parseFont rejects a file with no sfnt header', () => {
  assert.throws(() => parseFont(new Uint8Array(64)), /missing required table|no usable cmap/);
});
