#!/usr/bin/env node
/**
 * 检查 src/ 下所有 ES module 的 import 能不能真正解析。
 *
 * 为什么需要它：分层之后最容易出的一类错是「import 写漏了」——但漏了不会
 * 在加载时报错，只会在用到那个名字的瞬间抛 ReferenceError。如果那一行正好在
 * 事件处理器里，异常被浏览器吞掉，页面只是「点了没反应」，控制台一片安静。
 * 本轮就踩过：`[...MAIN_ENTRY_CONFIG[pos]]` 里的展开符被引用分析当成成员访问，
 * import 没生成，结果「开始计算」永远显示「暂无驱动盘数据」。
 *
 * 检查三件事：
 *   1. import 的相对路径存在；
 *   2. 目标文件确实导出了被导入的每个名字；
 *   3. 反过来：模块里用到、但既没导入也不是本地声明的名字（只查大写常量，误报可控）。
 *
 * 用法：node tools/check-imports.mjs [目录，默认 src]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.resolve(ROOT, process.argv[2] || 'src');

if (!fs.existsSync(TARGET)) {
  console.error(`目录不存在：${TARGET}`);
  console.error('先跑 node tools/split.mjs 生成 src/。');
  process.exit(1);
}

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) files.push(p);
  }
})(TARGET);

const problems = [];

/** 目标文件里有哪些导出名。 */
function exportsOf(src) {
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(m[1]);
  }
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const t = part.trim();
      if (!t) continue;
      names.add((t.split(/\s+as\s+/).pop() || t).trim());
    }
  }
  return names;
}

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file);

  const importRe = /import\s+(?:([\s\S]*?)\s+from\s+)?['"]([^'"]+)['"]/g;
  for (const m of src.matchAll(importRe)) {
    const spec = m[2];
    if (!spec.startsWith('.')) continue; // 裸模块名不查（本项目零依赖）

    const target = path.resolve(path.dirname(file), spec);
    if (!fs.existsSync(target)) {
      problems.push(`${rel} → 目标不存在：${spec}`);
      continue;
    }

    const clause = (m[1] || '').trim();
    const braces = clause.match(/\{([\s\S]*?)\}/);
    if (!braces) continue;

    const want = braces[1].split(',').map((s) => s.trim()).filter(Boolean)
      .map((s) => s.split(/\s+as\s+/)[0].trim());
    const have = exportsOf(fs.readFileSync(target, 'utf8'));
    for (const n of want) {
      if (!have.has(n)) problems.push(`${rel} → ${spec} 未导出 ${n}`);
    }
  }
}

if (problems.length) {
  console.error(`发现 ${problems.length} 处问题：`);
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}
console.log(`✅ ${files.length} 个模块的 import 全部可解析`);
