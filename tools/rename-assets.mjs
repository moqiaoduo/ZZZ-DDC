#!/usr/bin/env node
/**
 * 把仓库里的截图默认命名图片改成公式化命名。
 *
 * 现状（改名前）：
 *   「屏幕截图 2026-07-10 194828.png」×59 —— 角色头像，名字毫无信息量
 *   「屏幕截图 2026-08-16 163440.png」等 ×3 —— 道具图标
 *   「计算器图标.jpg」「微信图片_20260817233740.jpg」—— 站点图标与赞赏码
 *
 * 问题不只是难看：名字带空格和中文，在 URL 里要 percent-encoding；
 * 没法从名字反推是哪张图；按名字排序也看不出任何结构。
 *
 * 改后：
 *   assets/characters/<ENKA_ID>.png   角色头像，ID 是官方数字 ID，稳定唯一
 *   assets/costs/<用途>.png           道具图标，按代码里的用途命名
 *   assets/site/<用途>.jpg            站点图标与赞赏码
 *
 * 角色名 → ENKA ID 的映射不另建表，直接复用 tools/lib 里那套三表对账逻辑
 * （CHARACTER_DATA 全名 / ENKA_ID_MAP 短名 / aliasMap 别名），59 个角色必须
 * 全部解析成功才动手——解析不出来就中止，不产出半套改名。
 *
 * 用法：
 *   node tools/rename-assets.mjs --dry-run   只打印计划，不动文件
 *   node tools/rename-assets.mjs             执行（用 git mv，保留历史）
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadRoleTablesFromHtml } from './lib/html-tables.mjs';
import { buildRoleTables } from './lib/legacy-migration-core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 读归档的原版单体，不读仓库根的 index.html——后者现在是 split.mjs 生成的
// 骨架，里面没有 CHARACTER_DATA 这些字面量，抠不出角色表。
const HTML = path.join(ROOT, 'legacy', 'index.v0.html');
const DRY = process.argv.includes('--dry-run');

// 改名表来自共享模块：tools/split.mjs 从 legacy/ 生成骨架时要用同一套映射，
// 两处各写一份必然漂移。
const { FIXED_ASSET_NAMES: FIXED, characterAssetPath: roleAssetPath } = await import('./lib/asset-names.mjs');

// ── 规划 ──────────────────────────────────────────────────────────────

const tables = buildRoleTables(loadRoleTablesFromHtml(HTML));
if (!tables.ok) {
  console.error('角色三表对账失败，拒绝改名：');
  if (tables.unresolvedNames.length) console.error('  无法解析出 ID：' + tables.unresolvedNames.join('、'));
  if (tables.orphanIds.length) console.error('  ENKA_ID_MAP 里有孤儿 ID：' + tables.orphanIds.join('、'));
  process.exit(1);
}

const chars = loadRoleTablesFromHtml(HTML).CHARACTER_DATA;
const roles = chars.flatMap((f) => f.roles);

const plan = [];      // { from, to, why }
const seenSource = new Set();

for (const role of roles) {
  const id = tables.resolveCharId(role.name);
  const to = roleAssetPath(id);
  // role.image 在改名完成后已是新路径，from 直接用现值即可（幂等：from === to 时跳过）。
  plan.push({ from: role.image, to, why: `角色 ${role.name}（ENKA ${id}）` });
  seenSource.add(role.image);
}

for (const [from, to] of FIXED) {
  // 幂等：改完之后源路径已不存在，此时已在 to 位置，记 from = to 让上层跳过。
  const src = fs.existsSync(path.join(ROOT, from)) ? from : to;
  plan.push({ from: src, to, why: '固定用途' });
  seenSource.add(src);
  seenSource.add(to);
}

// 仓库根下所有图片都必须被计划覆盖，漏掉的说明有图没被引用（死资源）或引用写法没被识别。
const onDisk = fs.readdirSync(ROOT).filter((f) => /\.(png|jpg|jpeg)$/i.test(f));
const unplanned = onDisk.filter((f) => !seenSource.has(f));

// 目标路径不能相撞，否则会静默覆盖。
const targetSeen = new Map();
for (const p of plan) {
  if (targetSeen.has(p.to)) {
    console.error(`目标路径冲突：${p.to} 同时来自「${targetSeen.get(p.to)}」与「${p.from}」`);
    process.exit(1);
  }
  targetSeen.set(p.to, p.from);
}

// 已经在目标位置的不再动——脚本要能反复跑，第二次跑应当什么也不做。
const pending = plan.filter((p) => p.from !== p.to);
const done = plan.length - pending.length;

console.log(`计划改名 ${pending.length} 个文件 → assets/（已在目标位置的 ${done} 个跳过）`);
console.log(`  角色头像 ${roles.length} 个、固定用途 ${FIXED.size} 个`);
if (pending.length === 0) {
  console.log('\n所有图片都已是目标命名，无需改动。');
  process.exit(0);
}
plan.length = 0;
plan.push(...pending);
if (unplanned.length) {
  console.log(`\n未纳入计划（多半是零引用的死资源，改名后应删掉）：`);
  for (const f of unplanned) console.log(`  ${f}`);
}

if (DRY) {
  console.log('\n前 5 条：');
  for (const p of plan.slice(0, 5)) console.log(`  ${p.from}  →  ${p.to}   (${p.why})`);
  console.log('\n--dry-run，未改动任何文件。');
  process.exit(0);
}

// ── 执行 ──────────────────────────────────────────────────────────────

/**
 * 用 git mv 而不是 fs.renameSync。
 *
 * 图片都是入库文件，git mv 能让 git 认出这是改名（相似度 100%），历史跟随新路径；
 * fs.renameSync 之后再 add，git 也可能推断出改名，但大文件（4MB 的 PNG）在
 * 默认相似度阈值下未必认得出，会变成「删一个加一个」。
 */
function gitMv(from, to) {
  fs.mkdirSync(path.dirname(path.join(ROOT, to)), { recursive: true });
  execFileSync('git', ['mv', from, to], { cwd: ROOT, stdio: 'pipe' });
}

let moved = 0;
for (const p of plan) {
  const src = path.join(ROOT, p.from);
  if (!fs.existsSync(src)) {
    console.error(`源文件不存在，中止：${p.from}`);
    process.exit(1);
  }
  gitMv(p.from, p.to);
  moved++;
}
console.log(`\n已移动 ${moved} 个文件。`);

// ── 改写 index.html 的引用 ────────────────────────────────────────────

let html = fs.readFileSync(HTML, 'utf8');
let hits = 0;
// 长的先换，避免「屏幕截图 2026-08-16 163440.png」被更短的键提前局部匹配。
const ordered = [...plan].sort((a, b) => b.from.length - a.from.length);
for (const p of ordered) {
  const before = html;
  html = html.split(p.from).join(p.to);
  if (html !== before) hits += html.split(p.to).length - 1;
}
fs.writeFileSync(HTML, html, 'utf8');
console.log(`index.html 里替换了 ${hits} 处引用。`);

// 替换后不该再有旧名残留。
const leftovers = ordered.filter((p) => html.includes(p.from));
if (leftovers.length) {
  console.error('仍有旧名残留：' + leftovers.map((p) => p.from).join('、'));
  process.exit(1);
}

console.log('\n完成。检查：git status；跑 node tools/golden.mjs 确认数值没变。');
