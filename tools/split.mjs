#!/usr/bin/env node
/**
 * 把单文件 index.html 拆成标准前端分层。
 *
 * 这是一次性的迁移工具：把 legacy/index.v0.html 里的 65 个函数按职责搬进
 * src/ 下的对应模块，模块级可变状态收进 store，产出仓库根的 index.html 骨架。
 * 「数值层面没变」由 tools/golden.mjs 的黄金快照证明。
 *
 * 迁移完成后，改动应当直接改 src/ 下的模块——重跑本工具会覆盖手改的内容，
 * 所以它对已存在的 src/ 有覆盖保护（除非显式 --force）。
 *
 * 三条设计约束：
 *   1. 函数体逐字保留。本工具只做「搬运 + 加 import/export + 全局引用改 state.x」，
 *      不改写任何逻辑——逻辑改写留给后续 Phase，那样才能分清「搬错了」与「改错了」。
 *   2. 死代码不搬。LOC_ZH_TW / ENTRY_IDX_MAP / enkaIdToNameMap / loadEnkaMappings
 *      全文只有声明没有引用，搬过去只会让新架构也背同样的包袱。
 *   3. 数据用 .js 模块而不是 .json。JSON 要靠 `with { type: 'json' }` 才能 import，
 *      那在移动端浏览器上的支持面还不够宽；fetch 则引入异步失败路径。数据本身就是
 *      字面量，导出成 .js 常量零额外风险。
 *
 * 用法：node tools/split.mjs [--out <目录>] [--quiet]
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { loadRoleTablesFromHtml } from './lib/html-tables.mjs';
import { buildRoleTables } from './lib/legacy-migration-core.mjs';
import { rewriteAssetRefs } from './lib/asset-names.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 源文件是归档的原版单体。根目录的 index.html 已经是本工具生成的骨架，
// 不能再拿它当输入——否则第二次跑会把骨架当源码拆，直接产出一堆空模块。
const SRC_HTML = path.join(ROOT, 'legacy', 'index.v0.html');

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const OUT = path.resolve(ROOT, argOf('--out', 'src'));
const QUIET = argv.includes('--quiet');
const FORCE = argv.includes('--force');

// 这是一次性迁移工具：跑完一次后 src/ 就是手写源码的所在地，改逻辑要改 src/，
// 而不是改 legacy/ 再重跑（重跑会把手改的内容全部覆盖）。所以默认拒绝覆盖
// 已有的非空 src/，要重跑必须显式 --force。
if (fs.existsSync(OUT) && fs.readdirSync(OUT).length > 0 && !FORCE) {
  console.error(`${path.relative(ROOT, OUT)} 已存在且非空。`);
  console.error('本工具是迁移时跑一次用的；之后的改动应当直接改 src/ 下的模块。');
  console.error('确实要从 legacy/ 重新生成（会覆盖手改内容），加 --force。');
  process.exit(1);
}
const log = (...a) => { if (!QUIET) console.log(...a); };

// ── 切分 ──────────────────────────────────────────────────────────────

const rawHtml = fs.readFileSync(SRC_HTML, 'utf8');

// legacy/ 里存的是改名前的原版，图片引用还是「屏幕截图 2026-07-10 194828.png」
// 这种默认名。生成的骨架必须指向 assets/ 下的新名字，否则产物图片全 404。
const roleTables = buildRoleTables(loadRoleTablesFromHtml(SRC_HTML));
if (!roleTables.ok) {
  console.error('角色三表对账失败：' + [...roleTables.unresolvedNames, ...roleTables.orphanIds].join('、'));
  process.exit(1);
}
const nameToId = new Map();
for (const faction of loadRoleTablesFromHtml(SRC_HTML).CHARACTER_DATA) {
  for (const role of faction.roles) {
    const id = roleTables.resolveCharId(role.name);
    if (id) nameToId.set(role.image, id);
  }
}
const html = rewriteAssetRefs(rawHtml, { nameToId });
const lines = html.split('\n');

const idx = (re, what) => {
  const i = lines.findIndex(l => re.test(l));
  if (i < 0) throw new Error(`index.html 里找不到 ${what}`);
  return i;
};
const STYLE_OPEN = idx(/<style>/, '<style>');
const STYLE_CLOSE = idx(/<\/style>/, '</style>');
const SCRIPT_OPEN = idx(/<script>\s*$/, '<script>');
const SCRIPT_CLOSE = idx(/<\/script>\s*$/, '</script>');

const scriptText = lines.slice(SCRIPT_OPEN + 1, SCRIPT_CLOSE).join('\n');

/**
 * 把 JS 切成「顶层单元」：顶层声明、函数、裸语句块。
 *
 * 不能逐行用正则判断——多行 try/catch、for 循环、箭头函数体都会被切坏。
 * 这里维护括号深度与字符串/注释状态，深度归零才算一个单元结束；归零后若紧跟
 * catch/else/finally/while，说明还是同一单元（否则 try 与 catch 会被拆成两半）。
 */
