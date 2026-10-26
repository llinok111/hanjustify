// Build the importable kernel from the *unmodified* upstream engine sources.
//
// bramstein/typeset ships `src/linked-list.js` and `src/linebreak.js` as browser
// globals that assign onto a `Typeset` namespace object. The wrapper below does not
// rewrite them: it concatenates the byte-identical upstream text and only appends a
// small export footer. `test/upstream-parity.test.mjs` asserts that these files still
// hash to the upstream blobs, and `test/package.test.mjs` asserts that the committed
// `dist/kernel.mjs` is exactly what this script renders -- so the checked-in artefact
// cannot drift from its inputs.
//
// `dist/kernel.mjs` is committed on purpose. It is generated, but a fresh clone has to
// be runnable (`node bin/hanjustify.js ...`) without a build step, and the demo bundle
// resolves it at bundle time. CI caught the alternative: with `dist/` gitignored, a
// clean checkout could neither run the CLI nor build the demo.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export const UPSTREAM_FILES = ['src/linked-list.js', 'src/linebreak.js'];

const defaultRead = p => readFileSync(join(root, p), 'utf8');

/** Render the kernel text from the upstream sources. Pure: performs no writes. */
export function renderKernel(read = defaultRead) {
  const upstream = UPSTREAM_FILES.map(read).join('\n');
  const banner = `// GENERATED FILE -- do not edit by hand.
// Produced by scripts/build-kernel.mjs from:
${UPSTREAM_FILES.map(f => `//   ${f}`).join('\n')}
// The sources below are copied verbatim from bramstein/typeset (BSD-2-Clause).
// Only the export footer is new.

`;
  const footer = `
// --- export footer added by hanjustify (not part of upstream) ---
export const linebreak = Typeset.linebreak;
export const KnuthLinkedList = Typeset.LinkedList;
export { Typeset };
`;
  return banner + upstream + footer;
}

/** SHA-256 of each upstream input, so a CI log proves the engine was unmodified. */
export function upstreamHashes(read = defaultRead) {
  return Object.fromEntries(
    UPSTREAM_FILES.map(f => [f, createHash('sha256').update(read(f), 'utf8').digest('hex')]),
  );
}

/** Write dist/kernel.mjs. Returns the hashes it recorded. */
export function buildKernel({ quiet = false } = {}) {
  mkdirSync(join(root, 'dist'), { recursive: true });
  const text = renderKernel();
  writeFileSync(join(root, 'dist/kernel.mjs'), text);
  const hashes = upstreamHashes();
  if (!quiet) {
    for (const [f, h] of Object.entries(hashes)) console.log(`kernel input ${f} sha256=${h}`);
    console.log(`wrote dist/kernel.mjs (${text.length} bytes)`);
  }
  return { hashes, text };
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) buildKernel();
