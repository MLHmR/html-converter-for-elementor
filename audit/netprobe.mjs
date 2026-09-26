/**
 * 审计探针：转换过程中 Chromium 究竟向哪些地址发了请求。
 *
 * 这条必须实测，不能推理。README 里写了「Your HTML never leaves it」，
 * 如果引擎在渲染阶段把用户 HTML 里引用的外部资源拉了一遍，
 * 那么用户的 HTML 内容（至少是它引用了什么）确实泄漏给了第三方，
 * 这句承诺就要么改掉、要么用代码兜住。
 */
import { chromium } from 'playwright-core';
import { readFile } from 'node:fs/promises';
import { convertAll, defaultOptions } from '../src/convert.js';

const html = await readFile('C:/tmp/hte-audit/external-refs.html', 'utf8');

// 包一层 chromium：把每个 newPage 都挂上请求监听。
const wrapped = {
  launch: async (opts) => {
    const browser = await chromium.launch(opts);
    const origNewPage = browser.newPage.bind(browser);
    browser.newPage = async (o) => {
      const page = await origNewPage(o);
      page.on('request', (req) => {
        const u = req.url();
        if (!u.startsWith('http://127.0.0.1') && !u.startsWith('about:') && !u.startsWith('data:')) {
          console.log(`  OUTBOUND  ${req.resourceType().padEnd(11)} ${u.slice(0, 110)}`);
          globalThis.__outbound = (globalThis.__outbound || 0) + 1;
        }
      });
      page.on('requestfailed', (req) => {
        const u = req.url();
        if (!u.startsWith('http://127.0.0.1')) {
          console.log(`  (failed)  ${req.resourceType().padEnd(11)} ${u.slice(0, 90)}`);
        }
      });
      return page;
    };
    return browser;
  },
};

console.log('--- converting a page that references 5 external origins ---');
const res = await convertAll([{ name: 'probe', html }], defaultOptions(), { chromium: wrapped });
console.log('');
console.log('outbound requests observed:', globalThis.__outbound || 0);
const r = res[0];
if (r.error) {
  console.log('conversion FAILED:', r.error);
} else {
  console.log('elements:', r.stats.elements);
  const json = JSON.stringify(r.template);
  console.log('external URLs still present in output:',
    (json.match(/https?:\\?\/\\?\/(?!127\.0\.0\.1)/g) || []).length);
  for (const w of r.warnings || []) console.log('  note:', w.message || w.code);
}
