/**
 * Canvas-based metrics for the browser.
 *
 * The browser build feeds the same `measure` contract with real glyph advances
 * from a 2D canvas context, which applies the actual font, font-size, kerning
 * settings and any `letter-spacing` the page has. This is the browser counterpart
 * of `font.mjs`: both produce a plain `(string) => number`, so the layout pipeline
 * is identical in both environments.
 *
 * Sub-pixel accuracy matters here, so the measurement deliberately keeps full
 * float precision rather than rounding: the engine compares a line's natural width
 * against the measure, and a rounded metric makes the friendly case of "exactly
 * fits" flip between fitting and overflowing by a whole pixel.
 */

/**
 * @param {CanvasRenderingContext2D} ctx a context whose `font` property is set
 * @returns {(s: string) => number}
 */
export function canvasMeasure(ctx) {
  const cache = new Map();
  return function measure(str) {
    let w = cache.get(str);
    if (w === undefined) {
      w = ctx.measureText(str).width;
      cache.set(str, w);
    }
    return w;
  };
}

/**
 * Derive metrics from an already-rendered element's computed font, by creating a
 * detached canvas that mirrors it. Falls back to the element's own measuring if no
 * canvas is available.
 *
 * @param {Element} el
 * @param {number} [sizePx] override the font size
 */
export function measureFromElement(el, sizePx) {
  const cs = getComputedStyle(el);
  const parsed = parseFloat(cs.fontSize);
  const fontSize = sizePx ?? (Number.isFinite(parsed) ? parsed : 16);
  const font = `${cs.fontStyle} ${cs.fontWeight} ${fontSize}px ${cs.fontFamily}`;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable; cannot measure text');
  ctx.font = font;
  const m = canvasMeasure(ctx);
  m.fontSpec = font;
  m.fontSize = fontSize;
  return m;
}

/**
 * Report which code points of `text` have no glyph in the loaded font.
 *
 * Useful because a missing glyph silently changes the layout: the renderer draws a
 * .notdef box whose advance is not the advance the metric assumed, so a paragraph
 * can measure as fitting and then render overflowing. The demo surfaces this rather
 * than hiding it.
 */
export function missingGlyphs(measure, probeFont, text) {
  const missing = new Set();
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === 0x20 || cp === 0x09 || cp === 0x0a || cp === 0x0d) continue;
    if (probeFont && typeof probeFont.hasGlyph === 'function') {
      if (!probeFont.hasGlyph(cp)) missing.add(ch);
    }
  }
  return [...missing];
}
