#!/usr/bin/env node
/**
 * hanjustify CLI.
 *
 * Subcommands
 *   set      lay out text and print the justified lines
 *   audit    lay out text and run the seven verification checks
 *   inspect  dump the item stream the engine receives (for debugging)
 *   baseline run the upstream comparison (delegates to scripts/baseline.mjs)
 *
 * Exit codes (the contract CI relies on)
 *   0  success
 *   1  usage / input error
 *   2  audit found a violation
 *   3  audit could not be completed (engine reported an unsolvable paragraph and
 *      the ragged fallback also failed)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { layout, layoutParagraph, ensureLineBreaker, hasLineBreakerProvider } from '../src/cjk/layout.mjs';
import { auditLayout } from '../src/cjk/audit.mjs';
import { loadFont, uniformMeasure, makeMeasure } from '../src/cjk/metrics.mjs';

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_AUDIT_FAIL = 2;
const EXIT_INDETERMINATE = 3;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `hanjustify — CJK-aware Knuth-Plass 排版

用法:
  hanjustify set      [选项] [文本...]      排版并输出结果
  hanjustify audit    [选项] [文本...]      排版并运行 7 项验收
  hanjustify inspect  [选项] [文本...]      打印交给断行引擎的 item 流
  hanjustify baseline [--json]              与上游 typeset 的基线对比

输入:
  <文本>            直接给出文本（多个参数以空格连接）
  --file <路径>     从文件读取（UTF-8）
  --stdin           从标准输入读取

排版选项:
  --width <px>            行宽（默认 400）
  --line-lengths <a,b,c>  逐行不等宽，例如绕图排版
  --size <px>             字号（默认 20）
  --font <路径>           使用真实字体度量（TTF/OTF/TTC）
  --face <n>              TTC 中的 face 序号（默认 0）
  --kinsoku / --no-kinsoku      启用/关闭 禁则（默认启用）
  --compress / --no-compress    启用/关闭 标点挤压（默认启用）
  --stretch <em>          汉字间可拉伸量，单位 em（默认 0.25）
  --tolerance <n>         两侧对齐容差（默认 2）
  --no-emergency-breaks   不切分超长英文 token

输出:
  --json             以 JSON 输出
  --quiet            只输出行文本

退出码:  0 成功  1 用法/输入错误  2 验收失败  3 无法判定
`;

function parseArgs(argv) {
  const opts = {
    command: argv[0] && !argv[0].startsWith('-') ? argv[0] : 'set',
    textParts: [],
    file: null,
    stdin: false,
    width: 400,
    lineLengths: null,
    size: 20,
    font: null,
    face: 0,
    kinsoku: true,
    compress: true,
    stretch: 0.25,
    tolerance: 2,
    emergencyBreaks: true,
    json: false,
    quiet: false,
  };
  const rest = opts.command === argv[0] && !argv[0].startsWith('-') ? argv.slice(1) : argv;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const next = () => {
      const v = rest[++i];
      if (v === undefined) throw new UsageError(`选项 ${a} 缺少参数`);
      return v;
    };
    switch (a) {
      case '--file': opts.file = next(); break;
      case '--stdin': opts.stdin = true; break;
      case '--width': opts.width = Number(next()); break;
      case '--line-lengths': opts.lineLengths = next().split(',').map(Number); break;
      case '--size': opts.size = Number(next()); break;
      case '--font': opts.font = next(); break;
      case '--face': opts.face = Number(next()); break;
      case '--stretch': opts.stretch = Number(next()); break;
      case '--tolerance': opts.tolerance = Number(next()); break;
      case '--kinsoku': opts.kinsoku = true; break;
      case '--no-kinsoku': opts.kinsoku = false; break;
      case '--compress': opts.compress = true; break;
      case '--no-compress': opts.compress = false; break;
      case '--no-emergency-breaks': opts.emergencyBreaks = false; break;
      case '--json': opts.json = true; break;
      case '--quiet': opts.quiet = true; break;
      case '-h': case '--help': opts.help = true; break;
      default:
        if (a.startsWith('--')) throw new UsageError(`未知选项 ${a}`);
        opts.textParts.push(a);
    }
  }
  return opts;
}

class UsageError extends Error {}

function readInput(opts) {
  if (opts.stdin) return readFileSync(0, 'utf8');
  if (opts.file) return readFileSync(opts.file, 'utf8');
  if (opts.textParts.length) return opts.textParts.join(' ');
  return null;
}

function buildMeasure(opts) {
  if (opts.font) {
    const { font, measure } = loadFont(opts.font, { size: opts.size, faceIndex: opts.face });
    return { measure, fontPath: opts.font, unitsPerEm: font.unitsPerEm, faceCount: font.faceCount };
  }
  return { measure: uniformMeasure(opts.size), fontPath: null };
}

function layoutOptions(opts) {
  const o = {
    width: opts.width,
    kinsoku: opts.kinsoku,
    compress: opts.compress,
    cjkStretchEm: opts.stretch,
    tolerance: opts.tolerance,
    emergencyBreaks: opts.emergencyBreaks,
  };
  if (opts.lineLengths) o.lineLengths = opts.lineLengths;
  return o;
}

function fmtRatio(r, fallback = '  n/a') {
  return Number.isFinite(r) ? r.toFixed(2).padStart(6) : fallback;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`错误: ${err.message}\n`);
      console.error(USAGE);
      return EXIT_USAGE;
    }
    throw err;
  }

  if (opts.help || opts.command === 'help') {
    console.log(USAGE);
    return EXIT_OK;
  }

  if (opts.command === 'baseline') {
    const r = spawnSync(process.execPath, [join(root, 'scripts/baseline.mjs'), ...(opts.json ? ['--json'] : [])], { stdio: 'inherit' });
    return r.status ?? EXIT_USAGE;
  }

  if (!['set', 'audit', 'inspect'].includes(opts.command)) {
    console.error(`错误: 未知子命令 ${opts.command}\n`);
    console.error(USAGE);
    return EXIT_USAGE;
  }

  const text = readInput(opts);
  if (text === null) {
    console.error('错误: 没有输入。给出文本参数、--file 或 --stdin。\n');
    console.error(USAGE);
    return EXIT_USAGE;
  }
  if (!text.trim()) {
    console.error('错误: 输入为空。');
    return EXIT_USAGE;
  }

  const loaded = await ensureLineBreaker();
  const hasUax14 = loaded !== null;
  const { measure, fontPath, unitsPerEm } = buildMeasure(opts);
  const lopts = layoutOptions(opts);

  if (opts.command === 'inspect') {
    const result = layout(text, measure, lopts);
    const payload = {
      input: text,
      options: lopts,
      paragraphs: result.paragraphs.map(p => ({
        index: p.index,
        boxes: p.diagnostics?.boxes,
        units: p.diagnostics?.units,
        breakableBoundaries: p.diagnostics?.breakableBoundaries,
        blockedByKinsoku: p.diagnostics?.blockedByKinsoku,
        blockedByUax14: p.diagnostics?.blockedByUax14,
        compressedMarks: p.diagnostics?.compressedMarks,
        scriptGaps: p.diagnostics?.scriptGaps,
        emergencyBreakTokens: p.diagnostics?.emergencyBreakTokens,
        emergencyBreakPoints: p.diagnostics?.emergencyBreakPoints,
        ladder: p.diagnostics?.ladder,
        items: p.items,
      })),
    };
    if (opts.json) console.log(JSON.stringify(payload, null, 2));
    else {
      for (const p of payload.paragraphs) {
        console.log(`# 段落 ${p.index + 1}: ${p.boxes} boxes, ${p.breakableBoundaries} 可断边界, ` +
          `${p.blockedByKinsoku} 被禁则阻断, ${p.blockedByUax14} 被 UAX#14 阻断`);
        for (const [i, it] of p.items.entries()) {
          const desc = it.type === 'box' ? `box    w=${it.width.toFixed(1).padStart(7)} ${JSON.stringify(it.value)}`
            : it.type === 'glue' ? `glue   w=${String(it.width).padStart(5)} st=${String(it.stretch).padStart(6)} sh=${String(it.shrink).padStart(5)}${it.space ? ' [space]' : ''}`
              : `penalty ${it.penalty}${it.flagged ? ' flagged' : ''}`;
          console.log(`  ${String(i).padStart(4)} ${desc}`);
        }
      }
    }
    return EXIT_OK;
  }

  const result = layout(text, measure, lopts);

  if (opts.command === 'set') {
    if (opts.json) {
      console.log(JSON.stringify({
        width: lopts.width,
        font: fontPath,
        unitsPerEm: unitsPerEm ?? null,
        uax14: hasUax14,
        stats: result.stats,
        lines: result.lines.map(l => ({
          text: l.text,
          width: +l.width.toFixed(2),
          justifiedWidth: +l.justifiedWidth.toFixed(2),
          target: l.target,
          ratio: Number.isFinite(l.ratio) ? +l.ratio.toFixed(4) : null,
          addedPerBoundaryEm: +l.addedPerBoundaryEm.toFixed(4),
          finalLine: l.finalLine,
          ragged: l.ragged,
        })),
      }, null, 2));
      return EXIT_OK;
    }
    if (opts.quiet) {
      for (const l of result.lines) console.log(l.text);
      return EXIT_OK;
    }
    const title = `hanjustify set — 行宽 ${lopts.width}px`
      + (fontPath ? ` · 字体 ${fontPath}` : ` · 等宽模型 ${opts.size}px`)
      + (hasUax14 ? '' : ' · 降级断点（未安装 linebreak）');
    console.log(title);
    console.log('');
    for (const [i, l] of result.lines.entries()) {
      const marks = [];
      if (l.finalLine) marks.push('末行');
      if (l.ragged) marks.push('ragged');
      if (l.overfull) marks.push('溢出');
      if (l.startsWithForbidden) marks.push('首禁!');
      console.log(`  ${String(i + 1).padStart(2)} ${fmtRatio(l.ratio)}  ${l.width.toFixed(1).padStart(7)}/${l.target}  |${l.text}|${marks.length ? '   [' + marks.join(' ') + ']' : ''}`);
    }
    console.log('');
    console.log(`  ${result.stats.lineCount} 行 · 最大 |ratio| ${result.stats.maxAbsRatio.toFixed(2)}`
      + ` · 边界最大均摊空隙 ${result.stats.maxAddedPerBoundaryEm.toFixed(3)}em`
      + ` · 首禁违规 ${result.stats.kinsokuLineStartViolations}`
      + ` · 溢出 ${result.stats.overfullLines}`
      + (result.stats.raggedLines ? ` · ragged ${result.stats.raggedLines}` : ''));
    return EXIT_OK;
  }

  // --- audit ---
  const audit = auditLayout(result, text);
  if (opts.json) {
    console.log(JSON.stringify({ stats: result.stats, audit }, null, 2));
  } else {
    console.log(`hanjustify audit — 行宽 ${lopts.width}px · ${audit.paragraphs.length} 个段落`);
    if (!hasUax14) {
      console.log('  注意: 未安装 linebreak，断点来自降级实现（保守子集）。');
      console.log('        完整 UAX#14 结果需 `npm install`。');
    }
    console.log('');
    for (const p of audit.paragraphs) {
      console.log(`  段落 ${p.paragraph + 1}: ${p.ok ? '通过' : '失败'}`);
      for (const c of p.checks) {
        console.log(`    ${c.ok ? '✓' : '✗'} ${c.id} ${c.name.padEnd(12)} ${c.detail}`);
      }
    }
    const failed = audit.summary.failedChecks;
    console.log('');
    console.log(failed.length === 0
      ? `  全部 ${audit.paragraphs.length} 个段落通过 ${CHECKS_TOTAL} 项检查。`
      : `  失败: ${failed.map(f => `${f.id}×${f.failures}`).join(', ')}`);
  }

  if (!audit.ok) return EXIT_AUDIT_FAIL;
  if (result.stats.unsettableLines > 0) return EXIT_INDETERMINATE;
  return EXIT_OK;
}

const CHECKS_TOTAL = 7;

main().then(code => process.exit(code)).catch(err => {
  if (err?.code === 'EUNSETTABLE') {
    console.error('错误: 段落无法排版，且 ragged 回退也无解。');
    console.error('      这通常意味着单个不可分单元比行宽更窄却没有任何断点，请报告此输入。');
    process.exit(EXIT_INDETERMINATE);
  }
  console.error('未预期的错误:', err?.stack || err);
  process.exit(EXIT_USAGE);
});