function splitTopLevel(text) {
  const units = [];
  let depth = 0;
  let i = 0;
  let start = -1;

  const skipString = (q) => {
    i++;
    while (i < text.length) {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i] === q) { i++; return; }
      i++;
    }
  };
  const skipTemplate = () => {
    i++;
    let braceDepth = 0;
    while (i < text.length) {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i] === '$' && text[i + 1] === '{') { i += 2; braceDepth++; continue; }
      if (text[i] === '}' && braceDepth > 0) { i++; braceDepth--; continue; }
      if (text[i] === '`' && braceDepth === 0) { i++; return; }
      i++;
    }
  };
  const skipLine = () => { while (i < text.length && text[i] !== '\n') i++; };
  const skipBlock = () => {
    i += 2;
    while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
    i += 2;
  };

  const CONTINUATIONS = ['catch', 'else', 'finally', 'while'];
  // `}` 之后若出现这些字符，说明语句还没完：链式调用、二元运算、箭头函数体等。
  const TRAILING = new Set(['(', '[', '.', '+', '-', '*', '/', '%', '?', ':', '&', '|', '^', '=', '>', '<', '`', ',']);

  const finish = () => {
    let j = i;
    while (j < text.length && /[\s;]/.test(text[j])) j++;
    const rest = text.slice(j);
    const head = rest.match(/^(catch|else|finally|while)\b/);
    if (head) {
      i = j + head[1].length;
      depth = 0;
      return;
    }
    if (rest[0] === '{') {
      // 前面是 () / [] 收尾，紧接着是语句体
      return;
    }
    if (TRAILING.has(rest[0])) {
      i = j;
      return;
    }
    units.push({ start, end: i, text: text.slice(start, i) });
    i = j;
    start = -1;
  };

  while (i < text.length) {
    const c = text[i];
    const c2 = text[i + 1];

    if (c === '/' && c2 === '/') { skipLine(); continue; }
    if (c === '/' && c2 === '*') { skipBlock(); continue; }
    if (c === '"' || c === "'") { if (start < 0) start = i; skipString(c); continue; }
    if (c === '`') { if (start < 0) start = i; skipTemplate(); continue; }
    if (/\s/.test(c)) { i++; continue; }

    if (start < 0) start = i;

    if (c === '(' || c === '[' || c === '{') { depth++; i++; continue; }
    if (c === ')' || c === ']' || c === '}') {
      depth--;
      i++;
      // 深度归零不代表单元结束：`f()` 后面可能跟函数体 `{`，也可能跟链式调用 `.x()`。
      // 只在收尾括号是 `}`（块结束）时判定，`)(]` 一律等分号或后续 `{`/`.` 决定。
      if (depth === 0 && c === '}') finish();
      continue;
    }
    if (c === ';' && depth === 0) { i++; finish(); continue; }

    i++;
  }
  if (start >= 0) {
    const tail = text.slice(start).trim();
    if (tail) units.push({ start, end: text.length, text });
  }
  return units;
}

const units = splitTopLevel(scriptText);

const RE_DECL = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/;
const RE_FUNC = /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/;

