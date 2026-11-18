#!/usr/bin/env node
/**
 * 旧站存档 → v2 存档 转换器
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
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC_HTML = path.join(ROOT, 'index.html');

/** 新键规范。改这里必须同步改新站 infra/storage.js，两处不一致会导致读不到档。 */
const SCHEMA = 2;
const PREFIX_SAVES = 'zzz.ddc.v2.saves.';
const KEY_SETTINGS = 'zzz.ddc.v2.settings';
const KEY_SCHEMA = 'zzz.ddc.v2.schema';

// ── 参数 ───────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const OUT_DIR = outIdx >= 0 ? path.resolve(argv[outIdx + 1]) : path.join(ROOT, '.dsh', 'tmp', 'migrate');
const inPath = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--out');

if (!inPath) {
  console.error('用法：node tools/migrate-legacy-saves.mjs <旧站导出.json> [--out <目录>]');
  process.exit(2);
}

// ── 从当前 index.html 提取角色表与别名表 ────────────────────────────────────
const html = fs.readFileSync(SRC_HTML, 'utf8');
const lines = html.split('\n');

function sliceBlock(startLine, endLine) {
  // startLine/endLine 为 1-based，含端点
  return lines.slice(startLine - 1, endLine).join('\n');
}

function evalExpr(src, label) {
  try {
    // eslint-disable-next-line no-new-func
    return new Function('"use strict"; return (' + src + ');')();
  } catch (e) {
    throw new Error('提取 ' + label + ' 失败：' + e.message);
  }
}

function extractConst(name) {
  const re = new RegExp('^\\s*const\\s+' + name + '\\s*=\\s*', 'm');
  const m = re.exec(html);
  if (!m) throw new Error('index.html 里找不到常量 ' + name);
  const start = m.index + m[0].length;
  let i = start, depth = 0, inStr = null, inTpl = false, inLine = false, inBlock = false;
  for (; i < html.length; i++) {
    const c = html[i], prev = html[i - 1], next = html[i + 1];
    if (inLine) { if (c === '\n') inLine = false; continue; }
    if (inBlock) { if (c === '*' && next === '/') { inBlock = false; i++; } continue; }
    if (inStr) { if (c === '\\') { i++; continue; } if (c === inStr) inStr = null; continue; }
    if (inTpl) { if (c === '\\') { i++; continue; } if (c === '`') inTpl = false; continue; }
    if (c === '/' && next === '/') { inLine = true; i++; continue; }
    if (c === '/' && next === '*') { inBlock = true; i++; continue; }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === '`') { inTpl = true; continue; }
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
    else if (c === ';' && depth === 0) { i++; break; }
  }
  return evalExpr(html.slice(start, i).replace(/;\s*$/, ''), name);
}

const CHARACTER_DATA = extractConst('CHARACTER_DATA');
const ENKA_ID_MAP = extractConst('ENKA_ID_MAP');

// aliasMap 是函数内的局部常量，单独抠出来
const aliasMatch = /const aliasMap = (\{[\s\S]*?\});/.exec(html);
if (!aliasMatch) throw new Error('index.html 里找不到 aliasMap');
const ALIAS_MAP = evalExpr(aliasMatch[1], 'aliasMap');

// 四个角色在「短名 → 全名」的别名表里缺项，只能靠模糊匹配兜到正确的人。
// 这里显式补齐，让迁移不依赖模糊匹配（新站会删掉那两级兜底）。
const ALIAS_PATCH = { '猫又': '猫宫又奈', '雅': '星见雅', '悠真': '浅羽悠真', '柳': '月城柳' };

// ── 构建 角色显示名 → 稳定 ID ───────────────────────────────────────────────
const fullToShort = {};
for (const [short, full] of Object.entries(ALIAS_MAP)) if (short !== full) fullToShort[full] = short;
// 反向：全名 → 短名（ALIAS_PATCH 的键是短名）
const patchFullToShort = {};
for (const [short, full] of Object.entries(ALIAS_PATCH)) patchFullToShort[full] = short;
const shortToId = {};
for (const [id, short] of Object.entries(ENKA_ID_MAP)) shortToId[short] = Number(id);

