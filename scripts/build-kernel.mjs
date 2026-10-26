// Build the importable kernel from the *unmodified* upstream engine sources.
//
// bramstein/typeset ships `src/linked-list.js` and `src/linebreak.js` as browser
// globals that assign onto a `Typeset` namespace object. The wrapper below does
// not rewrite them: it concatenates the byte-identical upstream text and only
// appends a small export footer. `test/upstream-parity.test.mjs` asserts that the
// upstream files in the working tree still hash to the upstream blobs, so any
// accidental edit to the engine fails the build.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');

const upstreamFiles = ['src/linked-list.js', 'src/linebreak.js'];
const upstream = upstreamFiles.map(read).join('\n');

const banner = `// GENERATED FILE -- do not edit by hand.
// Produced by scripts/build-kernel.mjs from:
${upstreamFiles.map(f => `//   ${f}`).join('\n')}
// The sources below are copied verbatim from bramstein/typeset (BSD-2-Clause).
// Only the export footer is new.

`;

const footer = `
// --- export footer added by hanjustify (not part of upstream) ---
export const linebreak = Typeset.linebreak;
export const KnuthLinkedList = Typeset.LinkedList;
export { Typeset };
`;

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist/kernel.mjs'), banner + upstream + footer);

// Report hashes so a CI log proves the engine input was unmodified.
const { createHash } = await import('node:crypto');
for (const f of upstreamFiles) {
  const h = createHash('sha256').update(read(f), 'utf8').digest('hex');
  console.log(`kernel input ${f} sha256=${h}`);
}
console.log('wrote dist/kernel.mjs');