const decls = new Map();
const funcs = new Map();
const stmts = [];

for (const u of units) {
  const d = u.text.match(RE_DECL);
  const f = u.text.match(RE_FUNC);
  if (d) decls.set(d[1], u.text.trim());
  else if (f) funcs.set(f[1], u.text.trim());
  else stmts.push(u.text.trim());
}
log(`切分：声明 ${decls.size} / 函数 ${funcs.size} / 裸语句 ${stmts.length}`);

// ── 求值：把数据常量的真实值拿出来 ────────────────────────────────────

function evalDecls(names, extra = '') {
  const code = names.map(n => decls.get(n)).join('\n')
    + (extra ? '\n' + extra : '')
    + `\n;globalThis.__out = { ${names.join(', ')} };`;
  const ctx = vm.createContext({});
  new vm.Script(code, { filename: 'extracted' }).runInContext(ctx);
  return ctx.__out;
}

const LOC_ZH_CN = evalDecls(['LOC_ZH_CN']).LOC_ZH_CN;

/** 原脚本用一段顶层 for 循环从 LOC_ZH_CN 派生套装名，这里在拆分期算好写成常量。 */
function buildSuitNameMap() {
  const out = {};
  for (const key in LOC_ZH_CN) {
    if (key.startsWith('EquipmentSuit_') && key.endsWith('_name')) {
      const numStr = key.substring('EquipmentSuit_'.length, key.length - '_name'.length);
      out[numStr.slice(0, 3)] = LOC_ZH_CN[key];
    }
  }
  return out;
}

const PROB_CONSTS = evalDecls(['Achance', 'Bchance', 'Atimes', 'Btimes']);

// ── 模块划分 ──────────────────────────────────────────────────────────

/** 全局可变状态：统一收进 app/store.js，引用处改写成 state.x。 */
const GLOBALS = ['gameSelectedChars', 'lastImportedChars', 'charConfigsCache', 'extractionList', 'settings'];

/** 确认没有引用的死代码，不搬。 */
// findCharacterInData 已判定为死代码（src/ 内零调用），不搬。
const DEAD = ['LOC_ZH_TW', 'ENTRY_IDX_MAP', 'enkaIdToNameMap', 'loadEnkaMappings', 'numStr', 'suitId', 'findCharacterInData'];

