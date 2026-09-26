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

const hashes = {};
await mkdir(DEST, { recursive: true });
for (const f of FILES) {
  const body = await readFile(join(SRC, f));
  await writeFile(join(DEST, f), body);
  hashes[f] = createHash('sha256').update(body).digest('hex').slice(0, 16);
  process.stdout.write(`${f.padEnd(28)} ${body.length} bytes  sha256:${hashes[f]}\n`);
}
await writeFile(join(DEST, 'ENGINE_SHA.json'), JSON.stringify(hashes, null, 2) + '\n', 'utf8');
process.stdout.write(`\nsynced from ${SRC}\n`);
