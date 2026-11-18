#!/usr/bin/env node
/**
 * 旧站存档迁移链路的自测：export-legacy-saves.js → migrate-legacy-saves.mjs。
 *
 *   node tools/test-legacy-migration.mjs
 *
 * 用一个内存版 localStorage 模拟旧站，跑导出脚本，再跑转换器，逐条断言。
 * 覆盖正常存档、JSON 坏掉、非数组、空列表、条目缺字段、键名与记录名不一致、
 * 改名前后两份键并存、已删除角色、未知设置项。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const TMP = path.join(ROOT, '.dsh', 'tmp', 'test-migration');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

// ── 用真实导出脚本跑一个内存版旧站 ──────────────────────────────────────────
function buildLegacyExport(fixtures) {
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'export-legacy-saves.js'), 'utf8');
  const store = new Map(Object.entries(fixtures));
  const sandbox = {
    localStorage: {
      get length() { return store.size; },
      key: i => [...store.keys()][i] ?? null,
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    },
    location: { href: 'https://qfmyqqx.github.io/ZZZ-DDC/', origin: 'https://qfmyqqx.github.io' },
    console: { log() {}, table() {} },
    Blob: class { constructor(p) { this.parts = p; } },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    document: { body: { appendChild() {}, removeChild() {} }, createElement: () => ({ click() {} }) },
    Date, setTimeout() {},
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.__zzzLegacyExport;
}

const fixtures = {
  'zzz_disk_saves_艾莲·乔': JSON.stringify([
    { name: '1号存档', data: { charName: '艾莲·乔', positions: { 4: { mains: ['暴击伤害'], enhance: {} } }, special: {} } },
    { name: '速刷', data: { charName: '艾莲·乔', positions: {}, special: {} } },
  ]),
  'zzz_disk_saves_猫又': JSON.stringify([
    { name: '默认', data: { charName: '猫又', positions: {}, special: {} } },
  ]),
  'zzz_disk_saves_扳机': JSON.stringify([
    { name: 'A', data: { charName: '扳机', positions: {}, special: {} } },
  ]),
  'zzz_disk_saves_「扳机」': JSON.stringify([
    { name: 'B', data: { charName: '「扳机」', positions: {}, special: {} } },
  ]),
  'zzz_disk_saves_已删除角色': JSON.stringify([
    { name: 'x', data: { charName: '已删除角色', positions: {}, special: {} } },
  ]),
  'zzz_disk_saves_坏数据': '{{{ not json',
  'zzz_disk_saves_非数组': JSON.stringify({ oops: true }),
  'zzz_disk_saves_空列表': JSON.stringify([]),
  'zzz_disk_saves_杂条': JSON.stringify([
    { name: '有效', data: { charName: '杂条', positions: {} } },
    { name: '', data: {} },
    null,
    { name: '缺data' },
  ]),
  zzz_calc_settings: JSON.stringify({ autoCollapseImport: false, autoCollapseOutput: true, futureFlag: 1 }),
};

console.log('A. 导出脚本');
const legacy = buildLegacyExport(fixtures);
check('format 正确', legacy.format === 'zzz-ddc/legacy-saves');
check('version 为 1', legacy.version === 1);
check('统计到 9 个存档键', legacy.stats.saveKeys === 9, '实际 ' + legacy.stats.saveKeys);
check('坏数据进 broken 分支', !!legacy.characters['坏数据']?.broken);
check('非数组进 broken 分支', !!legacy.characters['非数组']?.broken);
check('空列表被跳过', legacy.characters['空列表'] === undefined);
check('杂条 只留 1 条有效 + 1 条改名告警', legacy.characters['杂条']?.saves?.length === 1);
check('settings 被完整搬运', legacy.settings?.futureFlag === 1);
check('有告警但没崩', legacy.warnings.length >= 4, '告警 ' + legacy.warnings.length + ' 条');

const legacyPath = path.join(TMP, 'legacy.json');
fs.writeFileSync(legacyPath, JSON.stringify(legacy, null, 2));

console.log('\nB. 转换器');
const outDir = path.join(TMP, 'out');
execFileSync('node', [path.join(ROOT, 'tools', 'migrate-legacy-saves.mjs'), legacyPath, '--out', outDir], { stdio: 'pipe' });
const migrated = JSON.parse(fs.readFileSync(path.join(outDir, 'migrated.json'), 'utf8'));
const K = migrated.keys;

check('写出 schema 版本键', K['zzz.ddc.v2.schema'] === '2');
check('艾莲·乔 落到 1191', !!K['zzz.ddc.v2.saves.1191']);
check('11号 之外的三个「缺别名」角色可解析', !!K['zzz.ddc.v2.saves.1021'], '猫又 → 猫宫又奈(1021)');
check('改名前后两份键合并为一条', JSON.parse(K['zzz.ddc.v2.saves.1361']).saves.length === 2);
check('合并记录了来源键名', JSON.parse(K['zzz.ddc.v2.saves.1361']).mergedFrom.length === 2);
check('已删除角色被隔离', migrated.quarantine.some(q => q.charName === '已删除角色'));
check('坏数据被隔离', migrated.quarantine.some(q => q.charName === '坏数据'));
check('非数组被隔离', migrated.quarantine.some(q => q.charName === '非数组'));
check('未知设置项不写入新键',
  !K['zzz.ddc.v2.settings'].includes('futureFlag'),
  '实际 ' + K['zzz.ddc.v2.settings']);
check('已知设置项写入', JSON.parse(K['zzz.ddc.v2.settings']).autoCollapseImport === false);

const e = JSON.parse(K['zzz.ddc.v2.saves.1191']);
check('存档结构带 charId + charName + legacyCharName',
  e.saves[0].data.charId === 1191 && e.saves[0].data.legacyCharName === '艾莲·乔');
check('原始 positions 未被改写',
  JSON.stringify(e.saves[0].data.positions) === JSON.stringify({ 4: { mains: ['暴击伤害'], enhance: {} } }));
check('生成 apply-in-console.js', fs.existsSync(path.join(outDir, 'apply-in-console.js')));
check('生成 report.md', fs.existsSync(path.join(outDir, 'report.md')));

console.log('\nC. 幂等与拒绝');
const outDir2 = path.join(TMP, 'out2');
execFileSync('node', [path.join(ROOT, 'tools', 'migrate-legacy-saves.mjs'), legacyPath, '--out', outDir2], { stdio: 'pipe' });
const migrated2 = JSON.parse(fs.readFileSync(path.join(outDir2, 'migrated.json'), 'utf8'));
check('重复转换结果一致', JSON.stringify(migrated.keys) === JSON.stringify(migrated2.keys));

const bogusPath = path.join(TMP, 'bogus.json');
fs.writeFileSync(bogusPath, JSON.stringify({ format: 'something-else' }));
let rejected = false;
try {
  execFileSync('node', [path.join(ROOT, 'tools', 'migrate-legacy-saves.mjs'), bogusPath, '--out', path.join(TMP, 'out3')], { stdio: 'pipe' });
} catch (err) { rejected = err.status === 1; }
check('错格式文件被拒绝且退出码 1', rejected);

console.log('\n' + '─'.repeat(56));
if (fail === 0) {
  console.log('全部通过：' + pass + ' 项断言');
  process.exit(0);
} else {
  console.log('失败 ' + fail + ' / ' + (pass + fail) + ' 项：');
  failures.forEach(f => console.log('  · ' + f));
  process.exit(1);
}
