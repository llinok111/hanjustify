/**
 * Browser demo entry.
 *
 * Bundled by scripts/build-demo.mjs into demo/hanjustify.bundle.js. Uses the exact
 * same layout pipeline as the CLI: the only difference is where widths come from
 * (a canvas context here, a font file there), which is the point the demo makes.
 */
import { layout, breakOpportunities } from '../src/cjk/layout.mjs';
import { setLineBreaker } from '../src/cjk/segment.mjs';
import { canvasMeasure } from '../src/cjk/metrics-canvas.mjs';
import LineBreaker from 'linebreak';

setLineBreaker(LineBreaker);

export { layout, breakOpportunities, canvasMeasure, LineBreaker };
