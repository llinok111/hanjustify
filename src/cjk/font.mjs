/**
 * Pure font-metrics core: no Node built-ins, so the same code runs in the browser.
 *
 * The upstream engine is browser-only because it obtains every width from the DOM
 * (`examples/article/browser-assist.js` inserts hidden spans and reads
 * `offsetWidth`). That makes the algorithm untestable headlessly and unusable for
 * server-side rendering. Reading advance widths straight out of a font file
 * removes both limitations and works identically in Node and in the browser.
 *
 * Only the tables needed for advance widths are parsed: head, hhea, hmtx, cmap
 * (formats 4 and 12), optionally maxp. Glyph outlines are never read.
 */

const TAG = (dv, off) =>
  String.fromCharCode(dv.getUint8(off), dv.getUint8(off + 1), dv.getUint8(off + 2), dv.getUint8(off + 3));

function readTableDirectory(dv, base) {
  const numTables = dv.getUint16(base + 4);
  const tables = Object.create(null);
  for (let i = 0; i < numTables; i++) {
    const o = base + 12 + i * 16;
    tables[TAG(dv, o)] = { off: dv.getUint32(o + 8), len: dv.getUint32(o + 12) };
  }
  return tables;
}

/** Locate sfnt offsets: handles plain TTF/OTF and TTC collections. */
function findSfntOffsets(dv) {
  if (dv.byteLength < 12) return null;
  const tag = dv.getUint32(0);
  if (tag === 0x74746366) { // 'ttcf'
    const numFonts = dv.getUint32(8);
    if (numFonts === 0) return null;
    return { offsets: Array.from({ length: numFonts }, (_, i) => dv.getUint32(12 + i * 4)), isCollection: true };
  }
  return { offsets: [0], isCollection: false };
}

/**
 * Parse font bytes into an advance-width provider.
 *
 * @param {Uint8Array} bytes raw font bytes
 * @param {{faceIndex?: number}} [opts]
 */
