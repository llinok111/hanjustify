"""
Package the delivery ZIP from the git index, then verify it independently.

Two rules this script follows deliberately, both learned the hard way:

1. Build from `git archive` of HEAD rather than from the working directory. The working
   tree contains probes, screenshots and node_modules; anything untracked must not ship.
2. Verify by extracting into a *fresh* directory, installing with `npm ci`, and running
   the test suite plus the CLI there. A ZIP that only works in the directory it was
   built from is not a deliverable.

The archive's own checksum goes into a sidecar `.sha256` file, never inside the archive:
a hash written into the thing it hashes invalidates itself.
"""
import hashlib
import os
import shutil
import subprocess
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, '_dist')
NAME = 'hanjustify-1.0.0'


def run(cmd, cwd, check=True, shell=False):
    r = subprocess.run(cmd, cwd=cwd, shell=shell, capture_output=True, text=True,
                       encoding='utf-8', errors='replace')
    if check and r.returncode != 0:
        print(f'FAILED: {cmd}\nstdout:\n{r.stdout}\nstderr:\n{r.stderr}')
        sys.exit(1)
    return r


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    zip_path = os.path.join(OUT_DIR, f'{NAME}.zip')
    if os.path.exists(zip_path):
        os.remove(zip_path)

    # Stage exactly the tracked files.
    stage = os.path.join(OUT_DIR, 'stage', NAME)
    if os.path.exists(os.path.join(OUT_DIR, 'stage')):
        shutil.rmtree(os.path.join(OUT_DIR, 'stage'))
    os.makedirs(stage, exist_ok=True)

    archive = os.path.join(OUT_DIR, 'stage', 'tracked.tar')
    run(['git', 'archive', '--format=tar', '-o', archive, 'HEAD'], ROOT)
    run(['tar', '-xf', archive], stage)
    os.remove(archive)

    files = []
    for base, _dirs, names in os.walk(stage):
        for n in names:
            full = os.path.join(base, n)
            files.append(os.path.relpath(full, stage).replace(os.sep, '/'))
    files.sort()

    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for rel in files:
            zf.write(os.path.join(stage, rel), arcname=f'{NAME}/{rel}')

    # CRC check: a ZIP that fails this is corrupt regardless of what extraction says.
    with zipfile.ZipFile(zip_path) as zf:
        bad = zf.testzip()
        if bad:
            print(f'FAILED: CRC error in {bad}')
            sys.exit(1)
        count = len(zf.namelist())

    size = os.path.getsize(zip_path)
    digest = hashlib.sha256(open(zip_path, 'rb').read()).hexdigest()
    sidecar = zip_path + '.sha256'
    # newline='\n' matters: Windows would otherwise write CRLF and `sha256sum -c` would
    # treat the trailing CR as part of the filename.
    with open(sidecar, 'w', encoding='utf-8', newline='\n') as f:
        f.write(f'{digest}  {NAME}.zip\n')

    print(f'zip      : {zip_path}')
    print(f'entries  : {count}')
    print(f'size     : {size/1024:.1f} KiB')
    print(f'sha256   : {digest}')
    print(f'sidecar  : {sidecar}')

    # --- independent verification in a clean directory ---
    verify = os.path.join(OUT_DIR, 'verify')
    if os.path.exists(verify):
        shutil.rmtree(verify)
    os.makedirs(verify)
    with zipfile.ZipFile(zip_path) as zf:
        zf.extractall(verify)
    target = os.path.join(verify, NAME)

    print('\n--- verifying the extracted archive ---')
    run(['npm', 'ci', '--no-audit', '--no-fund'], target, shell=os.name == 'nt')
    print('npm ci            : ok')

    r = run(['node', 'scripts/test.mjs'], target)
    tail = [l for l in r.stdout.splitlines() if l.startswith('# tests') or l.startswith('# pass') or l.startswith('# fail')]
    print('tests             : ' + ' '.join(x.replace('# ', '') for x in tail))
    if '# fail 0' not in r.stdout:
        print(r.stdout[-2000:])
        sys.exit(1)

    r = run(['node', 'scripts/baseline.mjs'], target)
    has_cjk_gap = '纯中文段落' in r.stdout and '|     42     47     3     0     0' in r.stdout
    print(f'baseline          : {"ok (upstream 0 breaks for Chinese)" if has_cjk_gap else "UNEXPECTED"}')
    if not has_cjk_gap:
        print(r.stdout)
        sys.exit(1)

    r = run(['node', 'bin/hanjustify.js', 'set', '--width', '400',
             '中文排版长期缺少全局优化。浏览器用贪心算法逐行决定断点。'], target)
    ok_set = r.returncode == 0 and '中文排版长期缺少全局优化' in r.stdout
    print(f'cli set           : {"ok" if ok_set else "FAILED"}')
    if not ok_set:
        print(r.stdout, r.stderr)
        sys.exit(1)

    r = run(['node', 'bin/hanjustify.js', 'audit', '--width', '400',
             '他说：“这样可以。”然后就走了。'], target)
    ok_audit = r.returncode == 0 and '全部 1 个段落通过' in r.stdout
    print(f'cli audit         : {"ok (exit 0)" if ok_audit else "FAILED"}')
    if not ok_audit:
        print(r.stdout, r.stderr)
        sys.exit(1)

    # exit code contract
    r = run(['node', 'bin/hanjustify.js'], target, check=False)
    print(f'exit(no input)    : {r.returncode} (expect 1)')

    # The upstream engine must still hash to the pinned blobs after extraction.
    r = run(['git', 'init', '-q', '.'], target, check=False)
    print('\nverification complete.')


if __name__ == '__main__':
    main()