/** 每个名字搬到哪个模块。漏掉任何一个都会在下面被 assert 拦住。 */
const MAP = {
  // 数据
  'CHARACTER_DATA': 'data/characters.js',
  'ENTRY_NAMES': 'data/game-config.js',
  'SUBSTAT_SPECIAL_WEIGHTS': 'data/game-config.js',
  'MAIN_ENTRY_CONFIG': 'data/game-config.js',
  'MAIN_PROB_WEIGHTS': 'data/game-config.js',
  'MAIN_ATTR_TO_SUB': 'data/game-config.js',
  'ENKA_ID_MAP': 'data/enka-mapping.js',
  'MAIN_STAT_NAME_MAP': 'data/enka-mapping.js',
  'SUBSTAT_INDEX_MAP': 'data/enka-mapping.js',
  'SUIT_NAME_MAP': 'data/suits.js',
  'themes': 'data/themes.js',
  'LOC_ZH_CN': 'data/localization.js',
  'tutorialText': 'data/tutorial.js',
  'Achance': 'domain/probability.js',
  'Bchance': 'domain/probability.js',
  'Atimes': 'domain/probability.js',
  'Btimes': 'domain/probability.js',

  // domain：纯函数
  'parseNumber': 'domain/probability.js',
  'dfsUp': 'domain/probability.js',
  'passChance': 'domain/probability.js',
  'firstGroup': 'domain/probability.js',
  'calculateCore': 'domain/probability.js',
  'calculateCoreGame': 'domain/probability.js',
  'hexToRgb': 'domain/format.js',
  'formatCost': 'domain/format.js',
  'findCharacterByImportedName': 'domain/characters.js',

  // app：状态与业务
  'saveSettings': 'app/store.js',
  'getCurrentPositions': 'app/positions.js',
  'getSelectedMainForPos': 'app/positions.js',
  'getBlockedSubIdxForPos': 'app/positions.js',
  'getMaxScoreForPos': 'app/positions.js',
  'calcPosScore': 'app/positions.js',
  'getPosGoal': 'app/positions.js',
  'updatePosScale': 'app/positions.js',
  'initCharEntries': 'app/entries.js',
  'updateCharWeights': 'app/entries.js',
  'onMainEntryChange': 'app/entries.js',
  'renderMainEntriesForPos': 'app/entries.js',
  'buildPosEnhance': 'app/entries.js',
  'buildGameDirectOptions': 'app/entries.js',
  'toggleGameDirect': 'app/entries.js',
  'limitGameDirect': 'app/entries.js',
  'getGameDirectTypes': 'app/entries.js',
  'collectEntryListForSingleMain': 'app/entries.js',
  'renderFactionTabs': 'app/character-panel.js',
  'renderCharacterGrid': 'app/character-panel.js',
  'cacheCurrentPanels': 'app/character-panel.js',
  'renderAllCharacterConfigs': 'app/character-panel.js',
  'toggleCharPanel': 'app/character-panel.js',
  'createPositionConfig': 'app/character-panel.js',
  'removePositionConfig': 'app/character-panel.js',
  'togglePosition': 'app/character-panel.js',
  'onPositionChange': 'app/character-panel.js',
  'calculateGame': 'app/game-calc.js',
  'generateAdvancedEntries': 'app/custom-calc.js',
  'toggleCustomDirect': 'app/custom-calc.js',
  'buildCustomDirectOptions': 'app/custom-calc.js',
  'calculateAdvanced': 'app/custom-calc.js',
  'getSavesKey': 'app/saves.js',
  'loadSavesList': 'app/saves.js',
  'saveSavesList': 'app/saves.js',
  'refreshSaveSelect': 'app/saves.js',
  'syncSaveSelects': 'app/saves.js',
  'collectCharConfigData': 'app/saves.js',
  'restoreCharConfigData': 'app/saves.js',
  'newSave': 'app/saves.js',
  'saveCurrentConfig': 'app/saves.js',
  'readCurrentSave': 'app/saves.js',
  'deleteCurrentSave': 'app/saves.js',
  'renameCurrentSave': 'app/saves.js',
  'oneClickSaveImported': 'app/saves.js',
  'updateJsonLink': 'app/importer.js',
  'applyPosOcrData': 'app/importer.js',
  'importFromJSON': 'app/importer.js',

  // ui
  'showResult': 'ui/result.js',
  'applyTheme': 'ui/theme.js',
  'initThemeSelector': 'ui/theme.js',
  'openSettingsModal': 'ui/theme.js',
  'closeSettingsModal': 'ui/theme.js',
  'updateSetting': 'ui/theme.js',
  'openTutorialModal': 'ui/theme.js',
  'closeTutorialModal': 'ui/theme.js',
};

// 所有函数与声明都必须有归属（死代码除外）
const missing = [...funcs.keys(), ...decls.keys()]
  .filter(n => !MAP[n] && !DEAD.includes(n) && !GLOBALS.includes(n));
if (missing.length) {
  throw new Error(`以下名字没有归属模块，拒绝产出半成品：\n  ${[...new Set(missing)].join('\n  ')}`);
}

// ── 模块内容生成 ──────────────────────────────────────────────────────

/** 取 `const X = <expr>;` 里的 <expr>。 */
function declValue(name) {
  const t = decls.get(name).trim();
  const eq = t.indexOf('=');
  return t.slice(eq + 1).replace(/;\s*$/, '').trim();
}

const moduleUnits = new Map(); // module -> [{name, kind, text}]
const ensure = (m) => { if (!moduleUnits.has(m)) moduleUnits.set(m, []); return moduleUnits.get(m); };

