#!/usr/bin/env node
/**
 * html-converter-for-elementor — 命令行版。
 *
 * 用法：
 *   npx html-converter-for-elementor page.html                 → page.json
 *   npx html-converter-for-elementor src/*.html -o out/        → 每个文件一个 .json
 *   npx html-converter-for-elementor page.html --clipboard     → 输出可直接粘贴的 Elementor 数据
 *
 * 设计原则和网站一致：不上传、不需要账号、没有次数限制。
 * 这里唯一的网络行为是在 127.0.0.1 上起一个临时服务给本地浏览器加载引擎。
 */
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { convertAll, defaultOptions } from '../src/convert.js';

const require = createRequire(import.meta.url);

const HELP = `
html-converter-for-elementor — turn HTML into native, editable Elementor templates.

  html-converter-for-elementor <file...> [options]

Options
  -o, --out <path>      Output file or directory (default: alongside the input)
      --clipboard       Write Elementor paste data instead of a JSON template
      --mode <m>        native | fidelity            (default: native)
      --icons <m>       svg | elementor              (default: svg)
      --images <m>      placeholder | preserve       (default: placeholder)
      --colors <m>      preserve | site              (default: preserve)
      --fonts <m>       preserve | site              (default: preserve)
      --title <t>       Template title (default: the file name)
      --no-remote       Block every request to a remote host while rendering
      --quiet           Only print errors
  -h, --help            Show this help
  -v, --version         Show the version

The conversion itself runs on this machine and your HTML is never uploaded.
One caveat, stated plainly: remote <img src> URLs are kept on purpose, so while
rendering the page the browser does fetch those images — the hosts contacted are
listed after each run. Use --no-remote to block them (image sizing may then be
estimated from the markup rather than measured).

Icons: choose "elementor" to map icon-font classes and ✓-style characters onto
the Elementor icon library (needed for Icon List / Icon Box output).
`;

function parseArgs(argv) {
  const files = [];
  const opts = { out: '', clipboard: false, quiet: false, noRemote: false };
  const want = {
    '--out': 'out', '-o': 'out', '--mode': 'mode', '--icons': 'icons',
    '--images': 'images', '--colors': 'colors', '--fonts': 'fonts', '--title': 'title',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return { help: true };
    if (a === '-v' || a === '--version') return { version: true };
    if (a === '--clipboard') { opts.clipboard = true; continue; }
    if (a === '--quiet') { opts.quiet = true; continue; }
    if (a === '--no-remote') { opts.noRemote = true; continue; }
    if (want[a]) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      opts[want[a]] = v;
      continue;
    }
    if (a.startsWith('-')) throw new Error(`Unknown option: ${a}`);
    files.push(a);
  }
  return { files, opts };
}

/** playwright-core 不自带浏览器；说清楚怎么装，别让用户对着栈回溯猜。 */
function loadChromium() {
  try {
    return require('playwright-core').chromium;
  } catch {
    throw new Error(
      'playwright-core is not installed.\n' +
      '  npm i -g playwright-core && npx playwright install chromium'
    );
  }
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) { process.stdout.write(HELP); return; }
  if (parsed.version) {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    process.stdout.write(pkg.version + '\n');
    return;
  }
  const { files, opts } = parsed;
  if (!files.length) { process.stdout.write(HELP); process.exitCode = 1; return; }

  const inputs = [];
  for (const f of files) {
    const html = await readFile(f, 'utf8');
    inputs.push({ name: basename(f, extname(f)), html, source: f });
  }

  const options = defaultOptions({
    mode: opts.mode || 'native',
    iconMode: opts.icons || 'svg',
    imageMode: opts.images || 'placeholder',
    colorMode: opts.colors || 'preserve',
    fontMode: opts.fonts || 'preserve',
    title: opts.title || '',
  });

  // 输出目标是目录还是单文件：多个输入时必须是目录，否则会互相覆盖。
  let outDir = '';
  let outFile = '';
  if (opts.out) {
    let isDir = opts.out.endsWith('/') || opts.out.endsWith('\\');
    if (!isDir) {
      try { isDir = (await stat(opts.out)).isDirectory(); } catch { isDir = extname(opts.out) === ''; }
    }
    if (isDir) outDir = opts.out; else outFile = opts.out;
  }
  if (outFile && inputs.length > 1) {
    throw new Error('-o points at a single file but several inputs were given; pass a directory instead.');
  }
  if (outDir) await mkdir(outDir, { recursive: true });

  const chromium = loadChromium();
  const log = (m) => { if (!opts.quiet) process.stderr.write(m + '\n'); };

  const results = await convertAll(inputs, options, {
    chromium,
    allowRemote: !opts.noRemote,
    onProgress: (done, total, name) => {
      if (name) log(`[${done + 1}/${total}] ${name}`);
    },
  });

  let failed = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.error) {
      failed++;
      process.stderr.write(`FAILED ${r.name}: ${r.error}\n`);
      continue;
    }
    const payload = opts.clipboard ? r.clipboard : r.template;
    const json = JSON.stringify(payload, null, 2);
    const target = outFile
      ? outFile
      : join(outDir || resolve(inputs[i].source, '..'), `${r.name}.json`);
    await writeFile(target, json, 'utf8');
    // stats 的键来自引擎的 countTree()：elements / widgets / containers / maxDepth。
    // 没有 depth 这个键 —— 写错了不会报错，只会打印 "depth undefined"。
    log(`  -> ${target}  (${r.stats.elements} elements: ${r.stats.widgets} widgets, ${r.stats.containers} containers, max depth ${r.stats.maxDepth})`);
    for (const w of r.warnings || []) {
      log(`     note: ${w.message || w.code || w}`);
    }
  }
  // 外发域名一定要报出来。默认放行远程图片是个有意的取舍，
  // 但不告诉用户就成了「悄悄联网」——那正是这个工具批评竞品的地方。
  const hosts = results.contactedHosts || [];
  if (hosts.length) {
    const verb = opts.noRemote ? 'blocked requests to' : 'contacted';
    process.stderr.write(`\n${verb} ${hosts.length} remote host${hosts.length > 1 ? 's' : ''} while rendering: ${hosts.join(', ')}\n`);
    if (!opts.noRemote) process.stderr.write('pass --no-remote to block them\n');
  } else if (!opts.quiet) {
    log('\nno remote host was contacted');
  }
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(String(err && err.message ? err.message : err) + '\n');
  process.exitCode = 1;
});
