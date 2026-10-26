#!/usr/bin/env node
/**
 * Browser verification for the demo page.
 *
 * Drives a headless Edge/Chrome over the DevTools Protocol -- using Node's built-in
 * WebSocket, so there is no puppeteer or playwright dependency -- and asserts the
 * page twice over:
 *
 *   against its own DOM      what geometry the browser computed
 *   against the painted PNG  what pixels it actually emitted
 *
 * The second pass is not optional. A page can satisfy every DOM assertion and still
 * paint blank, clipped, or visibly ragged; only the pixels show that. `png-stats.mjs`
 * decodes the screenshot with zlib and compares each line's ink extent with the box
 * the layout engine asked for.
 *
 * Checks
 *   B1  no console errors / no failed requests
 *   B2  lines rendered, count matches the model
 *   B3  every non-final line fills its measure (DOM error <= 1px)
 *   B4  no line-start prohibition violation (DOM, per line)
 *   B5  no line overflows its measure
 *   B6  text preserved exactly
 *   B7  text contrast >= 4.5:1
 *   B8  negative control: violations appear with the rules off and vanish with them on
 *   B9  screenshot is not blank
 *   B10 pixel level: each line's ink agrees with its DOM box right edge
 *   B11 the browser panel can be measured the same way (control is non-empty)
 *   B12 line count: hanjustify uses no more lines than browser-native wrapping
 *
 * Usage: node scripts/verify-demo.mjs [--url http://...] [--out shots/verify] [--debug]
 */
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { decodePng, stats, bandInkRight } from './png-stats.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const argVal = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const debug = argv.includes('--debug');
const outDir = join(root, argVal('--out') ?? 'shots/verify');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

function findBrowser() {
  const candidates = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error('no Edge/Chrome found; pass --url to point at an instance running elsewhere');
}

async function serve(dir) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let p = normalize(decodeURIComponent(url.pathname));
      if (p === '/' || p === '\\') p = '/index.html';
      const file = join(dir, p.replace(/^[\\/]+/, ''));
      if (!file.startsWith(dir)) { res.writeHead(403).end('forbidden'); return; }
      const buf = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }).end(buf);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

/* ---------------- minimal CDP client over the built-in WebSocket ---------- */

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} ${JSON.stringify(msg.error.data ?? '')}`));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP ${method} timeout`)); }
      }, 30000);
    });
  }
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket connect failed')), { once: true });
  });
  return new Cdp(ws);
}

async function waitForHttp(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error(`CDP endpoint not ready: ${url}`);
}

/* ---------------- page probes ---------------- */

const PROBE_LINES = `(() => {
  const FORBIDDEN = /^[\uFF0C\u3002\u3001\uFF1B\uFF1A\uFF1F\uFF01\uFF09\u300B\u300D\u300F\u201D\u2019\u00B7\u2026\u2014%]/;
  const rows = [...document.querySelectorAll('.hj-line')];
  const lines = rows.map(r => ({
    text: r.textContent,
    width: r.getBoundingClientRect().width,
    target: Number(r.dataset.target),
    final: r.dataset.final === '1',
    ragged: r.dataset.ragged === '1',
  }));
  return {
    lineCount: lines.length,
    lines,
    forbiddenStart: lines.filter(l => FORBIDDEN.test([...l.text][0] ?? '')).length,
    maxWidthError: lines.filter(l => !l.final).reduce((m, l) => Math.max(m, Math.abs(l.width - l.target)), 0),
    overflowRows: lines.filter(l => l.width > l.target + 1).length,
  };
})()`;

const PROBE_COLOURS = `(() => {
  const parse = c => { const m = c.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; return m[1].split(',').map(Number).slice(0, 3); };
  const lum = rgb => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]); };
  const ratio = (a, b) => { const la = lum(a), lb = lum(b); const hi = Math.max(la, lb), lo = Math.min(la, lb); return (hi + 0.05) / (lo + 0.05); };
  const bg = parse(getComputedStyle(document.body).backgroundColor) ?? [255, 255, 255];
  const out = {};
  for (const [name, sel] of [['body', 'body'], ['hint', '.panel .hint'], ['accent', 'h1 .tag'], ['verdict', '.verdict'], ['mono', 'td.num']]) {
    const node = document.querySelector(sel);
    if (!node) continue;
    const fg = parse(getComputedStyle(node).color);
    if (fg) out[name] = +ratio(fg, bg).toFixed(2);
  }
  return out;
})()`;

