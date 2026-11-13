#!/usr/bin/env node
/* sw.js の VERSION と FILES（オフライン用に保存するファイル一覧）を生成する。
   使い方:
     node tools/build-sw.mjs          sw.js を書き換える（配信前に必ず実行）
     node tools/build-sw.mjs --check  sw.js が最新か確認するだけ（古ければ終了コード1） */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const ENTRIES = ['index.html', 'app.js', 'style.css', 'manifest.webmanifest', 'icons', 'vendor'];

function walk(p) {
  const abs = join(root, p);
  if (!statSync(abs).isDirectory()) return [p];
  return readdirSync(abs).filter(n => !n.startsWith('.')).sort().flatMap(n => walk(join(p, n)));
}
const files = ENTRIES.flatMap(walk).map(p => p.split(sep).join('/'));

// 全ファイルの内容から版を決める。どれか1つでも変われば VERSION が変わる
const h = createHash('sha256');
for (const f of files) h.update(f + '\0').update(readFileSync(join(root, f))).update('\0');
const version = h.digest('hex').slice(0, 12);

// index.html はページ遷移の応答として './' で保存する（sw.js の SHELL）
const list = files.map(f => (f === 'index.html' ? './' : f));
const block = `// @@BUILD_START\nconst VERSION = '${version}';\nconst FILES = ${JSON.stringify(list, null, 1).replace(/\n /g, '\n  ')};\n// @@BUILD_END`;

const swPath = join(root, 'sw.js');
const src = readFileSync(swPath, 'utf8');
const re = /\/\/ @@BUILD_START[\s\S]*?\/\/ @@BUILD_END/;
if (!re.test(src)) { console.error('sw.js に @@BUILD_START / @@BUILD_END がありません'); process.exit(1); }
const next = src.replace(re, block);

if (process.argv.includes('--check')) {
  if (next !== src) { console.error('sw.js が古くなっています。node tools/build-sw.mjs を実行してください'); process.exit(1); }
  console.log(`sw.js は最新です (VERSION ${version}, ${files.length} files)`);
} else {
  writeFileSync(swPath, next);
  console.log(`sw.js を更新しました (VERSION ${version}, ${files.length} files, ${relative(process.cwd(), swPath)})`);
}
