#!/usr/bin/env node
/**
 * 把网站上的引擎同步进 CLI。
 *
 * ⚠ 引擎只有一份真相源：主题里的 assets/js/。CLI 不重写、不改写，只复制。
 *   两边各维护一份的后果是必然分叉，而「CLI 输出和网站一致」正是这个包唯一的卖点。
 *   发版前跑一次，并把 ENGINE_SHA 记进 changelog，出问题能追到具体版本。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEST = join(HERE, '..', 'src', 'engine');
const SRC = process.env.HTE_THEME_JS
  || join(HERE, '..', '..', 'hte-theme', 'assets', 'js');

const FILES = ['converter.js', 'elementor-components.js'];

const toLf = (buf) => Buffer.from(buf.toString('utf8').split(String.fromCharCode(13, 10)).join(String.fromCharCode(10)), 'utf8');

const hashes = {};
await mkdir(DEST, { recursive: true });
for (const f of FILES) {
  // 换行统一成 LF 再落盘、再算哈希：主题文件在 Windows 上可能是 CRLF，而本仓库强制 LF（见 .gitattributes）。
  // 不统一的话，本机算出的哈希是 CRLF 版的，提交后仓库里是 LF 版，CI 一跑就报「打包内容与 ENGINE_SHA.json 不符」。
  const body = toLf(await readFile(join(SRC, f)));
  await writeFile(join(DEST, f), body);
  hashes[f] = createHash('sha256').update(body).digest('hex').slice(0, 16);
  process.stdout.write(`${f.padEnd(28)} ${body.length} bytes  sha256:${hashes[f]}\n`);
}
await writeFile(join(DEST, 'ENGINE_SHA.json'), JSON.stringify(hashes, null, 2) + '\n', 'utf8');
process.stdout.write(`\nsynced from ${SRC}\n`);
