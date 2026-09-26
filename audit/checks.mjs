/**
 * 发布前审计：本地服务是否可被越权读取、参数解析边界、引擎一致性。
 */
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

let fail = 0;
const ok = (m) => console.log('  ok   ' + m);
const bad = (m) => { console.log('  FAIL ' + m); fail++; };

console.log('--- 1. 本地服务的路径遍历 ---');
{
  // 直接起服务，试着读引擎目录以外的文件。
  const mod = await import('../src/convert.js');
  // startEngineServer 没导出，用 convertAll 起一次拿不到 origin；
  // 改为复制同一段逻辑不可靠。这里换成检查正则本身。
  const src = await readFile(new URL('../src/convert.js', import.meta.url), 'utf8');
  const m = src.match(/if \(!\/\^(.+?)\/\.test\(name\)\)/);
  const guard = m ? m[1] : '';
  const re = new RegExp('^' + guard.replace(/\\\//g, '/'));
  const probes = [
    '../../package.json', '..%2f..%2fpackage.json', 'a/../../secret.js',
    'converter.js', 'elementor-components.js', 'ENGINE_SHA.json', 'x.js.map', 'x.txt',
  ];
  for (const p of probes) {
    const allowed = re.test(p);
    const shouldAllow = p === 'converter.js' || p === 'elementor-components.js';
    if (allowed !== shouldAllow) bad(`guard ${allowed ? 'allows' : 'blocks'} "${p}" (expected ${shouldAllow ? 'allow' : 'block'})`);
  }
  if (!fail) ok('只放行引擎目录下的扁平 .js 文件名，../ 与编码变体全部拒绝');
  void mod;
}

console.log('--- 2. 参数解析边界 ---');
{
  const run = (args) => spawnSync(process.execPath, ['bin/hte.js', ...args], { encoding: 'utf8' });
  let r = run(['--mode']);                       // 缺值
  if (r.status === 1 && /needs a value/.test(r.stderr)) ok('--mode 缺值 → 退出 1 且有明确提示');
  else bad('--mode 缺值处理不当: ' + JSON.stringify({ status: r.status, err: r.stderr.slice(0, 80) }));

  r = run(['--bogus', 'x.html']);                // 未知参数
  if (r.status === 1 && /Unknown option/.test(r.stderr)) ok('未知参数 → 退出 1');
  else bad('未知参数处理不当: ' + JSON.stringify({ status: r.status, err: r.stderr.slice(0, 80) }));

  r = run([]);                                   // 无输入
  if (r.status === 1) ok('无输入 → 退出 1 并打印用法');
  else bad('无输入时退出码为 ' + r.status);

  // 多输入 + 单文件输出：必须拒绝，否则互相覆盖
  await mkdir('audit/tmp', { recursive: true });
  await writeFile('audit/tmp/a.html', '<h1>a</h1>');
  await writeFile('audit/tmp/b.html', '<h1>b</h1>');
  r = run(['audit/tmp/a.html', 'audit/tmp/b.html', '-o', 'audit/tmp/one.json']);
  if (r.status === 1 && /several inputs/.test(r.stderr)) ok('多输入 + 单文件 -o → 拒绝而不是静默覆盖');
  else bad('多输入 + 单文件 -o 未被拒绝: ' + JSON.stringify({ status: r.status, err: r.stderr.slice(0, 120) }));
}

console.log('--- 3. 引擎与主题是否一致 ---');
{
  const shaFile = JSON.parse(await readFile(new URL('../src/engine/ENGINE_SHA.json', import.meta.url), 'utf8'));
  const themeDir = process.env.HTE_THEME_JS
    || join(process.cwd(), '..', 'hte-theme', 'assets', 'js');
  for (const f of Object.keys(shaFile)) {
    const shipped = await readFile(new URL(`../src/engine/${f}`, import.meta.url));
    const shippedSha = createHash('sha256').update(shipped).digest('hex').slice(0, 16);
    if (shippedSha !== shaFile[f]) { bad(`${f}: 打包内容与 ENGINE_SHA.json 不符`); continue; }
    try {
      const theme = await readFile(join(themeDir, f));
      const themeSha = createHash('sha256').update(theme).digest('hex').slice(0, 16);
      if (themeSha !== shippedSha) bad(`${f}: 与主题当前版本不一致（主题 ${themeSha} / 包内 ${shippedSha}）→ 需要 npm run sync-engine`);
      else ok(`${f} 与主题一致 (${shippedSha})`);
    } catch {
      console.log(`  skip ${f}: 找不到主题目录，跳过对比`);
    }
  }
}

console.log('--- 4. npm 包内容 ---');
{
  const r = spawnSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8', shell: true });
  let files = [];
  try { files = (JSON.parse(r.stdout)[0].files || []).map((f) => f.path); } catch { }
  if (!files.length) { bad('npm pack --dry-run 没有解析出文件列表'); }
  else {
    const leaked = files.filter((f) => /^audit\/|node_modules|^\.env|\.log$/.test(f));
    if (leaked.length) bad('发布包里混入了不该有的文件: ' + leaked.join(', '));
    else ok(`${files.length} 个文件，无 audit/ 与 node_modules 泄漏`);
    for (const need of ['bin/hte.js', 'src/convert.js', 'src/engine/converter.js', 'README.md', 'LICENSE']) {
      if (!files.includes(need)) bad('发布包缺少 ' + need);
    }
    if (files.includes('src/engine/elementor-components.js')) ok('引擎两个文件都在包内');
  }
}

console.log('--- 5. bin 入口 ---');
{
  const bin = await readFile(new URL('../bin/hte.js', import.meta.url), 'utf8');
  if (bin.startsWith('#!/usr/bin/env node')) ok('shebang 正确');
  else bad('bin/hte.js 缺少 shebang');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  if (pkg.type === 'module') ok('package.json type=module，与 .js 里的 import 语法一致');
  else bad('type 不是 module，bin 会以 CJS 解析并报错');
}

await rm('audit/tmp', { recursive: true, force: true });
console.log('');
console.log(fail === 0 ? 'AUDIT PASSED' : `AUDIT FAILURES: ${fail}`);
process.exitCode = fail ? 1 : 0;