const NAME_TO_ID = {};
const ID_TO_NAME = {};
const unresolvedNames = [];

for (const faction of CHARACTER_DATA) {
  for (const role of faction.roles) {
    const short = fullToShort[role.name] ?? patchFullToShort[role.name] ?? role.name;
    const id = shortToId[short];
    if (id === undefined) { unresolvedNames.push(role.name); continue; }
    NAME_TO_ID[role.name] = id;
    ID_TO_NAME[id] = role.name;
  }
}

/**
 * 旧键名 → 稳定 ID。
 *
 * 旧站的键是「角色显示名」，而显示名在两套表里不一致：
 *   - CHARACTER_DATA 用全名（艾莲·乔、11号、扳机）
 *   - ENKA_ID_MAP 用短名（艾莲、11号、扳机）
 *   - 部分存档键还带着「」书名号
 *
 * 这里按优先级逐级归一，**不做模糊匹配**——旧站靠 includes 兜底，
 * 正是新站要删掉的那两级（会把「安比」串到「零号·安比」）。
 * 归一失败就隔离，宁可让用户看到一条待处理项，也不悄悄写错角色。
 */
function resolveCharId(rawName) {
  if (typeof rawName !== 'string' || !rawName) return undefined;
  const name = rawName.replace(/[「」『』\s]/g, '');

  if (NAME_TO_ID[name] !== undefined) return NAME_TO_ID[name];          // 全名直接命中

  const short = fullToShort[name] ?? patchFullToShort[name] ?? name;
  if (shortToId[short] !== undefined) return shortToId[short];           // 短名命中

  const viaAlias = ALIAS_MAP[name] ?? ALIAS_PATCH[name];
  if (viaAlias && NAME_TO_ID[viaAlias] !== undefined) return NAME_TO_ID[viaAlias];

  return undefined;
}

if (unresolvedNames.length) {
  console.error('✗ 有角色无法确定稳定 ID，转换中止（先修好映射表）：');
  unresolvedNames.forEach(n => console.error('    ' + n));
  process.exit(1);
}

