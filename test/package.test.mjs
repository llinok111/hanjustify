/**
 * Packaging tests.
 *
 * These catch the class of defect that unit tests never see: a script that points at
 * a file nobody created, a `files` list that omits something the package needs at
 * runtime, or a module that only fails when it is actually imported. All of them are
 * cheap here and expensive after publishing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

test('package.json declares the fields the package needs', () => {
  assert.equal(pkg.name, 'hanjustify');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.license, 'BSD-2-Clause');
  assert.ok(pkg.exports, 'exports map is required for ESM consumers');
  assert.ok(pkg.engines?.node, 'engines.node must be declared; CI tests that floor');
  assert.ok(pkg.files?.length, 'files must be declared or the package ships the repo');
});

test('every script points at a file that exists', () => {
  for (const [name, cmd] of Object.entries(pkg.scripts)) {
    // Only check commands of the shape `node <path> ...`; anything else (&&) is
    // split first so each segment is examined.
    for (const segment of cmd.split('&&')) {
      const parts = segment.trim().split(/\s+/);
      if (parts[0] !== 'node') continue;
      const target = parts.find(p => p.endsWith('.js') || p.endsWith('.mjs'));
      if (!target) continue;
      assert.ok(existsSync(join(root, target)), `script "${name}" refers to missing file ${target}`);
    }
  }
});

test('the bin entry exists and starts with a shebang', () => {
  const bin = pkg.bin?.hanjustify;
  assert.ok(bin, 'bin.hanjustify must be declared');
  const path = join(root, bin);
  assert.ok(existsSync(path));
  assert.ok(readFileSync(path, 'utf8').startsWith('#!/usr/bin/env node'), 'bin must be executable via npx');
});

test('the files whitelist covers everything the runtime needs', () => {
  const files = pkg.files;
  for (const required of ['bin', 'dist', 'src', 'LICENSE', 'NOTICE', 'README.md']) {
    assert.ok(files.includes(required), `files[] must include "${required}"`);
  }
  // Any path listed in files[] must exist, or npm silently ships less than promised.
  for (const f of files) {
    assert.ok(existsSync(join(root, f)), `files[] lists "${f}" but it does not exist`);
  }
});

test('LICENSE and NOTICE are both present and non-trivial', () => {
  const licence = readFileSync(join(root, 'LICENSE'), 'utf8');
  const notice = readFileSync(join(root, 'NOTICE'), 'utf8');
  assert.match(licence, /BSD 2-Clause|Redistribution and use in source and binary forms/);
  assert.match(licence, /Bram Stein/, 'upstream copyright must be retained');
  assert.match(notice, /bramstein\/typeset/);
  assert.match(notice, /48ebb55/, 'the exact upstream commit must be recorded');
  assert.match(notice, /sha256 [0-9a-f]{64}/, 'the pinned upstream hashes must be recorded');
});

test('the upstream README is preserved', () => {
  const upstream = readFileSync(join(root, 'docs/UPSTREAM-README.md'), 'utf8');
  assert.match(upstream, /Knuth and Plass/);
});

test('every module in src/ imports cleanly', async () => {
  // A module that fails at import time (syntax error, bad top-level code, a Node
  // built-in pulled into a browser bundle) is invisible to tests that never load it.
  const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p) : (e.name.endsWith('.mjs') ? [p] : []);
  });
  const modules = walk(join(root, 'src'));
  assert.ok(modules.length >= 6, `expected several modules, found ${modules.length}`);
  for (const m of modules) {
    await import(pathToFileURL(m).href);
  }
});

test('the font module has no Node built-in dependencies', () => {
  // font.mjs is shared with the browser bundle; a `node:fs` import there would break
  // the demo build, and only at bundle time.
  const src = readFileSync(join(root, 'src/cjk/font.mjs'), 'utf8');
  assert.ok(!/from ['"]node:/.test(src), 'src/cjk/font.mjs must stay portable');
  assert.ok(!/require\(/.test(src));
});

test('the built kernel exists and exports the engine', async () => {
  const kernelPath = join(root, 'dist/kernel.mjs');
  if (!existsSync(kernelPath)) {
    assert.fail('dist/kernel.mjs is missing; run `npm run build` before `npm test`');
  }
  const kernel = await import(pathToFileURL(kernelPath).href);
  assert.equal(typeof kernel.linebreak, 'function');
  assert.ok(kernel.KnuthLinkedList);
});

test('the demo bundle exists and is a module', () => {
  const bundle = join(root, 'demo/hanjustify.bundle.js');
  assert.ok(existsSync(bundle), 'demo/hanjustify.bundle.js is missing; run `npm run build:demo`');
  const src = readFileSync(bundle, 'utf8');
  assert.match(src, /GENERATED by scripts\/build-demo\.mjs/);
  assert.ok(src.length > 50000, 'bundle looks too small to contain the engine');
});

test('the demo page references the bundle with a relative path', () => {
  // GitHub Pages serves the project under /<repo>/, so an absolute /src path 404s.
  const html = readFileSync(join(root, 'demo/index.html'), 'utf8');
  assert.match(html, /from '\.\/hanjustify\.bundle\.js'/);
  assert.ok(!/from '\/[^']*'/.test(html), 'no absolute module paths in the demo');
});
