#!/usr/bin/env node
/**
 * 旧站存档 → v2 存档 转换器（命令行版）
 *
 *   node tools/migrate-legacy-saves.mjs <旧站导出.json> [--out <目录>]
 *
 * 输入：在旧站 Console 里跑 tools/export-legacy-saves.js 下载到的 JSON。
 * 输出（默认写到 .dsh/tmp/migrate/）：
 *   migrated.json       —— { 新键: 值 } 的完整映射，可直接塞进新站 localStorage
 *   apply-in-console.js —— 在新站 Console 里粘贴即可写入的脚本
 *   report.md           —— 人读的迁移报告（成功/隔离/丢弃，逐条原因）
 *
 * 为什么要有这一步（而不是让新站直接读旧 JSON）：
 *   旧键用「角色显示名」当主键，改名即丢档；新键改用稳定的角色 ID。
 *   这层映射需要旧的角色名表，只有这里（读当前 index.html）拿得到可信的一份。
 *   转换在本地做，用户数据不经过任何网络。
 *
 * 转换逻辑本身在 tools/lib/legacy-migration-core.mjs，与本地小工具页
 * （tools/migrate-server.mjs）共用同一份——避免两边各修一半。
 * 本文件只负责：读参数、读文件、调核心、写文件、打印摘要。
 */
import fs from 'node:fs';
import path from 'node:path';

import { loadRoleTablesFromHtml } from './lib/html-tables.mjs';
import {
  buildRoleTables,
  migrateLegacyExport,
  buildApplyScript,
  buildReportMarkdown,
  LEGACY_FORMAT,
} from './lib/legacy-migration-core.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC_HTML = path.join(ROOT, 'index.html');

// ── 参数 ───────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const OUT_DIR = outIdx >= 0 ? path.resolve(argv[outIdx + 1]) : path.join(ROOT, '.dsh', 'tmp', 'migrate');
const inPath = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--out');

if (!inPath) {
  console.error('用法：node tools/migrate-legacy-saves.mjs <旧站导出.json> [--out <目录>]');
  process.exit(2);
}

// ── 角色表：启动时自检，宁可起不来也不要静默认错角色 ───────────────────────
let tables;
try {
  tables = buildRoleTables(loadRoleTablesFromHtml(SRC_HTML));
} catch (e) {
  console.error('✗ 读取角色表失败：' + e.message);
  process.exit(1);
}

if (!tables.ok) {
  if (tables.unresolvedNames.length) {
    console.error('✗ 有角色无法确定稳定 ID，转换中止（先修好映射表）：');
    tables.unresolvedNames.forEach(n => console.error('    ' + n));
  }
  if (tables.orphanIds.length) {
    console.error('✗ ENKA_ID_MAP 里有角色在 CHARACTER_DATA 中不存在，转换中止：');
    tables.orphanIds.forEach(id => console.error('    ' + id));
  }
  process.exit(1);
}

// ── 读入旧站导出 ───────────────────────────────────────────────────────────
let legacy;
try {
  legacy = JSON.parse(fs.readFileSync(inPath, 'utf8'));
} catch (e) {
  console.error('✗ 读不了导出文件：' + e.message);
  process.exit(1);
}

if (!legacy || legacy.format !== LEGACY_FORMAT) {
  console.error('✗ 文件格式不对（期望 format 为 "' + LEGACY_FORMAT + '"）。');
  console.error('   请确认用的是 tools/export-legacy-saves.js 在旧站导出的那份文件。');
  process.exit(1);
}

// ── 转换 ───────────────────────────────────────────────────────────────────
const out = migrateLegacyExport(legacy, tables);
if (!out.ok) {
  console.error('✗ ' + out.error);
  process.exit(1);
}
const { payload, report } = out;

// ── 输出 ───────────────────────────────────────────────────────────────────
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'migrated.json'), JSON.stringify(payload, null, 2));
fs.writeFileSync(path.join(OUT_DIR, 'apply-in-console.js'), buildApplyScript(payload.keys));
fs.writeFileSync(path.join(OUT_DIR, 'report.md'), buildReportMarkdown(payload, report, payload.migratedAt));

// ── 终端摘要 ───────────────────────────────────────────────────────────────
const totalSaves = report.ok.reduce((s, x) => s + x.count, 0);
console.log('✓ 转换完成，输出目录：' + path.relative(process.cwd(), OUT_DIR));
console.log('  搬运 ' + totalSaves + ' 条存档 / ' + report.ok.length + ' 个角色');
if (report.quarantined.length) console.log('  ⚠ 隔离 ' + report.quarantined.length + ' 个角色（详见 report.md）');
if (report.skipped.length) console.log('  · 跳过 ' + report.skipped.length + ' 个键');
for (const x of report.ok) console.log('    ' + x.charName.padEnd(14, '　') + ' → ' + x.newKey + '  (' + x.count + ' 条)');
console.log('');
console.log('  下一步：打开新站 → F12 Console → 粘贴 apply-in-console.js 全部内容 → 回车 → 刷新');
console.log('  （想在浏览器里先预览再下载，改用：node tools/migrate-server.mjs）');