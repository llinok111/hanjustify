/**
 * Font metrics, Node entry point.
 *
 * Kept as the single import site used by the CLI and the tests. The implementation
 * is split so the parsing/measuring logic can be bundled for the browser:
 *
 *   font.mjs           pure: parseFont / makeMeasure / uniformMeasure (no Node APIs)
 *   metrics-node.mjs   adds file-system loading
 *   metrics-canvas.mjs browser counterpart that measures through a canvas context
 *
 * This file re-exports the pure core plus the Node loader, so existing imports of
 * `../src/cjk/metrics.mjs` keep working.
 */
export { parseFont, makeMeasure, uniformMeasure, loadFont, loadFontBytes } from './metrics-node.mjs';
export { canvasMeasure, measureFromElement, missingGlyphs } from './metrics-canvas.mjs';