export function parseFont(bytes, opts = {}) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const found = findSfntOffsets(dv);
  if (!found) throw new Error('not a font: sfnt header is missing or truncated');
  const { offsets, isCollection } = found;
  const faceIndex = opts.faceIndex ?? 0;
  if (faceIndex >= offsets.length) {
    throw new Error(`faceIndex ${faceIndex} out of range (font has ${offsets.length} face(s))`);
  }
  const tables = readTableDirectory(dv, offsets[faceIndex]);
  for (const need of ['head', 'hhea', 'hmtx', 'cmap']) {
    if (!tables[need]) throw new Error(`font is missing required table "${need}"`);
  }

  const unitsPerEm = dv.getUint16(tables.head.off + 18);
  const numberOfHMetrics = dv.getUint16(tables.hhea.off + 34);
  const hmtxOff = tables.hmtx.off;
  const numGlyphs = tables.maxp ? dv.getUint16(tables.maxp.off + 4) : -1;

  // --- cmap: prefer a full-repertoire format 12 subtable, else format 4 ---
  const cmapOff = tables.cmap.off;
  const numSubtables = dv.getUint16(cmapOff + 2);
  let fmt12 = null;
  let fmt4 = null;
  for (let i = 0; i < numSubtables; i++) {
    const rec = cmapOff + 4 + i * 8;
    const platformId = dv.getUint16(rec);
    const encodingId = dv.getUint16(rec + 2);
    const subOff = cmapOff + dv.getUint32(rec + 4);
    if (subOff + 4 > buf.length) continue;
    const format = dv.getUint16(subOff);
    if (format === 12 && platformId === 3 && (encodingId === 10 || encodingId === 1)) fmt12 = subOff;
    else if (format === 4 && platformId === 3 && encodingId === 1) fmt4 = subOff;
    else if (format === 4 && fmt4 === null && platformId === 0) fmt4 = subOff;
  }
  if (fmt12 === null && fmt4 === null) {
    throw new Error('font has no usable cmap subtable (need format 4 or 12)');
  }

  const lookupFmt12 = cp => {
    const n = dv.getUint32(fmt12 + 12);
    let lo = 0;
    let hi = n - 1;
    // Format 12 group layout, 12 bytes per group:
    //   +0 startCharCode  +4 endCharCode  +8 startGlyphID
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const g = fmt12 + 16 + mid * 12;
      const start = dv.getUint32(g);
      const end = dv.getUint32(g + 4);
      if (cp < start) hi = mid - 1;
      else if (cp > end) lo = mid + 1;
      else return dv.getUint32(g + 8) + (cp - start);
    }
    return -1;
  };

  const lookupFmt4 = cp => {
    if (cp > 0xffff) return -1;
    const segX2 = dv.getUint16(fmt4 + 6);
    const segCount = segX2 / 2;
    const endOff = fmt4 + 14;
    const startOff = endOff + segX2 + 2;
    const deltaOff = startOff + segX2;
    const rangeOff = deltaOff + segX2;
    for (let i = 0; i < segCount; i++) {
      const end = dv.getUint16(endOff + i * 2);
      if (cp > end) continue;
      const start = dv.getUint16(startOff + i * 2);
      if (cp < start) return -1;
      const delta = dv.getInt16(deltaOff + i * 2);
      const rangeOffset = dv.getUint16(rangeOff + i * 2);
      if (rangeOffset === 0) return (cp + delta) & 0xffff;
      const addr = rangeOff + i * 2 + rangeOffset + (cp - start) * 2;
      if (addr + 2 > buf.length) return -1;
      const g = dv.getUint16(addr);
      return g === 0 ? -1 : (g + delta) & 0xffff;
    }
    return -1;
  };

  const glyphIdCache = new Map();
  function glyphId(cp) {
    let g = glyphIdCache.get(cp);
    if (g !== undefined) return g;
    g = fmt12 !== null ? lookupFmt12(cp) : -1;
    if (g < 0 && fmt4 !== null) g = lookupFmt4(cp);
    glyphIdCache.set(cp, g);
    return g;
  }

  const advanceCache = new Map();
  function advanceUnits(cp) {
    let a = advanceCache.get(cp);
    if (a !== undefined) return a;
    const g = glyphId(cp);
    if (g < 0) { advanceCache.set(cp, NaN); return NaN; }
    const idx = g < numberOfHMetrics ? g : numberOfHMetrics - 1;
    a = dv.getUint16(hmtxOff + idx * 4);
    advanceCache.set(cp, a);
    return a;
  }

  return {
    unitsPerEm,
    numGlyphs,
    isCollection,
    faceCount: offsets.length,
    faceIndex,
    advance(cp, size) {
      const a = advanceUnits(cp);
      return Number.isNaN(a) ? NaN : (a / unitsPerEm) * size;
    },
    advanceUnits,
    hasGlyph: cp => glyphId(cp) >= 0,
    glyphId,
  };
}

/**
 * Build a `measure` function in the shape the upstream formatter expects.
 *
 * `measure(str)` is called with a single space for word spacing and with whole
 * runs otherwise, so it must sum per-code-point advances rather than assume a fixed
 * cell width. Unmapped code points still occupy space in every real renderer (the
 * .notdef box), so they fall back to half an em instead of collapsing the run.
 */
export function makeMeasure(font, size, { missingRatio = 0.5 } = {}) {
  return function measure(str) {
    let w = 0;
    for (const ch of str) {
      const a = font.advance(ch.codePointAt(0), size);
      w += Number.isNaN(a) ? size * missingRatio : a;
    }
    return w;
  };
}

/**
 * Deterministic fallback metrics for tests and for the CLI when no font is
 * available. Han and CJK-adjacent punctuation = 1em, other non-ASCII = 1em,
 * ASCII = 0.5em, space = 0.25em. Intentionally crude: it exists so layout logic
 * can be tested without a font on the machine, not to model a real typeface.
 */
export function uniformMeasure(size, { latinRatio = 0.5, spaceRatio = 0.25 } = {}) {
  return function measure(str) {
    let w = 0;
    for (const ch of str) {
      const cp = ch.codePointAt(0);
      if (cp === 0x20 || cp === 0x09) w += size * spaceRatio;
      else w += cp < 0x2500 ? size * latinRatio : size;
    }
    return w;
  };
}