const orphanIds = Object.keys(ENKA_ID_MAP).map(Number).filter(id => !(id in ID_TO_NAME));
if (orphanIds.length) {
  console.error('✗ ENKA_ID_MAP 里有角色在 CHARACTER_DATA 中不存在，转换中止：');
  orphanIds.forEach(id => console.error('    ' + id + ' → ' + ENKA_ID_MAP[id]));
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

if (!legacy || legacy.format !== 'zzz-ddc/legacy-saves') {
  console.error('✗ 文件格式不对（期望 format 为 "zzz-ddc/legacy-saves"）。');
  console.error('   请确认用的是 tools/export-legacy-saves.js 在旧站导出的那份文件。');
  process.exit(1);
}

// ── 转换 ───────────────────────────────────────────────────────────────────
const migrated = {};        // 新键 → 值
const report = {
  source: legacy.source,
  origin: legacy.origin,
  exportedAt: legacy.exportedAt,
  ok: [],                   // { charName, charId, newKey, count }
  renamed: [],              // 旧键名与记录内 charName 不一致
  quarantined: [],          // { charName, reason, payload }
  skipped: [],              // 空列表、全条无效等
  settings: null,
};

for (const [legacyName, entry] of Object.entries(legacy.characters || {})) {
  if (entry && entry.broken) {
    report.quarantined.push({ charName: legacyName, reason: '旧站那份数据本身是坏的（JSON 解析失败或不是数组）', payload: entry });
    continue;
  }
  const saves = entry && entry.saves;
  if (!Array.isArray(saves) || saves.length === 0) {
    report.skipped.push({ charName: legacyName, reason: '没有有效存档' });
    continue;
  }

  // 键名可能是旧显示名（角色改过名时与记录内 charName 不一致）。
  // 身份判定优先用键名，因为旧站的键名就是查找依据；记录内 charName 只用于对账。
  const charId = resolveCharId(legacyName);
  if (charId === undefined) {
    // 试试记录内记录的 charName（键名可能是残缺的显示名，记录里反而是全名）
    const altId = saves.map(s => resolveCharId(s && s.data && s.data.charName)).find(x => x !== undefined);
    if (altId === undefined) {
      report.quarantined.push({
        charName: legacyName,
        reason: '当前角色表里没有这个名字（旧站可能有已删除/改名的角色）',
        payload: entry,
      });
      continue;
    }
    report.renamed.push({ legacyName, note: '键名无法归一，按记录内 charName 归到 ' + ID_TO_NAME[altId], mergedInto: PREFIX_SAVES + altId });
    var resolvedByInner = altId;
  }
  const finalCharId = charId !== undefined ? charId : resolvedByInner;

  const canonicalName = ID_TO_NAME[finalCharId];
  const migratedSaves = [];
  for (const s of saves) {
    const data = s.data || {};
    if (data.charName !== legacyName) {
      report.renamed.push({ legacyName, insideCharName: data.charName, saveName: s.name, resolvedTo: canonicalName, charId });
    }
    migratedSaves.push({
      name: s.name,
      data: {
        ...data,
        // 身份字段改为 ID + 规范名，新站不再依赖这里做匹配
        charId: finalCharId,
        charName: canonicalName,
        legacyCharName: legacyName,
      },
    });
  }

  const newKey = PREFIX_SAVES + finalCharId;
  if (migrated[newKey]) {
    // 同一角色被两套键名存过（改名前后各存一份）——合并，不覆盖。
    const existing = JSON.parse(migrated[newKey]);
    existing.saves.push(...migratedSaves);
    existing.mergedFrom.push(legacyName);
    migrated[newKey] = JSON.stringify(existing);
    report.renamed.push({ legacyName, mergedInto: newKey, note: '同名角色存在多份旧键，已合并' });
    continue;
  }

  migrated[newKey] = JSON.stringify({
    schema: SCHEMA,
    charId: finalCharId,
    charName: canonicalName,
    mergedFrom: [legacyName],
    saves: migratedSaves,
  });
  report.ok.push({ charName: canonicalName, charId: finalCharId, legacyName, newKey, count: migratedSaves.length });
}

// 设置项：只搬认识的键，未知键记下来不丢
const KNOWN_SETTINGS = ['autoCollapseImport', 'autoCollapseOutput'];
if (legacy.settings && typeof legacy.settings === 'object') {
  const kept = {};
  const dropped = [];
  for (const [k, v] of Object.entries(legacy.settings)) {
    if (KNOWN_SETTINGS.includes(k)) kept[k] = v; else dropped.push(k);
  }
  if (Object.keys(kept).length) migrated[KEY_SETTINGS] = JSON.stringify(kept);
  report.settings = { migrated: kept, droppedUnknown: dropped };
}

migrated[KEY_SCHEMA] = String(SCHEMA);

// ── 输出 ───────────────────────────────────────────────────────────────────
fs.mkdirSync(OUT_DIR, { recursive: true });

const payload = {
  format: 'zzz-ddc/migrated-saves',
  version: SCHEMA,
  migratedAt: new Date().toISOString(),
  sourceOrigin: legacy.origin,
  keys: migrated,
  quarantine: report.quarantined,
};
fs.writeFileSync(path.join(OUT_DIR, 'migrated.json'), JSON.stringify(payload, null, 2));

fs.writeFileSync(path.join(OUT_DIR, 'apply-in-console.js'), `/* 在新站页面 Console 里整段粘贴执行：把转换好的存档写进 localStorage。
 * 幂等：重复执行只会覆盖同名新键，不会产生重复条目。
 * 执行前请确认已在新站 origin 下（而不是旧站）。
 */
(function applyMigratedSaves() {
  'use strict';
  var PAYLOAD = ${JSON.stringify({ keys: migrated }, null, 2)};
  var n = 0, bytes = 0;
  Object.keys(PAYLOAD.keys).forEach(function (k) {
    var v = PAYLOAD.keys[k];
    localStorage.setItem(k, v);
    n++; bytes += v.length;
  });
  console.log('%c已写入 ' + n + ' 个键，共 ' + (bytes / 1024).toFixed(1) + ' KB。', 'color:#080;font-weight:bold');
  console.log('刷新页面即可看到存档。');
  return n;
})();
`);

const md = [];
md.push('# 旧站存档迁移报告');
md.push('');
md.push('- 来源：' + (legacy.origin || '未知') + '（导出于 ' + legacy.exportedAt + '）');
md.push('- 转换时间：' + payload.migratedAt);
md.push('- 成功搬运：**' + report.ok.reduce((s, x) => s + x.count, 0) + '** 条存档，覆盖 **' + report.ok.length + '** 个角色');
md.push('- 隔离未写入：' + report.quarantined.length + ' 个角色');
md.push('- 跳过：' + report.skipped.length + ' 个键');
md.push('');
if (report.ok.length) {
  md.push('## 已搬运');
  md.push('');
  md.push('| 角色 | 稳定 ID | 旧键名 | 存档数 |');
  md.push('|---|---|---|---|');
  report.ok.forEach(x => md.push('| ' + x.charName + ' | ' + x.charId + ' | ' + x.legacyName + ' | ' + x.count + ' |'));
  md.push('');
}
if (report.renamed.length) {
  md.push('## 键名与记录内名字不一致（已按键名归一）');
  md.push('');
  report.renamed.forEach(x => {
    if (x.mergedInto) md.push('- 「' + x.legacyName + '」→ ' + x.mergedInto + '（' + x.note + '）');
    else md.push('- 存档「' + x.saveName + '」记录内写的是「' + x.insideCharName + '」，键名是「' + x.legacyName + '」→ 归到 ' + x.resolvedTo + '(' + x.charId + ')');
  });
  md.push('');
}
if (report.quarantined.length) {
  md.push('## 隔离（未写入，原始数据保留在 migrated.json 的 quarantine 字段里）');
  md.push('');
  report.quarantined.forEach(x => md.push('- **' + x.charName + '**：' + x.reason));
  md.push('');
}
if (report.skipped.length) {
  md.push('## 跳过');
  md.push('');
  report.skipped.forEach(x => md.push('- ' + x.charName + '：' + x.reason));
  md.push('');
}
if (report.settings) {
  md.push('## 设置项');
  md.push('');
  md.push('- 已迁移：' + (Object.keys(report.settings.migrated).join(', ') || '无'));
  if (report.settings.droppedUnknown.length) md.push('- 不认识、未迁移：' + report.settings.droppedUnknown.join(', '));
  md.push('');
}
md.push('## 怎么用');
md.push('');
md.push('1. 打开新站页面（同一个浏览器）。');
md.push('2. F12 → Console，粘贴 `apply-in-console.js` 全部内容，回车。');
md.push('3. 刷新页面。');
md.push('');
md.push('> `migrated.json` 是同一份数据的结构化版本，也可以由新站的「导入旧站存档」按钮读取。');
fs.writeFileSync(path.join(OUT_DIR, 'report.md'), md.join('\n'));

// ── 终端摘要 ───────────────────────────────────────────────────────────────
console.log('✓ 转换完成，输出目录：' + path.relative(process.cwd(), OUT_DIR));
console.log('  搬运 ' + report.ok.reduce((s, x) => s + x.count, 0) + ' 条存档 / ' + report.ok.length + ' 个角色');
if (report.quarantined.length) console.log('  ⚠ 隔离 ' + report.quarantined.length + ' 个角色（详见 report.md）');
if (report.skipped.length) console.log('  · 跳过 ' + report.skipped.length + ' 个键');
for (const x of report.ok) console.log('    ' + x.charName.padEnd(14, '　') + ' → ' + x.newKey + '  (' + x.count + ' 条)');
