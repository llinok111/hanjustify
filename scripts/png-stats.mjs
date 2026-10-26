#!/usr/bin/env node
/**
 * PNG pixel statistics for screenshots.
 *
 * Written because a DOM probe cannot see what is actually painted: it reports the
 * geometry the browser computed, not the pixels it emitted. A page can pass every
 * DOM assertion and still render blank (bad stacking order, a failed font, a
 * colour-on-colour mistake). This decodes the PNG and measures the image directly.
 *
 * Reports
 *   size / unique colours / mean brightness     -- catches a fully blank frame
 *   ink density on a grid                       -- catches a blank or collapsed region
 *   per-line right-edge position and its spread -- catches a broken justification
 *   bottom margin ink                           -- catches clipped content
 *
 * Usage: node scripts/png-stats.mjs <file.png> [--grid 6x4] [--json]
 *
 * Only 8-bit RGB / RGBA non-interlaced PNGs are supported, which is what every
 * Chromium screenshot produces.
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function decodePng(buf) {
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== PNG_SIG[i]) throw new Error('not a PNG file');
  }
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colourType = 0;
  let interlace = 0;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const dataStart = off + 8;
    if (type === 'IHDR') {
      width = buf.readUInt32BE(dataStart);
      height = buf.readUInt32BE(dataStart + 4);
      bitDepth = buf[dataStart + 8];
      colourType = buf[dataStart + 9];
      interlace = buf[dataStart + 12];
    } else if (type === 'IDAT') {
      idat.push(buf.subarray(dataStart, dataStart + len));
    } else if (type === 'IEND') {
      break;
    }
    off = dataStart + len + 4; // skip CRC
  }
  if (!width || !height) throw new Error('PNG has no IHDR');
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
  if (interlace !== 0) throw new Error('interlaced PNG is not supported');
  const channels = colourType === 6 ? 4 : colourType === 2 ? 3 : colourType === 0 ? 1 : null;
  if (channels === null) throw new Error(`unsupported colour type ${colourType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      const v = line[x];
      let val;
      switch (filter) {
        case 0: val = v; break;
        case 1: val = v + a; break;
        case 2: val = v + b; break;
        case 3: val = v + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          val = v + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c));
          break;
        }
        default: throw new Error(`unknown PNG filter ${filter} at row ${y}`);
      }
      cur[x] = val & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

/** Perceptual luma, 0..255. */
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * Estimate the page background as the most frequent coarse colour over a region.
 *
 * The mode is robust where corner sampling is not: a page can legitimately have a
 * light panel in one corner, but the background is by construction the colour with
 * the largest pixel count.
 */
function estimateBackground(img, xLimit) {
  const { width, height, channels, data } = img;
  const counts = new Map();
  const limit = xLimit ?? width;
  let n = 0;
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < limit; x += 2) {
      const i = (y * width + x) * channels;
      const key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      n++;
    }
  }
  let bestKey = 0;
  let bestCount = -1;
  for (const [k, c] of counts) if (c > bestCount) { bestCount = c; bestKey = k; }
  const r = ((bestKey >> 10) & 31) << 3;
  const g = ((bestKey >> 5) & 31) << 3;
  const b = (bestKey & 31) << 3;
  return { rgb: [r, g, b], fraction: bestCount / n };
}

/**
 * Detect a scrollbar as a light strip along the right edge.
 *
 * A Chromium screenshot of a scrolling page includes the scrollbar, which is drawn
 * in the OS theme colour and is not page content. It cannot be found by testing
 * whether a column is a single uniform colour: the thumb makes the middle columns
 * non-uniform (measured on the demo screenshot -- white track at x=1239..1241, a
 * grey thumb at x=1242..1250, white again at x=1251..1253). The reliable signal is
 * the *median* luma of a column being far above the page background.
 */