const PROBE_BROWSER_LINES = `(() => {
  const FORBIDDEN = /^[\uFF0C\u3002\u3001\uFF1B\uFF1A\uFF1F\uFF01\uFF09\u300B\u300D\u300F\u201D\u2019\u00B7\u2026\u2014%]/;
  const host = document.getElementById('browserStage').firstElementChild;
  const saved = host.textContent;
  host.textContent = '';
  const nodes = [];
  for (const ch of [...saved]) {
    const sp = document.createElement('span');
    sp.textContent = ch === ' ' ? '\\u00a0' : ch;
    host.appendChild(sp);
    nodes.push({ ch, el: sp });
  }
  const lines = [];
  let lastTop = null, cur = '';
  for (const n of nodes) {
    const top = n.el.getBoundingClientRect().top;
    if (lastTop === null || Math.abs(top - lastTop) < 1.5) cur += n.ch;
    else { lines.push(cur); cur = n.ch; }
    lastTop = top;
  }
  if (cur) lines.push(cur);
  host.textContent = saved;
  return { lines, violations: lines.filter(l => FORBIDDEN.test([...l][0] ?? '')).length };
})()`;

/* ---------------- main ---------------- */

const checks = [];
const add = (id, name, ok, detail) => checks.push({ id, name, ok: !!ok, detail });

async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    throw new Error(`in-page exception: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`);
  }
  return r.result.value;
}