// 数据模块
ensure('data/characters.js').push({ name: 'CHARACTER_DATA', kind: 'decl', text: decls.get('CHARACTER_DATA') });
ensure('data/suits.js').push({ name: 'SUIT_NAME_MAP', kind: 'decl', text: `const SUIT_NAME_MAP = ${JSON.stringify(buildSuitNameMap(), null, 4)};` });
for (const n of ['ENTRY_NAMES', 'SUBSTAT_SPECIAL_WEIGHTS', 'MAIN_ENTRY_CONFIG', 'MAIN_PROB_WEIGHTS', 'MAIN_ATTR_TO_SUB']) {
  ensure('data/game-config.js').push({ name: n, kind: 'decl', text: decls.get(n) });
}
for (const n of ['ENKA_ID_MAP', 'MAIN_STAT_NAME_MAP', 'SUBSTAT_INDEX_MAP']) {
  ensure('data/enka-mapping.js').push({ name: n, kind: 'decl', text: decls.get(n) });
}
ensure('data/themes.js').push({ name: 'themes', kind: 'decl', text: decls.get('themes') });
ensure('data/localization.js').push({ name: 'LOC_ZH_CN', kind: 'decl', text: decls.get('LOC_ZH_CN') });
ensure('data/tutorial.js').push({ name: 'tutorialText', kind: 'decl', text: decls.get('tutorialText') });

// 函数与其余声明按 MAP 归位
for (const [name, mod] of Object.entries(MAP)) {
  if (moduleUnits.get(mod)?.some(u => u.name === name)) continue;
  if (funcs.has(name)) ensure(mod).push({ name, kind: 'func', text: funcs.get(name) });
  else if (decls.has(name)) ensure(mod).push({ name, kind: 'decl', text: decls.get(name) });
}

// ── 依赖解析：给每个模块算 import ─────────────────────────────────────

const ALL_NAMES = [...new Set([...funcs.keys(), ...decls.keys(), ...GLOBALS])].filter(n => !DEAD.includes(n));

/** 一个单元引用了哪些名字（排除自身声明）。 */
function refsOf(text, selfName) {
  const out = new Set();
  for (const n of ALL_NAMES) {
    if (n === selfName) continue;
    const esc = n.replace(/\$/g, '\\$');
    // 前面不能是标识符字符，也不能是「成员访问的点」。
    // 但展开符 `...X` 的点不是成员访问——`[...MAIN_ENTRY_CONFIG[pos]]` 必须算引用。
    // 所以匹配到点时要回看：连续 3 个点说明是展开符。
    const re = new RegExp(`(^|[^\\w$])${esc}(?![\\w$])`, 'g');
    let hit = false;
    for (const m of text.matchAll(re)) {
      const prev = m[0][0] === n[0] ? '' : m[0][0];
      if (prev !== '.') { hit = true; break; }
      const dotStart = m.index + (m[0].length - n.length - 1);
      if (text.slice(Math.max(0, dotStart - 2), dotStart + 1) === '...') { hit = true; break; }
    }
    if (hit) out.add(n);
  }
  return out;
}

/**
 * 把全局可变引用改写成 state.x。
 *
 * 必须跳过字符串、模板串与注释——否则 `'settings-toggle-btn'` 这种 DOM id 会被
 * 改成 `'state.settings-toggle-btn'`，页面按 id 找不到元素，静默失效。
 */
