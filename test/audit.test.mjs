/**
 * Audit gate tests.
 *
 * The audit is the project's honesty mechanism: it is what turns "we do not
 * produce kinsoku violations" from a claim into a checked fact. A gate that always
 * passes is worse than no gate, so the majority of this file is negative testing --
 * deliberately corrupted results that the audit must catch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditParagraph, auditLayout, CHECKS } from '../src/cjk/audit.mjs';
import { layout, layoutParagraph } from '../src/cjk/layout.mjs';
import { uniformMeasure } from '../src/cjk/metrics.mjs';
import { setLineBreaker, INFINITY_PENALTY } from '../src/cjk/segment.mjs';
import LineBreaker from 'linebreak';

setLineBreaker(LineBreaker);

const measure = uniformMeasure(20);

function base() {
  return {
    lines: [
      { text: '这是第一行', width: 100, target: 100, ratio: 0, stretch: 10, shrink: 0, shrink0: 0, finalLine: false, ragged: false, unsettable: false, overfull: false },
      { text: '这是第二行', width: 100, target: 100, ratio: 0, stretch: 10, shrink: 0, finalLine: true, ragged: false, unsettable: false, overfull: false },
    ],
    items: [
      { type: 'box', width: 100, value: '这是第一行' },
      { type: 'glue', width: 0, stretch: 10, shrink: 0 },
      { type: 'box', width: 100, value: '这是第二行' },
      { type: 'glue', width: 0, stretch: INFINITY_PENALTY, shrink: 0 },
      { type: 'penalty', width: 0, penalty: -INFINITY_PENALTY, flagged: 1 },
    ],
    diagnostics: {},
  };
}
const SOURCE = '这是第一行这是第二行';

function mutate(fn) {
  const r = base();
  fn(r);
  return r;
}

const failedIds = r => auditParagraph(r, SOURCE).checks.filter(c => !c.ok).map(c => c.id);

test('the audit passes an intact result', () => {
  assert.equal(auditParagraph(base(), SOURCE).ok, true);
});

test('every check has an id, a Chinese name and an English name', () => {
  for (const c of CHECKS) {
    assert.match(c.id, /^A\d+$/);
    assert.ok(c.name.length > 0);
    assert.ok(c.en.length > 0);
  }
});

/* ---------------- negative controls: each check must be able to fail ------- */

test('A1 catches a dropped character', () => {
  const ids = failedIds(mutate(r => { r.lines[1].text = '这是二行'; }));
  assert.ok(ids.includes('A1'), `期望 A1，实际 ${ids.join(',')}`);
});

test('A1 catches duplicated content', () => {
  const ids = failedIds(mutate(r => { r.lines[1].text = '这是第二行第二行'; }));
  assert.ok(ids.includes('A1'));
});

test('A2 catches a line that opens with a closing mark', () => {
  const ids = failedIds(mutate(r => { r.lines[1].text = '。这是第二'; }));
  assert.ok(ids.includes('A2'));
});

test('A2 catches a line that opens with an em dash', () => {
  const ids = failedIds(mutate(r => { r.lines[1].text = '——这是第二'; }));
  assert.ok(ids.includes('A2'));
});

test('A3 catches a line that closes with an opening bracket', () => {
  const ids = failedIds(mutate(r => { r.lines[0].text = '这是第一（'; }));
  assert.ok(ids.includes('A3'));
});

test('A3 does not fire on the final line', () => {
  // The last line's right edge is the paragraph end, not a break decision.
  const ids = failedIds(mutate(r => { r.lines[1].text = '这是第二（'; }));
  assert.ok(!ids.includes('A3'), '末行不应触发 A3');
});

test('A4 catches a line wider than its measure with no shrink to absorb it', () => {
  const ids = failedIds(mutate(r => { r.lines[0].width = 200; r.lines[0].shrink = 0; }));
  assert.ok(ids.includes('A4'));
});

test('A5 catches a non-finite ratio on a body line', () => {
  const ids = failedIds(mutate(r => { r.lines[0].ratio = Infinity; }));
  assert.ok(ids.includes('A5'));
});

