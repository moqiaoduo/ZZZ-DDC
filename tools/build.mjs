#!/usr/bin/env node
/**
 * 构建：把 src/ + assets/ 组装成可直接部署的 dist/。
 *
 * 为什么是零依赖手写而不是 Vite / esbuild：
 *   项目没有第三方库要打包，也没有 JSX/TS 要编译。构建真正要做的只有三件事——
 *   拷 HTML、拷 JS（保持 ES module 原样，浏览器自己会 import）、拷图片/CSS。
 *   Vite 会带进约 30MB 的 node_modules，esbuild 约 9MB，为了「一条命令产出 dist/」
 *   付这个代价不划算，也会让「clone 下来就能改」这件事不再成立。
 *
 * 产物形态：
 *   dist/index.html          骨架，<script type="module" src="./src/main.js">
 *   dist/src/main.js         入口
 *   dist/src/{domain,app,ui,data}/    ES module，原样保留目录结构
 *   dist/src/styles/base.css
 *   dist/assets/{characters,costs,site}/

 * 仓库根 index.html 是薄壳（由 tools/split.mjs 生成），它引用 ./src/ 下的模块，
 * 所以 dist/ 里必须保留同样的 src/ 前缀——把 index.html 当成「相对于自己」的
 * 入口来看，dist/ 就是仓库根的镜像，只是少了 legacy/ 与 tools/。
 *
 * 用法：
 *   node tools/build.mjs              构建到 dist/
 *   node tools/build.mjs --out <目录>  换个输出目录
 *   node tools/build.mjs --quiet      少打印
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const OUT = path.resolve(ROOT, argOf('--out', 'dist'));
const QUIET = argv.includes('--quiet') || argv.includes('-q');
const log = (...a) => { if (!QUIET) console.log(...a); };

const SRC = path.join(ROOT, 'src');
const ASSETS = path.join(ROOT, 'assets');

// ── 前置检查 ──────────────────────────────────────────────────────────

if (!fs.existsSync(SRC)) {
  console.error('src/ 不存在。先跑 node tools/split.mjs 从 index.html 生成分层源码。');
  process.exit(1);
}

if (path.resolve(OUT) === path.resolve(ROOT)) {
  console.error('拒绝构建到仓库根：dist 会与源码混在一起，清理时容易误删。');
  process.exit(1);
}
if (path.resolve(OUT) === path.resolve(SRC)) {
  console.error('拒绝构建到 src/：产物会覆盖源码。');
  process.exit(1);
}

// ── 清理 ──────────────────────────────────────────────────────────────

if (fs.existsSync(OUT)) fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// ── 拷贝 ──────────────────────────────────────────────────────────────

let files = 0;
let bytes = 0;

function copyTree(from, to, filter = () => true) {
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (e.isDirectory()) {
      fs.mkdirSync(dst, { recursive: true });
      copyTree(src, dst, filter);
      continue;
    }
    if (!filter(e.name)) continue;
    fs.copyFileSync(src, dst);
    files++;
    bytes += fs.statSync(dst).size;
  }
}

// src/ 里的 .js 与原样资源（index.html、styles/）直接拷；
// 图片不在 src/ 里，统一从仓库根的 assets/ 拷，避免同一张图存两份。
fs.mkdirSync(path.join(OUT, 'src'), { recursive: true });
copyTree(SRC, path.join(OUT, 'src'), (name) => !/\.(png|jpe?g|svg|webp)$/i.test(name));

// 入口 HTML 在仓库根，不在 src/ 里。
const indexHtml = path.join(ROOT, 'index.html');
if (!fs.existsSync(indexHtml)) {
  console.error('index.html 不存在。先跑 node tools/split.mjs 生成骨架。');
  process.exit(1);
}
fs.copyFileSync(indexHtml, path.join(OUT, 'index.html'));
files++;
bytes += fs.statSync(path.join(OUT, 'index.html')).size;

if (fs.existsSync(ASSETS)) {
  fs.mkdirSync(path.join(OUT, 'assets'), { recursive: true });
  copyTree(ASSETS, path.join(OUT, 'assets'));
}

// ── 校验产物自包含 ────────────────────────────────────────────────────
//
// 分层后最容易出的部署事故是「本地看着好，传上去 404」——某个引用指向了
// 仓库根而不是 dist/ 里的相对路径。这里把所有 .html/.js/.css 里出现的
// 本地资源路径抽出来，逐个确认产物里真的有这个文件。

const textFiles = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(html|js|css)$/i.test(e.name)) textFiles.push(p);
  }
})(OUT);

const missing = [];
const checked = new Set();
for (const f of textFiles) {
  const text = fs.readFileSync(f, 'utf8');
  // 只认「相对路径 + 已知资产扩展名」，避免把 URL、data:、import 说明符混进来。
  for (const m of text.matchAll(/["'`(]((?:\.\/|\/)?(?:assets|styles)\/[^"'`()\s]+?\.(?:png|jpe?g|svg|webp|css))["'`)]/gi)) {
    const ref = m[1].replace(/^\.?\//, '');
    if (checked.has(ref)) continue;
    checked.add(ref);
    if (!fs.existsSync(path.join(OUT, ref))) missing.push(`${path.relative(OUT, f)} → ${ref}`);
  }
  // JS 之间的相对 import 也必须落在产物里。
  for (const m of text.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    const ref = m[1];
    const abs = path.resolve(path.dirname(f), ref);
    if (!fs.existsSync(abs)) missing.push(`${path.relative(OUT, f)} → ${ref}`);
  }
}

if (missing.length) {
  console.error(`\n产物不自包含，${missing.length} 处引用找不到文件：`);
  for (const m of missing) console.error('  ' + m);
  process.exit(1);
}

// ── 摘要 ──────────────────────────────────────────────────────────────

log(`构建完成：${path.relative(ROOT, OUT) || '.'}`);
log(`  ${files} 个文件，${(bytes / 1024 / 1024).toFixed(2)} MB`);
log(`  检查了 ${checked.size} 处资源引用、${textFiles.length} 个文本文件，未发现悬空路径`);