function rewriteGlobals(text) {
  let out = '';
  let i = 0;
  const isIdent = (ch) => /[\w$]/.test(ch || '');

  while (i < text.length) {
    const c = text[i];
    const c2 = text[i + 1];

    if (c === '/' && c2 === '/') {
      const end = text.indexOf('\n', i);
      const stop = end < 0 ? text.length : end;
      out += text.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === '/' && c2 === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      out += text.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === c) { j++; break; }
        j++;
      }
      out += text.slice(i, j);
      i = j;
      continue;
    }

    const hit = GLOBALS.find(g => text.startsWith(g, i));
    if (hit && !isIdent(text[i - 1]) && text[i - 1] !== '.' && !isIdent(text[i + hit.length])) {
      out += 'state.' + hit;
      i += hit.length;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function relImport(fromMod, toMod) {
  let rel = path.relative(path.dirname(fromMod), toMod).replace(/\\/g, '/');
  if (!rel.startsWith('.')) rel = './' + rel;
  return rel;
}

const HEADERS = {
  'data/characters.js': '// 角色表：19 个阵营 / 59 个角色 / 每个角色 10 项副词条权重。\n// 数据从 index.html 机械提取，未做改写。',
  'data/suits.js': '// 套装 ID（装备 Id 的前三位）→ 中文套装名。\n// 原实现是从 LOC_ZH_CN 的键里筛 EquipmentSuit_*_name 现算的，这里拆在构建期算好写成常量，\n// 运行时少一段顶层循环。',
  'data/game-config.js': '// 词条与主词条配置：名称表、副词条权重、各位号可选主词条与出现概率、主副词条冲突映射。',
  'data/enka-mapping.js': '// Enka API 的 ID → 站内名称映射。导入角色数据时用。',
  'data/themes.js': '// 23 套配色。',
  'data/localization.js': '// Enka 的本地化表（简体中文），约 1.4 万字符。',
  'data/tutorial.js': '// 使用教程的 HTML 片段。',
  'domain/probability.js': '// 概率计算核心。纯函数：不碰 DOM、不读全局状态，同样的入参永远同样的结果。',
  'domain/format.js': '// 纯展示格式化：数值 → 带图标的成本文本、配色 → rgb 三元组。',
  'domain/characters.js': '// 角色查找。数据通过参数注入，因此不绑定任何一份数据源。',
  'app/store.js': '// 应用状态。原先是散落在脚本顶部的 6 个可变全局，全部收进这一个对象，\n// 谁在读、谁在写都从这里能查清。',
  'app/positions.js': '// 单个驱动盘位置的状态读取与评分。',
  'app/entries.js': '// 词条录入区的构建与联动：主词条下拉、副词条权重、定向词条。',
  'app/character-panel.js': '// 角色面板：阵营页签、角色卡、每个角色的位置配置与存档选择器。',
  'app/game-calc.js': '// 游戏版计算：读面板 → 逐个主词条算概率 → 渲染结果与推荐。',
  'app/custom-calc.js': '// 自定义版计算：手工填词条与库存，单次试算。',
  'app/saves.js': '// 档位存取：localStorage 读写、存档命名/重命名/删除。',
  'app/importer.js': '// 从 Enka API 的 JSON 导入角色数据。',
  'ui/result.js': '// 结果区渲染。',
  'ui/theme.js': '// 配色、设置弹窗、教程弹窗。',
  'main.js': '// 入口：绑定顶部按钮、页签切换、存档选择器联动，并在 DOM 就绪后初始化。',
};

const out = new Map();
for (const [mod, unitsInMod] of moduleUnits) {
  const selfNames = new Set(unitsInMod.map(u => u.name));
  const needByMod = new Map();

  for (const u of unitsInMod) {
    // 数据模块里的字面量不引用别的模块
    if (mod.startsWith('data/')) continue;
    for (const r of refsOf(u.text, u.name)) {
      if (selfNames.has(r)) continue;
      const target = MAP[r] || (GLOBALS.includes(r) ? 'app/store.js' : null);
      if (!target) continue; // 已是死代码，不可能引用
      if (target === mod) { selfNames.add(r); continue; }
      if (!needByMod.has(target)) needByMod.set(target, new Set());
      // 全局可变状态统一从 state 取，不按原名 import
      needByMod.get(target).add(GLOBALS.includes(r) ? 'state' : r);
    }
    // 全局引用的模块：只要有改写就说明要 store
    if (!mod.endsWith('store.js') && GLOBALS.some(g => new RegExp(`(^|[^\\w$.])${g}(?![\\w$])`).test(u.text))) {
      if (!needByMod.has('app/store.js')) needByMod.set('app/store.js', new Set());
      needByMod.get('app/store.js').add('state');
    }
  }

  const importLines = [];
  for (const [target, names] of [...needByMod].sort((a, b) => a[0].localeCompare(b[0]))) {
    const list = [...names].sort();
    const spec = relImport(mod, target);
    if (list.length <= 3) importLines.push(`import { ${list.join(', ')} } from '${spec}';`);
    else importLines.push(`import {\n  ${list.join(',\n  ')},\n} from '${spec}';`);
  }

  const body = unitsInMod.map(u => {
    const text = mod.startsWith('data/') ? u.text : rewriteGlobals(u.text);
    if (mod.startsWith('data/')) return text.replace(/^(const|let|var)\s+/, 'export const ');
    if (u.kind === 'func') return 'export ' + text;
    if (u.kind === 'decl' && !GLOBALS.includes(u.name)) return 'export ' + text;
    return text;
  }).join('\n\n');

  const header = HEADERS[mod] || '';
  out.set(mod, [header, importLines.join('\n'), body].filter(Boolean).join('\n\n') + '\n');
}

// store.js 要额外导出 state，并且把 settings 的初始化搬进来
out.set('app/store.js', `import { applyTheme } from '../ui/theme.js';

${HEADERS['app/store.js']}

export const state = {
  /** 当前选中的角色（顺序即面板顺序，索引会变，不要当身份用）。 */
  gameSelectedChars: [],
  /** 上次导入的角色名，用于「一键保存」。 */
  lastImportedChars: [],
  /** 角色面板的 DOM 片段缓存，键是角色名。 */
  charConfigsCache: {},
  /** 上一次游戏版计算的过程数据，用于推荐文案。 */
  extractionList: [],
  /** 用户设置，持久化在 localStorage 的 zzz_calc_settings。 */
  settings: {
    autoCollapseImport: true,
    autoCollapseOutput: true,
  },
};

// 读取设置。原来的写法是顶层 try/catch 吞掉异常，这里保留同样的语义：
// 存档坏了就当没有，不让页面白屏——但不再完全无声，出问题会在控制台留一行。
try {
  const raw = localStorage.getItem('zzz_calc_settings');
  if (raw) Object.assign(state.settings, JSON.parse(raw));
} catch (e) {
  console.warn('设置读取失败，使用默认值：', e);
}

export function saveSettings() {
  localStorage.setItem('zzz_calc_settings', JSON.stringify(state.settings));
}
`);

// ── 入口 ──────────────────────────────────────────────────────────────

/**
 * 静态标记与运行时拼接字符串里的内联处理器（onclick="calculateGame()"）。
 *
 * ES module 有自己的作用域，模块顶层声明的函数不会变成全局变量，内联处理器在
 * window 上找不到它们——点了没反应，而且控制台一片安静，这是最难查的一类回归。
 * 所以这里扫出所有被内联调用的函数名，在入口统一挂回 window。
 *
 * 这是「保持现有 HTML 不动」的代价。真正的解法是把内联处理器换成 data-* +
 * 事件委托，那属于后续重构，不在「只搬运不改写」的范围内。
 */
const INLINE_HANDLERS = (() => {
  const names = new Set();
  const re = /on[a-z]+\s*=\s*"([^"]*)"/g;
  for (const m of html.matchAll(re)) {
    for (const call of m[1].matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) names.add(call[1]);
  }
  return [...names].filter(n => MAP[n]).sort();
})();

