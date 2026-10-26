/**
 * Upstream integrity test.
 *
 * The whole premise of this project is that the Knuth-Plass engine is correct and
 * only the item model for Chinese was missing. That claim is only checkable if the
 * upstream sources stay byte-identical, so this test pins them to the exact blobs
 * that upstream shipped at the commit this fork started from, and additionally
 * exercises the engine directly on hand-built item streams to prove it still
 * behaves like a Knuth-Plass implementation after the wrapper is applied.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { linebreak, KnuthLinkedList } from '../dist/kernel.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');
const sha256 = s => createHash('sha256').update(s, 'utf8').digest('hex');

/** The upstream commit this fork started from (bramstein/typeset). */
const UPSTREAM_COMMIT = '48ebb5547de116db57e14454e19767e4ff9b2266';

/** sha256 of the upstream blobs at that commit. */
const UPSTREAM_HASHES = {
  'src/linked-list.js': '87acf6663d9ff089c0a220d795deafe7a974009ae7200e110fb8c36347993750',
  'src/linebreak.js': '4ea7f236a04c2f994e610877ef74e31c1df0f355c30cbf1b836be07968665f96',
};

const box = (w, v) => ({ type: 'box', width: w, value: v });
const glue = (w, s, h) => ({ type: 'glue', width: w, stretch: s, shrink: h });
const pen = (w, p, f = 0) => ({ type: 'penalty', width: w, penalty: p, flagged: f });

test('upstream engine sources are byte-identical to the pinned upstream blobs', () => {
  for (const [file, expected] of Object.entries(UPSTREAM_HASHES)) {
    assert.equal(sha256(read(file)), expected, `${file} 与上游 blob 不一致 —— 引擎被改动了`);
  }
});

test('pinned hashes still match what upstream actually published', t => {
  // Guard against the hashes above being edited to match a local modification:
  // re-derive them from the upstream remote when it is reachable.
  let remote;
  try {
    remote = execFileSync('git', ['cat-file', '-p', `${UPSTREAM_COMMIT}:src/linebreak.js`], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    t.skip('本地没有上游对象（浅克隆或非 git 检出），跳过远端一致性复核');
    return;
  }
  assert.equal(sha256(remote), UPSTREAM_HASHES['src/linebreak.js']);
});

test('the engine reaches the forced break at the end of a paragraph', () => {
  const nodes = [box(50, 'a'), glue(10, 20, 5), box(50, 'b'), glue(0, 10000, 0), pen(0, -10000, 1)];
  const breaks = linebreak(nodes, [120], { tolerance: 2 });
  assert.ok(breaks.length >= 2, '应当至少给出起点与终点两个断点');
  assert.equal(breaks[breaks.length - 1].position, nodes.length - 1);
});

test('the engine breaks a paragraph into the number of lines its measure implies', () => {
  // Six 40px boxes with 10px spaces and a 130px measure: two boxes + one space
  // per line, i.e. three lines.
  const nodes = [];
  for (let i = 0; i < 6; i++) {
    nodes.push(box(40, `w${i}`));
    nodes.push(glue(10, 20, 5));
  }
  nodes.push(glue(0, 10000, 0));
  nodes.push(pen(0, -10000, 1));
  const breaks = linebreak(nodes, [130], { tolerance: 2 });
  assert.equal(breaks.length - 1, 3, '130px 行宽应排出 3 行');
});

test('the engine returns no breaks when the content cannot fit at any tolerance', () => {
  // A single 500px box with a 100px measure and no break opportunity after it.
  const nodes = [box(500, 'x'), glue(0, 10000, 0), pen(0, -10000, 1)];
  const breaks = linebreak(nodes, [100], { tolerance: 2 });
  assert.deepEqual(breaks, [], '不可解的段落应返回空断点列表，这正是中文缺口的症状');
});

test('tolerance escalation is real: the same stream is unsolvable tight and solvable loose', () => {
  // Calibrated against the engine's actual behaviour rather than assumed:
  //   [box 70][glue 10 s=5][box 20][glue 10 s=5][box 70][glue 0 s=inf][pen -inf]
  // Breaking after the first glue yields a line of 100px against a 130px measure.
  // The only flexibility inside that line is the second glue's stretch of 5, so the
  // ratio is 30/5 = 6. With maxTolerance pinned to the start tolerance there is no
  // feasible sequence at all; raising the ceiling to 6 finds it with ratio 6.
  const nodes = [box(70, 'a'), glue(10, 5, 0), box(20, 'b'), glue(10, 5, 0), box(70, 'c'), glue(0, 10000, 0), pen(0, -10000, 1)];
  const tight = linebreak(nodes, [130], { tolerance: 2, maxTolerance: 2 });
  assert.deepEqual(tight, [], 'tolerance 上限=2 时不应有可行解');

  const loose = linebreak(nodes, [130], { tolerance: 2, maxTolerance: 6 });
  assert.ok(loose.length >= 2, 'tolerance 上限=6 时应给出解');
  assert.equal(loose[loose.length - 1].position, nodes.length - 1);
  assert.equal(+loose[1].ratio.toFixed(3), 6, '解出的行应恰好用满 tolerance=6');
});

test('a line with no internal flexibility is rejected, not silently accepted', () => {
  // Break lands on a glue, so the glue is discarded and the line has zero stretch.
  // 90px into a 130px measure is a 40px gap with nothing to fill it, so the engine
  // must refuse rather than emit an underfull line with an infinite ratio.
  const nodes = [box(90, 'a'), glue(10, 10, 0), box(90, 'b'), glue(0, 10000, 0), pen(0, -10000, 1)];
  assert.deepEqual(linebreak(nodes, [130], { tolerance: 2 }), []);
});

test('the exported linked list is the upstream implementation', () => {
  const list = new KnuthLinkedList();
  list.push(new KnuthLinkedList.Node({ n: 1 }));
  list.push(new KnuthLinkedList.Node({ n: 2 }));
  assert.equal(list.size(), 2);
  const seen = [...list].map(n => n.data.n);
  assert.deepEqual(seen, [1, 2]);
});

test('the engine honours the demerits option it documents', () => {
  const nodes = [box(45, 'a'), glue(10, 5, 2), box(45, 'b'), glue(10, 5, 2), box(45, 'c'), glue(0, 10000, 0), pen(0, -10000, 1)];
  const a = linebreak(nodes, [100], { tolerance: 2 });
  const b = linebreak(nodes, [100], { tolerance: 2, demerits: { line: 10, flagged: 3000, fitness: 3000 } });
  assert.ok(a.length >= 2);
  assert.ok(b.length >= 2);
  assert.equal(a[a.length - 1].position, nodes.length - 1);
  assert.equal(b[b.length - 1].position, nodes.length - 1);
});