function scrollbarWidth(img, bgLuma) {
  const { width, height, channels, data } = img;
  const columnMedian = x => {
    const vals = [];
    for (let y = 0; y < height; y += 3) {
      const i = (y * width + x) * channels;
      vals.push(luma(data[i], data[i + 1], data[i + 2]));
    }
    vals.sort((a, b) => a - b);
    return vals[Math.floor(vals.length / 2)];
  };
  let w = 0;
  for (let x = width - 1; x >= 0 && w < 40; x--) {
    if (columnMedian(x) > bgLuma + 60) w++;
    else break;
  }
  return w >= 4 ? w : 0;
}

export function stats(img, { grid = [6, 4], inkThreshold = 24 } = {}) {
  const { width, height, channels, data } = img;
  // Estimate the background from the left 60% only: the scrollbar lives on the
  // right, and letting it into the sample is what made the first version of this
  // script report a 98% ink ratio on a dark page.
  const bgInfo = estimateBackground(img, Math.floor(width * 0.6));
  const [br, bgc, bb] = bgInfo.rgb;
  const bgLuma = luma(br, bgc, bb);
  const barW = scrollbarWidth(img, bgLuma);

  const colours = new Set();
  let sum = 0;
  let count = 0;
  let inkTotal = 0;
  const isInk = new Uint8Array(width * height);
  const contentWidth = width - barW;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      colours.add((r << 16) | (g << 8) | b);
      sum += luma(r, g, b);
      count++;
      if (x >= contentWidth) continue; // never count the scrollbar as ink
      // Euclidean RGB distance from the background, which catches a change in hue
      // at constant luma (e.g. a blue accent on a dark grey page).
      const d = Math.sqrt((r - br) ** 2 + (g - bgc) ** 2 + (b - bb) ** 2);
      if (d > inkThreshold) { isInk[y * width + x] = 1; inkTotal++; }
    }
  }

  const [gx, gy] = grid;
  const cells = [];
  for (let cy = 0; cy < gy; cy++) {
    const row = [];
    for (let cx = 0; cx < gx; cx++) {
      const x0 = Math.floor((cx * contentWidth) / gx);
      const x1 = Math.floor(((cx + 1) * contentWidth) / gx);
      const y0 = Math.floor((cy * height) / gy);
      const y1 = Math.floor(((cy + 1) * height) / gy);
      let ink = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) { ink += isInk[y * width + x]; n++; }
      }
      row.push(+(ink / n * 100).toFixed(2));
    }
    cells.push(row);
  }

  // Detect text rows: rows whose ink count is materially above the page median.
  const rowInk = new Float64Array(height);
  for (let y = 0; y < height; y++) {
    let c = 0;
    for (let x = 0; x < contentWidth; x++) c += isInk[y * width + x];
    rowInk[y] = c;
  }
  const sorted = [...rowInk].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const textRows = [];
  for (let y = 0; y < height; y++) if (rowInk[y] > median + 6) textRows.push(y);

  const bands = [];
  let cur = null;
  for (const y of textRows) {
    if (!cur || y - cur.end > 2) { cur = { start: y, end: y }; bands.push(cur); }
    else cur.end = y;
  }
  for (const b of bands) {
    let left = contentWidth;
    let right = -1;
    for (let y = b.start; y <= b.end; y++) {
      for (let x = 0; x < contentWidth; x++) {
        if (isInk[y * width + x]) { if (x < left) left = x; if (x > right) right = x; }
      }
    }
    b.left = left;
    b.right = right;
    b.span = right - left + 1;
  }
  const wide = bands.filter(b => b.span > contentWidth * 0.15);

  let bottomInk = 0;
  for (let y = Math.max(0, height - 40); y < height; y++) {
    for (let x = 0; x < contentWidth; x++) bottomInk += isInk[y * width + x];
  }

  return {
    width,
    height,
    channels,
    scrollbarWidth: barW,
    contentWidth,
    uniqueColours: colours.size,
    meanBrightness: +(sum / count).toFixed(2),
    backgroundRgb: bgInfo.rgb,
    backgroundLuma: +bgLuma.toFixed(2),
    backgroundFraction: +(bgInfo.fraction * 100).toFixed(1),
    inkPercent: +(inkTotal / (width * height) * 100).toFixed(3),
    grid: cells,
    textBandCount: bands.length,
    wideTextBands: wide.length,
    rightEdges: wide.map(b => b.right),
    rightEdgeSpread: wide.length > 1 ? Math.max(...wide.map(b => b.right)) - Math.min(...wide.map(b => b.right)) : 0,
    bandSpans: wide.map(b => b.span),
    bottomInkPercent: +(bottomInk / (40 * contentWidth) * 100).toFixed(3),
  };
}

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('用法: node scripts/png-stats.mjs <file.png> [--json]');
    process.exit(1);
  }
  const img = decodePng(readFileSync(file));
  const s = stats(img, { grid: [6, 4] });
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(s, null, 2));
    return;
  }
  console.log(`文件: ${file}`);
  console.log(`尺寸: ${s.width}×${s.height}  通道 ${s.channels}  唯一色 ${s.uniqueColours}`);
  console.log(`滚动条宽度: ${s.scrollbarWidth}px  内容宽 ${s.contentWidth}px`);
  console.log(`亮度: 均值 ${s.meanBrightness}  背景 ${s.backgroundLuma} rgb=${JSON.stringify(s.backgroundRgb)}（占 ${s.backgroundFraction}%）  墨量 ${s.inkPercent}%`);
  console.log(`文本行带: ${s.textBandCount}（其中宽行 ${s.wideTextBands}）`);
  console.log(`右边缘位置: ${JSON.stringify(s.rightEdges.slice(0, 12))}${s.rightEdges.length > 12 ? ' …' : ''}  极差 ${s.rightEdgeSpread}px`);
  console.log(`底部 40px 墨量: ${s.bottomInkPercent}%`);
  console.log('墨量网格 (%):');
  for (const row of s.grid) console.log('  ' + row.map(v => String(v).padStart(6)).join(''));
}