/** 已被专门处理、不需要再归入模块的顶层语句。 */
const HANDLED_STMTS = [
  // 读设置：手写进了 app/store.js（连带 state 声明一起）。
  /localStorage\.getItem\('zzz_calc_settings'\)/,
  // 从 LOC_ZH_CN 派生套装名：构建期已算成 data/suits.js 的字面量。
  /for \(const key in LOC_ZH_CN\)/,
];

const BINDINGS = stmts.filter(s => /addEventListener|\.onclick\s*=|window\.onload/.test(s));
const OTHER_STMTS = stmts.filter(s => !BINDINGS.includes(s) && !HANDLED_STMTS.some(re => re.test(s)));

const bindingRefs = new Set();
for (const b of BINDINGS) for (const r of refsOf(b, null)) bindingRefs.add(r);

const bindingImports = new Map();
for (const r of bindingRefs) {
  const target = MAP[r] || (GLOBALS.includes(r) ? 'app/store.js' : null);
  if (!target) continue;
  if (!bindingImports.has(target)) bindingImports.set(target, new Set());
  bindingImports.get(target).add(GLOBALS.includes(r) ? 'state' : r);
}
for (const n of INLINE_HANDLERS) {
  const target = MAP[n];
  if (!bindingImports.has(target)) bindingImports.set(target, new Set());
  bindingImports.get(target).add(n);
}
const mainImportLines = [...bindingImports]
  .sort((a, b) => a[0].localeCompare(b[0]))
  .map(([target, names]) => {
    const list = [...names].sort();
    const spec = relImport('main.js', target);
    return list.length <= 3
      ? `import { ${list.join(', ')} } from '${spec}';`
      : `import {\n  ${list.join(',\n  ')},\n} from '${spec}';`;
  });

