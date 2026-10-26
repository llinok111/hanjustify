/**
 * Node-side font metric loading.
 *
 * The parsing and measuring logic lives in `font.mjs` (no Node built-ins, shared
 * with the browser build); this module only adds the file-system access.
 */
import { readFileSync } from 'node:fs';
import { parseFont, makeMeasure, uniformMeasure } from './font.mjs';

export { parseFont, makeMeasure, uniformMeasure };

/**
 * Load a font from disk.
 *
 * @param {string} path TTF / OTF / TTC
 * @param {{size?: number, faceIndex?: number}} [opts]
 * @returns {{font: object, measure: (s: string) => number}}
 */
export function loadFont(path, { size = 20, faceIndex = 0 } = {}) {
  const bytes = readFileSync(path);
  const font = parseFont(bytes, { faceIndex });
  return { font, measure: makeMeasure(font, size) };
}

/** Load raw font bytes (used by the browser build via fetch + parseFont). */
export function loadFontBytes(path, opts) {
  return parseFont(readFileSync(path), opts);
}