/**
 * Measure the alignment of text right edges inside one rectangle of the image.
 *
 * This is the check a DOM probe cannot make. The DOM reports the width the layout
 * engine asked for; the pixels report what was painted. If a renderer applies the
 * wrong spacing, everything agrees at the DOM level and the right edge is visibly
 * ragged, which is exactly the defect justified setting is supposed to eliminate.
 *
 * @param {object} img decoded image
 * @param {{x:number,y:number,w:number,h:number}} rect device-pixel rectangle
 * @param {object} [opts]
 * @param {number} [opts.inkThreshold] RGB distance from the local background
 * @param {number} [opts.minBandHeight] ignore bands thinner than this
 * @returns {{bandCount:number, rightEdges:number[], modalRight:number|null,
 *            alignedCount:number, alignedFraction:number, maxGapPx:number}}
 */
export function regionRightEdges(img, rect, { inkThreshold = 28, minBandHeight = 6 } = {}) {
  const { width, height, channels, data } = img;
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(width, Math.ceil(rect.x + rect.w));
  const y1 = Math.min(height, Math.ceil(rect.y + rect.h));
  if (x1 <= x0 || y1 <= y0) throw new Error('empty region');

  // Local background: the modal colour inside the rectangle.
  const counts = new Map();
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * channels;
      const key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  let bestKey = 0;
  let bestCount = -1;
  for (const [k, c] of counts) if (c > bestCount) { bestCount = c; bestKey = k; }
  const br = ((bestKey >> 10) & 31) << 3;
  const bg = ((bestKey >> 5) & 31) << 3;
  const bbb = (bestKey & 31) << 3;

  const isInk = (x, y) => {
    const i = (y * width + x) * channels;
    return Math.sqrt((data[i] - br) ** 2 + (data[i + 1] - bg) ** 2 + (data[i + 2] - bbb) ** 2) > inkThreshold;
  };

  const rows = [];
  for (let y = y0; y < y1; y++) {
    let c = 0;
    for (let x = x0; x < x1; x++) if (isInk(x, y)) c++;
    rows.push({ y, c });
  }
  const countsSorted = rows.map(r => r.c).sort((a, b) => a - b);
  const median = countsSorted[Math.floor(countsSorted.length / 2)];
  const threshold = Math.max(3, median + 2);

  const bands = [];
  let cur = null;
  for (const r of rows) {
    if (r.c > threshold) {
      if (!cur || r.y - cur.end > 3) { cur = { start: r.y, end: r.y }; bands.push(cur); }
      else cur.end = r.y;
    }
  }

  const rightEdges = [];
  for (const b of bands) {
    if (b.end - b.start + 1 < minBandHeight) continue;
    let right = -1;
    for (let y = b.start; y <= b.end; y++) {
      for (let x = x1 - 1; x >= x0; x--) {
        if (isInk(x, y)) { if (x > right) right = x; break; }
      }
    }
    if (right >= 0) rightEdges.push(right);
  }

  // Modal right edge: the value the majority of lines share when the block is
  // properly justified.
  const hist = new Map();
  for (const r of rightEdges) hist.set(r, (hist.get(r) ?? 0) + 1);
  let modalRight = null;
  let modalCount = -1;
  for (const [r, c] of hist) if (c > modalCount) { modalCount = c; modalRight = r; }
  const aligned = modalRight === null ? 0 : rightEdges.filter(r => Math.abs(r - modalRight) <= 1).length;

  return {
    bandCount: rightEdges.length,
    rightEdges,
    modalRight,
    alignedCount: aligned,
    alignedFraction: rightEdges.length ? +(aligned / rightEdges.length).toFixed(3) : 0,
    maxGapPx: rightEdges.length ? Math.max(...rightEdges) - Math.min(...rightEdges) : 0,
  };
}