out.set('main.js', `// 入口。绑定事件、启动应用。
// 原先是 <script> 末尾的若干条顶层语句，现在收拢到这里，加载顺序一目了然。

${mainImportLines.join('\n')}

${BINDINGS.map(b => rewriteGlobals(b)).join('\n\n')}

/**
 * 把内联处理器要用到的函数挂回 window。
 *
 * 静态标记里写的是 onclick="calculateGame()"，这类属性在全局作用域求值。模块里的
 * 函数不是全局的，所以必须显式暴露，否则按钮全部失灵且不报错（见 split.mjs 注释）。
 * 后续把内联写法换掉之后，这一段可以整块删除。
 */
Object.assign(window, {
${INLINE_HANDLERS.map(n => '  ' + n + ',').join('\n')}
});
`);

// ── CSS ───────────────────────────────────────────────────────────────

const cssLines = lines.slice(STYLE_OPEN + 1, STYLE_CLOSE);
const indent = Math.min(...cssLines.filter(l => l.trim()).map(l => l.match(/^\s*/)[0].length));
const css = cssLines.map(l => l.slice(indent)).join('\n').trim() + '\n';

// ── HTML 骨架 ─────────────────────────────────────────────────────────

const headPart = lines.slice(0, STYLE_OPEN);
const tailPart = lines.slice(STYLE_CLOSE + 1, SCRIPT_OPEN);
const afterScript = lines.slice(SCRIPT_CLOSE + 1);

const skeleton = ([
  ...headPart,
  '    <link rel="stylesheet" href="./src/styles/base.css">',
  ...tailPart,
  '    <script type="module" src="./src/main.js"></script>',
  ...afterScript,
].join('\n'));

// ── 写出 ──────────────────────────────────────────────────────────────

function write(rel, content) {
  const abs = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

// 模块内容与 CSS 里的图片引用已在源仓库改成 assets/ 下的新路径，
// 这里只负责把被引用的文件带过去，产物因此自包含。
for (const [mod, content] of out) write(mod, content);
write('styles/base.css', css);
fs.writeFileSync(path.join(ROOT, 'index.html'), skeleton, 'utf8');

// 图片不在这里拷。源资产就放在仓库根的 assets/ 下，由 tools/build.mjs 在
// 构建时连同 HTML/JS/CSS 一起收进 dist/——否则同一个 4MB 图片会在 src/ 和
// assets/ 各存一份，改一张图要记得改两处。

const report = [['index.html（仓库根）', skeleton], ['styles/base.css', css], ...[...out]];
log('\n已写出到 ' + path.relative(ROOT, OUT || '.') + '：');
for (const [f, c] of report) log(`  ${f.padEnd(30)} ${String(c.split('\n').length - 1).padStart(4)} 行`);
if (OTHER_STMTS.length) {
  log('\n未归入任何模块的裸语句（需人工处理）：');
  for (const s of OTHER_STMTS) log('  ' + s.slice(0, 100).replace(/\n/g, ' ⏎ '));
}
