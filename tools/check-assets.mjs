#!/usr/bin/env node
/**
 * 资源引用一致性检查：代码里引用的每一张图都必须真实存在，
 * 磁盘上的每一张图都必须被代码引用（否则就是死资源）。
 *
 * 为什么单独一条：图片是这套站点的内容主体（59 个角色头像 + 5 个固定用途图），
 * 而引用它们的是三种完全不同的写法——
 *   1. src/data/characters.js 里的 `image: "assets/..."`（数据字段）
 *   2. src/app/*.js 里 formatCost(..., 'assets/...') 这类字符串实参
 *   3. index.html 里的 <img src="assets/...">
 * 只查其中一种，改名或删图时另两种会静默 404。实测 404 在页面上表现为
 * 「图裂 + 一个不起眼的 broken image 图标」，很容易在截图里被忽略。
 *
 * 检查项：
 *   A. 引用的文件都存在
 *   B. 磁盘上的图片都被引用（死资源）
 *   C. 引用一律用 `assets/...` 前缀，没有残留的旧中文文件名
 *   D. 文件名只含 [a-z0-9_.-/]（大小写敏感 + 无空格，避免部署到
 *      Linux/Pages 后与 macOS 的大小写不敏感文件系统行为不一致）
 *
 * 用法：
 *   node tools/check-assets.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const ASSET_ROOT = path.join(ROOT, 'assets');
const SRC_DIRS = ['src', 'index.html'];

let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${name}`);
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
};

/** 递归收集要扫描的文本文件。 */
function collectTextFiles() {
  const out = [];
  const walk = (p) => {
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) walk(path.join(p, e.name));
    } else if (/\.(js|mjs|html|css)$/i.test(p)) {
      out.push(p);
    }
  };
  for (const rel of SRC_DIRS) {
    const p = path.join(ROOT, rel);
    if (fs.existsSync(p)) walk(p);
  }
  return out;
}

const REF_RE = /["'`(]\s*(assets\/[A-Za-z0-9_\-./]+\.(?:png|jpg|jpeg|webp|svg))/g;

const files = collectTextFiles();
const referenced = new Map();   // 相对路径 → 引用它的文件列表

for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  for (const m of text.matchAll(REF_RE)) {
    const rel = m[1];
    if (!referenced.has(rel)) referenced.set(rel, []);
    const where = path.relative(ROOT, f);
    if (!referenced.get(rel).includes(where)) referenced.get(rel).push(where);
  }
}

/** 递归收集磁盘上的图片。 */
function collectAssetFiles() {
  const out = new Set();
  const walk = (p) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const abs = path.join(p, e.name);
      if (e.isDirectory()) walk(abs);
      else if (/\.(png|jpg|jpeg|webp|svg)$/i.test(e.name)) out.add(path.relative(ROOT, abs));
    }
  };
  if (fs.existsSync(ASSET_ROOT)) walk(ASSET_ROOT);
  return out;
}

const onDisk = collectAssetFiles();

console.log(`\n扫描 ${files.length} 个文本文件，引用 ${referenced.size} 处、磁盘 ${onDisk.size} 张图`);

// ── A. 引用的都存在 ────────────────────────────────────────────────────
console.log('\nA. 引用的资源都存在');
{
  const missing = [...referenced.keys()].filter((rel) => !onDisk.has(rel));
  check('没有悬空引用', missing.length === 0,
    missing.slice(0, 5).map((m) => `${m}（来自 ${referenced.get(m).join(', ')}）`).join('；'));
}

// ── B. 磁盘上的都被引用 ────────────────────────────────────────────────
console.log('\nB. 磁盘上的图片都被引用');
{
  const dead = [...onDisk].filter((rel) => !referenced.has(rel));
  check('没有死资源', dead.length === 0, dead.slice(0, 5).join('、'));
}

// ── C. 没有残留旧文件名 ────────────────────────────────────────────────
console.log('\nC. 没有残留旧命名');
{
  // 旧命名有两种特征：中文文件名（截图默认名）、以及不带 assets/ 前缀的裸图名。
  const legacyRefs = [];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/["'`(]\s*([^"'`()\s]*\.(?:png|jpg|jpeg))/g)) {
      const v = m[1];
      if (v.startsWith('assets/')) continue;
      if (/^https?:/.test(v)) continue;
      legacyRefs.push(`${path.relative(ROOT, f)} → ${v}`);
    }
  }
  check('所有图片引用都以 assets/ 开头', legacyRefs.length === 0, legacyRefs.slice(0, 5).join('；'));
}

// ── D. 文件名安全 ──────────────────────────────────────────────────────
console.log('\nD. 文件名对部署友好');
{
  const unsafe = [...onDisk].filter((rel) => !/^[A-Za-z0-9_\-./]+$/.test(rel));
  check('文件名只含 [A-Za-z0-9_-./]', unsafe.length === 0, unsafe.slice(0, 5).join('；'));
}

console.log('');
if (fail > 0) {
  console.log(`失败 ${fail} 项`);
  process.exit(1);
}
console.log('全部通过：4 项断言');