test('A6 catches a break that UAX#14 never offered', () => {
  // Two Han characters in the middle of a Latin run: no break belongs there.
  const src = 'abcdefghij';
  const r = {
    lines: [
      { text: 'abc', width: 30, target: 30, ratio: 0, stretch: 1, shrink: 0, finalLine: false, ragged: false },
      { text: 'defghij', width: 70, target: 30, ratio: 0, stretch: 1, shrink: 0, finalLine: true, ragged: false },
    ],
    items: base().items,
    diagnostics: {},
  };
  const ids = auditParagraph(r, src).checks.filter(c => !c.ok).map(c => c.id);
  assert.ok(ids.includes('A6'), `期望 A6，实际 ${ids.join(',')}`);
});

test('A6 accepts an emergency break that the segmenter reported', () => {
  const src = 'abcdefghij';
  const r = {
    lines: [
      { text: 'abc', width: 30, target: 30, ratio: 0, stretch: 1, shrink: 0, finalLine: false, ragged: false },
      { text: 'defghij', width: 70, target: 30, ratio: 0, stretch: 1, shrink: 0, finalLine: true, ragged: false },
    ],
    items: base().items,
    diagnostics: { emergencyBreakOffsets: new Set([3]) },
  };
  const ids = auditParagraph(r, src).checks.filter(c => !c.ok).map(c => c.id);
  assert.ok(!ids.includes('A6'), '应急断点应被接受');
});

test('A7 catches two adjacent glues', () => {
  const ids = failedIds(mutate(r => {
    r.items.splice(2, 0, { type: 'glue', width: 0, stretch: 1, shrink: 0 });
  }));
  assert.ok(ids.includes('A7'));
});

test('A7 catches a stream with no forced break at the end', () => {
  const ids = failedIds(mutate(r => { r.items.pop(); }));
  assert.ok(ids.includes('A7'));
});

/* ---------------- the gate on real layouts ---------------- */

test('the audit passes on the supported corpus at many measures', () => {
  const docs = [
    '中文排版长期缺少全局优化。浏览器用贪心算法逐行决定断点，结果是一行松一行紧。',
    '他说：“这样可以。”然后就走了。（参见《中文排版需求》。）',
    '他停顿了一下——这是插入语——然后继续。',
    '使用 Knuth-Plass 算法优化 text-align: justify 的效果。',
    '这行包含一个超长的英文标识符 SupercalifragilisticexpialidociousToken 用来测试溢出。',
    '详见 https://example.com/a/very/long/path/that/keeps/going/index.html 这份文档。',
  ];
  for (const doc of docs) {
    for (const w of [140, 200, 260, 320, 400, 520, 680]) {
      const r = layout(doc, measure, { width: w });
      const a = auditLayout(r, doc);
      const fails = a.paragraphs.flatMap(p => p.checks.filter(c => !c.ok).map(c => `${c.id}: ${c.detail}`));
      assert.deepEqual(fails, [], `doc=${JSON.stringify(doc.slice(0, 12))} W=${w} 审计失败：${fails.join(' | ')}`);
    }
  }
});

test('auditLayout reports a per-paragraph verdict', () => {
  const doc = '第一段内容。\n\n第二段也有内容，稍微长一些以便换行处理。';
  const r = layout(doc, measure, { width: 200 });
  const a = auditLayout(r, doc);
  assert.equal(a.ok, true);
  assert.equal(a.paragraphs.length, 2);
  assert.deepEqual(a.summary.failedChecks, []);
});

test('auditLayout reports failures with the paragraph index', () => {
  const doc = '第一段内容。';
  const r = layout(doc, measure, { width: 200 });
  // Corrupt the layout after the fact; the audit must notice.
  r.lines[0].text = '。' + r.lines[0].text.slice(1);
  const a = auditLayout(r, doc);
  assert.equal(a.ok, false);
  assert.equal(a.paragraphs[0].paragraph, 0);
  assert.ok(a.summary.failedChecks.length > 0);
});

test('the audit does not depend on the flags attached to the lines', () => {
  // It re-derives every fact, so lying about a flag must not buy a pass.
  const r = layoutParagraph('他说：“这样可以。”然后就走了。', measure, { width: 200 });
  for (const l of r.lines) {
    l.startsWithForbidden = false;
    l.endsWithForbidden = false;
  }
  // Force a genuine violation and clear the flag that would have reported it.
  r.lines[r.lines.length - 1].text = '。”' + r.lines[r.lines.length - 1].text;
  const a = auditParagraph(r, '他说：“这样可以。”然后就走了。');
  assert.equal(a.ok, false);
});