/**
 * Rightmost painted pixel of one horizontal band inside a rectangle.
 *
 * This is the primitive for cross-checking paint against geometry line by line:
 * the DOM reports the box the layout engine asked for, and this reports where the
 * ink actually stopped. For justified Chinese the two agree except that a line
 * ending in a fullwidth stop mark has its ink inset by roughly half an em, because
 * the mark's ink sits at the left of its em box (clreq §5.1.1.1). So the useful
 * assertion is one-sided: ink must never extend past the box, and it must reach
 * close to it.
 *
 * @param {object} img decoded image
 * @param {{x:number,y:number,w:number,h:number}} rect band rectangle in device px
 * @param {{inkThreshold?: number}} [opts]
 * @returns {{right:number, inkPixels:number}}
 */
export function bandInkRight(img, rect, { inkThreshold = 28 } = {}) {
  const { width, height, channels, data } = img;
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(width, Math.ceil(rect.x + rect.w));
  const y1 = Math.min(height, Math.ceil(rect.y + rect.h));
  if (x1 <= x0 || y1 <= y0) return { right: -1, inkPixels: 0 };

  const counts = new Map();
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * channels;
      const key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  let bestKey = 0;
  let bestCount = -1;
  for (const [k, c] of counts) if (c > bestCount) { bestCount = c; bestKey = k; }
  const br = ((bestKey >> 10) & 31) << 3;
  const bg = ((bestKey >> 5) & 31) << 3;
  const bbb = (bestKey & 31) << 3;

  let right = -1;
  let inkPixels = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * channels;
      const d = Math.sqrt((data[i] - br) ** 2 + (data[i + 1] - bg) ** 2 + (data[i + 2] - bbb) ** 2);
      if (d > inkThreshold) { inkPixels++; if (x > right) right = x; }
    }
  }
  return { right, inkPixels };
}

export { luma, estimateBackground, scrollbarWidth };

if (process.argv[1] && process.argv[1].endsWith('png-stats.mjs')) main();