async function main() {
  const explicitUrl = argVal('--url');
  let server = null;
  let origin = explicitUrl;
  if (!origin) {
    const s = await serve(join(root, 'demo'));
    server = s.server;
    origin = s.origin;
  }

  const exe = findBrowser();
  const port = 9333 + (process.pid % 200);
  const child = spawn(exe, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${join(root, '.probe-browser')}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-gpu',
    '--window-size=1280,1200',
    'about:blank',
  ], { stdio: 'ignore' });

  try {
    await waitForHttp(`http://127.0.0.1:${port}/json/version`);
    const targets = await waitForHttp(`http://127.0.0.1:${port}/json/list`);
    const page = targets.find(t => t.type === 'page');
    if (!page) throw new Error('no page target available');

    const cdp = await connect(page.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Log.enable');
    await cdp.send('Network.enable');

    const url = `${origin}/index.html`;
    await cdp.send('Page.navigate', { url });
    await sleep(1200);

    let report = null;
    for (let i = 0; i < 40; i++) {
      report = await evaluate(cdp, 'window.__HJ_REPORT ? JSON.parse(JSON.stringify(window.__HJ_REPORT)) : null');
      if (report) break;
      await sleep(250);
    }
    if (!report) {
      const diag = cdp.events
        .filter(e => ['Runtime.exceptionThrown', 'Log.entryAdded', 'Network.loadingFailed'].includes(e.method))
        .map(e => e.method === 'Runtime.exceptionThrown'
          ? `EXCEPTION ${e.params.exceptionDetails?.exception?.description ?? e.params.exceptionDetails?.text}`
          : e.method === 'Log.entryAdded'
            ? `LOG[${e.params.entry.level}] ${e.params.entry.text}`
            : `NETFAIL ${e.params.errorText}`);
      throw new Error(`page never published __HJ_REPORT.\n${diag.join('\n') || '(no events)'}`);
    }

    const consoleErrors = cdp.events
      .filter(e => e.method === 'Runtime.exceptionThrown'
        || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
      .map(e => e.method === 'Runtime.exceptionThrown'
        ? (e.params.exceptionDetails?.exception?.description ?? e.params.exceptionDetails?.text)
        : e.params.entry.text);
    const failedRequests = cdp.events.filter(e => e.method === 'Network.loadingFailed').map(e => e.params.errorText);

    const dom = await evaluate(cdp, PROBE_LINES);
    const colours = await evaluate(cdp, PROBE_COLOURS);
    const source = await evaluate(cdp, 'document.getElementById("text").value');
    const title = await evaluate(cdp, 'document.title');

    add('B1', 'no console errors / no failed requests', consoleErrors.length === 0 && failedRequests.length === 0,
      consoleErrors.length === 0 && failedRequests.length === 0
        ? 'clean load and script execution'
        : `errors: ${[...consoleErrors, ...failedRequests].join(' | ').slice(0, 400)}`);

    add('B2', 'lines rendered, count matches the model',
      dom.lineCount > 0 && dom.lineCount === report.lines.length,
      `DOM ${dom.lineCount} lines / model ${report.lines.length} lines`);

    add('B3', 'every non-final line fills its measure (<=1px)',
      dom.maxWidthError <= 1, `max error ${dom.maxWidthError.toFixed(3)}px`);

    add('B4', 'no line-start prohibition violation', dom.forbiddenStart === 0,
      dom.forbiddenStart === 0 ? 'per-line DOM check passed' : `${dom.forbiddenStart} lines open with a forbidden glyph`);

    add('B5', 'no line overflows its measure', dom.overflowRows === 0, `${dom.overflowRows} overflowing lines`);

    const joined = dom.lines.map(l => l.text).join('').replace(/\s+/g, '');
    const srcSqueezed = String(source).replace(/\s+/g, '');
    add('B6', 'text preserved exactly', joined === srcSqueezed,
      joined === srcSqueezed ? `${joined.length} characters identical` : `DOM ${joined.length} vs source ${srcSqueezed.length}`);

    const badContrast = Object.entries(colours).filter(([, v]) => v < 4.5);
    add('B7', 'text contrast >= 4.5:1', badContrast.length === 0,
      Object.entries(colours).map(([k, v]) => `${k}=${v}`).join(' '));

    // --- B8: self-calibrated negative control ---
    //
    // The proof that the rule layer does something is that a line really can open
    // with the em dash once the rules are off, and that only happens when the prefix
    // fills the measure *exactly*: then breaking before the dash is the
    // zero-badness choice. The prefix length is derived from the browser's own
    // advance width, so the control survives a font or size change.
    const calib = await evaluate(cdp, `(() => {
      const size = Number(document.getElementById('size').value);
      const stack = '"Noto Sans SC", "Microsoft YaHei", "Source Han Sans SC", sans-serif';
      const ctx = document.createElement('canvas').getContext('2d');
      ctx.font = size + 'px ' + stack;
      return { size, adv: ctx.measureText('\\u7532').width };
    })()`);
    const prefixCount = 12;
    const calibratedWidth = Math.round(calib.adv * prefixCount);
    const controlText = '\u7532'.repeat(prefixCount) + '\u2014\u2014' + '\u4e59'.repeat(15);

    await evaluate(cdp, `(() => {
      document.getElementById('kinsoku').checked = false;
      document.getElementById('width').value = ${calibratedWidth};
      document.getElementById('text').value = ${JSON.stringify(controlText)};
      document.getElementById('width').dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(400);
    const off = await evaluate(cdp, PROBE_LINES);

    await evaluate(cdp, `(() => {
      const k = document.getElementById('kinsoku');
      k.checked = true;
      k.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(400);
    const on = await evaluate(cdp, PROBE_LINES);

    add('B8', 'negative control: violation appears with rules off, gone with rules on',
      off.forbiddenStart > 0 && on.forbiddenStart === 0,
      `width ${calibratedWidth}px (= ${prefixCount} x ${calib.adv.toFixed(2)}px per Han): `
      + `rules off ${off.forbiddenStart}/${off.lineCount} lines open with a dash, rules on ${on.forbiddenStart}/${on.lineCount}`);

    // --- B9-B12: reset to a representative state, capture, cross-check pixels ---
    await evaluate(cdp, `(() => {
      document.getElementById('kinsoku').checked = true;
      const s = document.getElementById('sample');
      s.value = 'zh-kinsoku';
      s.dispatchEvent(new Event('change', { bubbles: true }));
      const w = document.getElementById('width');
      w.value = 420;
      w.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(700);

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const shotBuf = Buffer.from(shot.data, 'base64');
    await mkdir(outDir, { recursive: true });
    const shotPath = join(outDir, 'demo.png');
    await writeFile(shotPath, shotBuf);

    const geom = await evaluate(cdp, `(() => {
      const rects = [...document.querySelectorAll('.hj-line')].map(n => {
        const b = n.getBoundingClientRect();
        return { x: b.x, y: b.y, w: b.width, h: b.height, text: n.textContent };
      });
      return { dpr: window.devicePixelRatio || 1, lines: rects, fontSize: Number(document.getElementById('size').value) };
    })()`);

    const img = decodePng(shotBuf);
    const overall = stats(img, { grid: [6, 4] });
    const dpr = geom.dpr;
    const em = geom.fontSize * dpr;

    /**
     * Expected ink inset for the last glyph of a line, as a fraction of the em.
     *
     * A line's ink does not reach its box's right edge even when the setting is
     * perfect, because the trailing glyph's ink sits inside its advance box:
     *   - a Han glyph fills most of its em            -> ~0.05em inset
     *   - a fullwidth stop mark's ink sits at the left
     *     of its em (clreq §5.1.1.1, 大陆式点号位于字面左下角) -> ~0.5em inset
     *   - a closing quote / bracket is likewise inset
     * Treating these as "not justified" would make the check fail on correct output,
     * so the tolerance is derived per line from its final character.
     */
    const INSET_PUNCT = /[\uFF0C\u3002\u3001\uFF1B\uFF1A\uFF1F\uFF01\uFF09\u300B\u300D\u300F\u201D\u2019\u2014\u2026]/;
    const insetFractionFor = ch => (INSET_PUNCT.test(ch ?? '') ? 0.6 : 0.15);

    const perLine = geom.lines.map(l => {
      // Inset 1px on the right so a neighbouring border is never read as ink.
      const rect = { x: l.x * dpr, y: l.y * dpr, w: Math.max(1, l.w * dpr - 1), h: l.h * dpr };
      const band = bandInkRight(img, rect);
      const domRight = Math.round((l.x + l.w) * dpr);
      const lastChar = [...l.text].pop() ?? '';
      return {
        text: l.text,
        lastChar,
        domRight,
        inkRight: band.right,
        delta: band.right >= 0 ? domRight - band.right : null,
        // The final line is set at its natural width by design and is excluded.
        isFinal: geom.lines.indexOf(l) === geom.lines.length - 1,
        allowedInset: em * insetFractionFor(lastChar) + 2,
      };
    });
    const painted = perLine.filter(l => l.inkRight >= 0);
    const bodyLines = perLine.filter(l => !l.isFinal && l.inkRight >= 0);
    // No ink may extend past the box, on any line including the last.
    const maxOvershoot = painted.length ? Math.max(0, ...painted.map(l => -l.delta)) : 0;
    const shortLines = bodyLines.filter(l => l.delta > l.allowedInset);

    if (debug) {
      console.log('DEBUG geom =', JSON.stringify(geom));
      console.log('DEBUG perLine =', JSON.stringify(perLine));
      console.log('DEBUG overall =', JSON.stringify({ bg: overall.backgroundRgb, ink: overall.inkPercent, bar: overall.scrollbarWidth }));
    }

    add('B9', 'screenshot is not blank',
      shotBuf.length > 12000 && overall.uniqueColours > 200 && overall.inkPercent > 0.5 && overall.inkPercent < 45,
      `${(shotBuf.length / 1024).toFixed(1)} KiB, ${overall.width}x${overall.height}, ${overall.uniqueColours} colours, `
      + `ink ${overall.inkPercent}%, background rgb=${JSON.stringify(overall.backgroundRgb)} (scrollbar ${overall.scrollbarWidth}px)`
      + ` -> ${shotPath}`);

    add('B10', 'pixel level: each line ink matches its DOM box right edge',
      painted.length === geom.lines.length && maxOvershoot <= 2 && shortLines.length === 0,
      `${geom.lines.length} lines (${bodyLines.length} body): overshoot at most ${maxOvershoot}px (expect <=2); `
      + `${shortLines.length} body lines stop short of their box beyond the glyph inset`
      + (shortLines.length
        ? ` -> ${shortLines.map(l => JSON.stringify(l.text.slice(-6)) + ' off by ' + l.delta + 'px (allowed ' + l.allowedInset.toFixed(1) + ')').join(' ') }`
        : '')
      + `; per-line delta/allowance ${JSON.stringify(painted.map(l => [l.delta, Math.round(l.allowedInset)]))}`);

    let browserProbe = { lines: [], violations: 0 };
    try {
      browserProbe = await evaluate(cdp, PROBE_BROWSER_LINES);
    } catch (err) {
      browserProbe = { lines: [], violations: 0, error: err.message };
    }

    add('B11', 'browser panel measurable the same way (control is non-empty)',
      browserProbe.lines.length > 0,
      `${browserProbe.lines.length} lines via the per-character DOM probe, line-start violations ${browserProbe.violations}`
      + (browserProbe.error ? ` (probe error: ${browserProbe.error})` : ''));

    add('B12', 'line count: hanjustify uses no more lines than browser-native',
      geom.lines.length <= browserProbe.lines.length,
      `hanjustify ${geom.lines.length} lines vs browser-native ${browserProbe.lines.length}`);

    const failed = checks.filter(c => !c.ok);
    console.log(`\n浏览器验收 — ${url}`);
    console.log(`标题: ${title}\n`);
    for (const c of checks) console.log(`  ${c.ok ? 'OK  ' : 'FAIL'} ${c.id} ${c.name.padEnd(56)} ${c.detail}`);
    console.log('');
    console.log(`模型侧: ${report.stats.lineCount} 行 · 首禁违规 ${report.stats.kinsokuLineStartViolations}`
      + ` · 溢出 ${report.stats.overfullLines} · ragged ${report.stats.raggedLines}`
      + ` · 边界最大均摊空隙 ${report.stats.maxAddedPerBoundaryEm.toFixed(3)}em`);
    console.log(`浏览器侧: ${browserProbe.lines.length} 行 · 行首禁则违规 ${browserProbe.violations}`);
    console.log('');
    console.log(failed.length === 0 ? `全部 ${checks.length} 项浏览器验收通过。` : `${failed.length}/${checks.length} 项失败。`);
    return failed.length === 0 ? 0 : 2;
  } finally {
    child.kill();
    if (server) server.close();
  }
}

main().then(code => process.exit(code)).catch(err => {
  console.error('验收脚本失败:', err?.stack || err);
  process.exit(1);
});
