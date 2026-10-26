#!/usr/bin/env node
/**
 * Cross-platform test runner.
 *
 * Why not `node --test test/` or `node --test "test/*.test.mjs"`:
 *   - `node --test test/` fails on Windows (the directory is resolved as a module)
 *     and directory-argument semantics differ between Node 18 and 22.
 *   - A *quoted* glob argument is a Node 22 feature; on Node 18/20 it is passed
 *     through literally and matches nothing, which makes the suite pass vacuously.
 *   - npm runs scripts through cmd.exe on Windows, where the shell does not expand
 *     globs, so an unquoted glob is no more reliable.
 *
 * Expanding the file list here sidesteps all three. It also makes the count of
 * discovered files explicit, so a run that finds nothing is visibly wrong instead
 * of silently green.
 */
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const testDir = join(root, 'test');

const files = readdirSync(testDir)
  .filter(f => f.endsWith('.test.mjs'))
  .sort()
  .map(f => join(testDir, f));

if (files.length === 0) {
  console.error('未发现任何 *.test.mjs —— 测试配置有误，拒绝以"零测试通过"结束。');
  process.exit(1);
}

const args = ['--test', ...files];
if (process.argv.includes('--test-name-pattern')) {
  const i = process.argv.indexOf('--test-name-pattern');
  const v = process.argv[i + 1];
  if (v !== undefined) args.push('--test-name-pattern', v);
}

console.log(`发现 ${files.length} 个测试文件:`);
for (const f of files) console.log(`  ${f.slice(root.length + 1)}`);
console.log('');

const r = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: root });
process.exit(r.status ?? 1);
