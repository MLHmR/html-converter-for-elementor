/**
 * Playwright driver for the conversion engine.
 *
 * ⚠ 为什么必须用真实浏览器，而不是 jsdom：
 *   引擎里 getBoundingClientRect 用了 43 处、getComputedStyle 14 处。
 *   jsdom **不做布局** —— getBoundingClientRect 恒返回 0，getComputedStyle 也拿不到
 *   层叠解析后的值。用 jsdom 跑出来的不是「差一点」，是整体错的（宽度、对齐、
 *   分割线识别、响应式测量全部失效）。引擎的前提就是「读浏览器真正画出来的值」，
 *   换掉浏览器等于换掉前提。
 *
 * ⚠ 为什么起本地 HTTP 服务而不是 file://：
 *   引擎是 ES 模块，且内部用动态 import 拉 elementor-components.js。
 *   Chromium 对 file:// 下的模块 import 走 CORS 拦截，必然失败。
 *   起一个只绑 127.0.0.1、随机端口的临时服务最省事，也不触网。
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE_DIR = join(HERE, 'engine');

const HOST_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>hte-cli host</title>
<style>html,body{margin:0}#compute-frame{position:absolute;left:-10000px;top:0;width:1440px;height:900px;border:0}</style>
</head><body>
<iframe id="compute-frame" title="compute"></iframe>
</body></html>`;

const MIME = { '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8' };

/** 起一个只服务引擎目录的临时本地服务。 */
async function startEngineServer() {
  const server = createServer(async (req, res) => {
    try {
      const path = (req.url || '/').split('?')[0];
      if (path === '/' || path === '/host.html') {
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(HOST_HTML);
        return;
      }
      // 只允许读引擎目录下的 .js —— 这个服务虽然只绑 127.0.0.1，
      // 也不该因为 ../ 就把整个磁盘暴露出去。
      const name = path.replace(/^\/+/, '');
      if (!/^[a-zA-Z0-9._-]+\.js$/.test(name)) {
        res.writeHead(404).end('not found');
        return;
      }
      const body = await readFile(join(ENGINE_DIR, name));
      res.writeHead(200, { 'Content-Type': MIME[extname(name)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, origin: `http://127.0.0.1:${port}` };
}

/** 引擎默认选项（与网站 assets/js/library-options.js 保持一致）。 */
export function defaultOptions(overrides = {}) {
  return {
    mode: 'native',
    nativeStrategy: 'full',
    targetComponents: 'all',
    title: 'Converted page',
    stripScripts: true,
    keepStyles: true,
    optimizeImages: true,
    headingMode: 'semantic',
    headingTopLevel: 1,
    imageMode: 'placeholder',
    assetUrlMode: 'safe',
    assetBaseUrl: '',
    iconMode: 'svg',
    colorMode: 'preserve',
    fontMode: 'preserve',
    ...overrides,
  };
}

/**
 * 把若干份 HTML 转成 Elementor 数据。
 *
 * 串行执行：引擎依赖页面上那个唯一的 #compute-frame 读计算样式，
 * 并行会互相覆盖 —— 这一点和网站端的批量转换是同一个约束。
 *
 * @param {Array<{name: string, html: string}>} inputs
 * @param {object} options 引擎选项
 * @param {object} deps    { chromium, onProgress }
 * @returns {Promise<Array<{name, clipboard, template, stats, warnings, error}>>}
 */
export async function convertAll(inputs, options, { chromium, onProgress = () => {}, allowRemote = true } = {}) {
  const { server, origin } = await startEngineServer();
  const contacted = new Set();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

    // ⚠ 审计实测（audit/netprobe.mjs）：清洗器会在渲染前剥掉外链样式表、@font-face、
    //   CSS url()、iframe 和脚本，但 <img src="https://…"> 是**保留**的 —— 远程图片
    //   URL 本来就是推荐用法（媒体库地址能直接带过去）。代价是渲染时 Chromium 会
    //   真的去拉那张图，也就是「你在转换哪个页面」这件事会被那个域名看见。
    //
    //   默认放行（与网站行为一致，也保证图片尺寸测得准）；但必须让用户知道，
    //   所以这里记录所有外发域名，由 CLI 打印出来。
    //   --no-remote 则整个掐断，适合改客户站或离线环境。
    // ⚠ 报告用 page.on('request')，**不要**用 page.route()。
    //   实测（audit/dbg3.mjs）：引擎把 HTML 灌进 iframe 用的是 `frame.srcdoc = html`
    //   （converter.js:2445），这类子框架发出的子资源请求既不触发 page.route，
    //   也不触发 context.route —— 两者都只拦到 host.html / converter.js /
    //   elementor-components.js 三条本地请求，而 page.on('request') 看得一清二楚。
    //   先前那版基于 route 的 --no-remote 是个**假开关**：既不报告也拦不住。
    page.on('request', (req) => {
      const url = req.url();
      if (url.startsWith(origin) || url.startsWith('about:') || url.startsWith('data:') || url.startsWith('blob:')) return;
      try { contacted.add(new URL(url).host); } catch { /* 非标准 URL 忽略 */ }
    });

    await page.goto(`${origin}/host.html`, { waitUntil: 'load' });

    // 引擎里的动态 import 会读 window.HTE_BOOT.ver 拼版本号；不设就是空串，
    // 解析成同目录的 ./elementor-components.js，正是我们要的。
    await page.evaluate(async (base) => {
      window.__hteEngine = await import(`${base}/converter.js`);
    }, origin);

    const results = [];
    for (let i = 0; i < inputs.length; i++) {
      const item = inputs[i];
      onProgress(i, inputs.length, item.name);
      try {
        const out = await page.evaluate(async ({ html, opts, block }) => {
          // --no-remote：在 DOM 层把远程子资源地址摘掉，而不是指望浏览器拦截。
          // 这样是确定性的 —— 地址根本不存在，就不可能被请求。
          let source = html;
          if (block) {
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const remote = (v) => /^(https?:)?\/\//i.test(String(v || '').trim());
            doc.querySelectorAll('img, source, video, audio, track, embed').forEach((el) => {
              for (const attr of ['src', 'srcset', 'poster', 'data-src', 'data-srcset']) {
                if (el.hasAttribute(attr) && remote(el.getAttribute(attr))) el.removeAttribute(attr);
              }
            });
            source = '<!doctype html>' + doc.documentElement.outerHTML;
          }
          const frame = document.getElementById('compute-frame');
          const r = await window.__hteEngine.convertHtml(source, opts, frame);
          // 只回传可序列化的部分：safeHtml / structureHtml 是大段字符串，
          // CLI 用不到，带回来只会拖慢 IPC。
          return {
            clipboard: r.clipboard,
            template: r.template,
            stats: r.stats,
            warnings: r.warnings,
          };
        }, { html: item.html, opts: { ...options, title: options.title || item.name }, block: !allowRemote });
        results.push({ name: item.name, ...out });
      } catch (error) {
        results.push({ name: item.name, error: String(error && error.message ? error.message : error) });
      }
    }
    onProgress(inputs.length, inputs.length, null);
    // 外发域名随结果一起回传，由调用方决定怎么呈现 —— 不打印就等于没发生过。
    results.contactedHosts = [...contacted].sort();
    return results;
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.close();
  }
}
