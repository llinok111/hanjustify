#!/usr/bin/env node
/**
 * Reproducible baseline: what the unmodified upstream engine does with Chinese
 * text, next to what hanjustify does with the same metrics and the same measure.
 *
 * This script is the primary evidence for the project's premise. It prints raw
 * counts (item counts, break counts, line counts) rather than prose, and it also
 * runs the upstream *English* formatter so the reader can see that the engine is
 * healthy -- the Chinese failure is a modelling gap, not a broken algorithm.
 *
 *   node scripts/baseline.mjs [--json]
 *
 * The upstream side is exercised through `src/formatter.js` exactly as it ships
 * (browser globals and all); see scripts/build-kernel.mjs for the wrapper.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { linebreak as engineLinebreak } from '../dist/kernel.mjs';
import { layout } from '../src/cjk/layout.mjs';
import { uniformMeasure } from '../src/cjk/metrics.mjs';
import { breakOpportunities, setLineBreaker } from '../src/cjk/segment.mjs';
import LineBreaker from 'linebreak';

setLineBreaker(LineBreaker);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// The upstream formatter is a browser global script that expects `Hypher` and
// `Typeset.linebreak` to already exist. Reproduce that environment verbatim.
const ctx = { console };
vm.createContext(ctx);
vm.runInContext(
  ['src/linked-list.js', 'src/linebreak.js', 'src/formatter.js', 'lib/hypher.js', 'lib/en-us.js']
    .map(f => readFileSync(join(root, f), 'utf8')).join('\n'),
  ctx,
  { filename: 'upstream-bundle.js' },
);
const upstream = ctx.Typeset;

const SIZE = 20;
const measure = uniformMeasure(SIZE);

const CASES = [
  {
    name: 'zh-pure',
    label: '纯中文段落',
    text: '中文排版长期缺少全局优化。浏览器用贪心算法逐行决定断点，结果是一行松一行紧，标点还会跑到行首。',
  },
  {
    name: 'zh-kinsoku',
    label: '含禁则标点',
    text: '他说：“这样可以。”然后就走了。（参见《中文排版需求》。）',
  },
  {
    name: 'zh-latin-mix',
    label: '中西混排',
    text: '使用 Knuth-Plass 算法可以优化两端对齐效果，相比 text-align: justify 平均行距更均匀。',
  },
  {
    name: 'en-control',
    label: '英文对照',
    text: 'The Knuth and Plass line breaking algorithm finds the optimal set of breakpoints for a paragraph.',
  },
];

const WIDTH = 360;
const rows = [];

for (const c of CASES) {
  // --- upstream path ---
  const upstreamFormatter = upstream.formatter(measure);
  const upstreamNodes = upstreamFormatter.justify(c.text);
  const upstreamBreaks = engineLinebreak(upstreamNodes, [WIDTH], { tolerance: 2 });
  const upstreamLines = countRenderedLines(upstreamNodes, upstreamBreaks);
  const boxCount = upstreamNodes.filter(n => n.type === 'box').length;
  const widestBox = Math.max(...upstreamNodes.filter(n => n.type === 'box').map(n => n.width), 0);

  // --- hanjustify path ---
  const result = layout(c.text, measure, { width: WIDTH });
  const uax14 = breakOpportunities(c.text).size;

  rows.push({
    name: c.name,
    label: c.label,
    upstream: {
      items: upstreamNodes.length,
      boxes: boxCount,
      widestBoxPx: +widestBox.toFixed(1),
      breaks: upstreamBreaks.length,
      lines: upstreamLines,
      overflows: upstreamLines > 0
        ? upstreamNodes.filter(n => n.type === 'box' && n.width > WIDTH).length
        : 0,
    },
    hanjustify: {
      uax14Opportunities: uax14,
      items: result.paragraphs[0]?.diagnostics?.boxes ?? 0,
      lines: result.lines.length,
      kinsokuViolations: result.stats.kinsokuLineStartViolations,
      overfull: result.stats.overfullLines,
      maxAddedPerBoundaryEm: +result.stats.maxAddedPerBoundaryEm.toFixed(3),
    },
  });
}

function countRenderedLines(nodes, breaks) {
  // The upstream API returns one entry per line *including* the initial
  // position-0 sentinel, so the number of rendered lines is breaks.length - 1.
  // Upstream returns an empty array when it finds no feasible sequence, which is
  // itself the headline result for Chinese.
  return Math.max(0, breaks.length - 1);
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ width: WIDTH, size: SIZE, rows }, null, 2));
} else {
  console.log(`基线对比  width=${WIDTH}px  font-size=${SIZE}px  metrics=uniform(Han=1em, Latin=0.5em)\n`);
  console.log('  用例            上游 typeset (未改动)                         hanjustify');
  console.log('                  items  boxes  最宽box  断点  行数 |  UAX14  items  行数  首禁  溢出');
  console.log('  ' + '-'.repeat(96));
  for (const r of rows) {
    const u = r.upstream;
    const hh = r.hanjustify;
    console.log(
      '  ' + r.label.padEnd(14)
      + String(u.items).padStart(5)
      + String(u.boxes).padStart(7)
      + String(u.widestBoxPx).padStart(8)
      + String(u.breaks).padStart(6)
      + String(u.lines).padStart(6)
      + ' |'
      + String(hh.uax14Opportunities).padStart(7)
      + String(hh.items).padStart(7)
      + String(hh.lines).padStart(6)
      + String(hh.kinsokuViolations).padStart(6)
      + String(hh.overfull).padStart(6),
    );
  }
  console.log('\n读法：上游把整段中文并成极少数 box（纯中文 = 1 个 box，宽 940px，而断点 = 0），');
  console.log('      所以引擎返回空断点列表、行数为 0 —— 中文段落根本无法排版。');
  console.log('      英文对照行证明同一引擎在西文上是健康的：断点与行数都正常，');
  console.log('      所以缺口在中文的 item 模型，不在算法。');
}
