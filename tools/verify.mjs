#!/usr/bin/env node
/**
 * verify.mjs — 证明拆分产物与原 index.html 行为逐位等价
 *
 * 三类断言：
 *   A. 数据等价：JSON 产物 deepEqual 原脚本里的常量运行时值
 *   B. 算法等价：对同一批输入，产物模块与原函数返回的每个字段 Object.is 相等
 *   C. 覆盖度：确认拆分清单里每一项都真的被搬走了，死代码确认未搬
 *
 * 算法等价用两层输入：
 *   1. 固定用例（覆盖边界：库存为 0、目标已达成、定向、剩 1 个词条…）
 *   2. 模糊测试（固定种子伪随机，200 组），失败即报告具体输入
 *
 * 用法：node tools/verify.mjs [--samples 200]
 * 退出码 0 = 全通过；1 = 有断言失败。
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const BUILD = path.join(ROOT, 'build');
const SRC_HTML = path.join(ROOT, 'index.html');

const args = process.argv.slice(2);
const sIdx = args.indexOf('--samples');
const SAMPLES = sIdx >= 0 ? parseInt(args[sIdx + 1], 10) : 200;

// ─────────────────────────────────────────────────────────────
// 提取原脚本（与 split-index.mjs 同算法，保证基准一致）
// ─────────────────────────────────────────────────────────────

const html = fs.readFileSync(SRC_HTML, 'utf8');
const lines = html.split('\n');
const scriptOpen = lines.findIndex(l => /^\s*<script>\s*$/.test(l));
const scriptClose = lines.findIndex(l => /^\s*<\/script>\s*$/.test(l));
const styleOpen = lines.findIndex(l => /^\s*<style>\s*$/.test(l));
const styleClose = lines.findIndex(l => /^\s*<\/style>\s*$/.test(l));
const scriptText = lines.slice(scriptOpen + 1, scriptClose).join('\n');

function extractDeclaration(source, name) {
  const re = new RegExp(`^(\\s*)const\\s+${name}\\s*=`, 'm');
  const m = re.exec(source);
  if (!m) return null;
  const start = m.index;
  let i = m.index + m[0].length;
  let depth = 0, inStr = null, inTemplate = false, inLine = false, inBlock = false;
  for (; i < source.length; i++) {
    const c = source[i], next = source[i + 1];
    if (inLine) { if (c === '\n') inLine = false; continue; }
    if (inBlock) { if (c === '*' && next === '/') { inBlock = false; i++; } continue; }
    if (inStr) { if (c === '\\') { i++; continue; } if (c === inStr) inStr = null; continue; }
    if (inTemplate) { if (c === '\\') { i++; continue; } if (c === '`') inTemplate = false; continue; }
    if (c === '/' && next === '/') { inLine = true; i++; continue; }
    if (c === '/' && next === '*') { inBlock = true; i++; continue; }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === '`') { inTemplate = true; continue; }
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
    else if (c === ';' && depth === 0) { i++; break; }
  }
  return source.slice(start, i);
}

function extractFunction(source, name) {
  const re = new RegExp(`^(\\s*)(?:async\\s+)?function\\s+${name}\\s*\\(`, 'm');
  const m = re.exec(source);
  if (!m) return null;
  const start = m.index;
  let i = source.indexOf('{', m.index);
  if (i < 0) return null;
  let depth = 0, inStr = null, inTemplate = false, inLine = false, inBlock = false;
  for (; i < source.length; i++) {
    const c = source[i], next = source[i + 1];
    if (inLine) { if (c === '\n') inLine = false; continue; }
    if (inBlock) { if (c === '*' && next === '/') { inBlock = false; i++; } continue; }
    if (inStr) { if (c === '\\') { i++; continue; } if (c === inStr) inStr = null; continue; }
    if (inTemplate) { if (c === '\\') { i++; continue; } if (c === '`') inTemplate = false; continue; }
    if (c === '/' && next === '/') { inLine = true; i++; continue; }
    if (c === '/' && next === '*') { inBlock = true; i++; continue; }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === '`') { inTemplate = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return source.slice(start, i);
}

// 把原脚本的算法部分拼成一个可求值单元，取出函数对象
const ALGO_CONSTS = ['Achance', 'Bchance', 'Atimes', 'Btimes'];
const ALGO_FUNCS = ['parseNumber', 'dfsUp', 'passChance', 'firstGroup', 'calculateCore', 'calculateCoreGame'];

function buildOriginalRuntime() {
  const parts = [];
  for (const n of ALGO_CONSTS) {
    const d = extractDeclaration(scriptText, n);
    if (!d) throw new Error(`原文件缺少 ${n}`);
    parts.push(d);
  }
  for (const n of ALGO_FUNCS) {
    const f = extractFunction(scriptText, n);
    if (!f) throw new Error(`原文件缺少函数 ${n}`);
    parts.push(f);
  }
  parts.push(`;__api = { ${[...ALGO_CONSTS, ...ALGO_FUNCS].join(', ')} };`);

  const sandbox = { __api: null };
  vm.createContext(sandbox);
  vm.runInContext(parts.join('\n'), sandbox, { timeout: 20000 });
  return sandbox.__api;
}

// ─────────────────────────────────────────────────────────────
// 断言工具
// ─────────────────────────────────────────────────────────────

const failures = [];
const pendingAsync = [];
let checks = 0;

function check(name, fn) {
  checks++;
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      // 异步断言：登记到 pendingAsync，稍后统一 await 并计入结果
      pendingAsync.push(
        r.then(
          () => { console.log(`  ✓ ${name}`); },
          e => { failures.push({ name, message: e.message }); console.log(`  ✗ ${name}\n      ${e.message}`); }
        )
      );
      return;
    }
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures.push({ name, message: e.message });
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}

function eq(a, b, label = '') {
  if (!Object.is(a, b)) {
    throw new Error(`${label} 期望 ${formatNum(b)}，实际 ${formatNum(a)}`);
  }
}

function formatNum(x) {
  if (typeof x !== 'number') return JSON.stringify(x);
  return Number.isFinite(x) ? x.toPrecision(17) : String(x);
}

function deepEqual(a, b, pathStr = '$') {
  if (Object.is(a, b)) return;
  if (typeof a !== typeof b) throw new Error(`${pathStr}: 类型不同 ${typeof a} vs ${typeof b}`);
  if (a === null || b === null) throw new Error(`${pathStr}: ${a} vs ${b}`);
  if (Array.isArray(a) !== Array.isArray(b)) throw new Error(`${pathStr}: 一个数组一个不是`);
  if (Array.isArray(a)) {
    if (a.length !== b.length) throw new Error(`${pathStr}: 长度 ${a.length} vs ${b.length}`);
    for (let i = 0; i < a.length; i++) deepEqual(a[i], b[i], `${pathStr}[${i}]`);
    return;
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    if (ka.join() !== kb.join()) throw new Error(`${pathStr}: 键集不同 [${ka}] vs [${kb}]`);
    for (const k of ka) deepEqual(a[k], b[k], `${pathStr}.${k}`);
    return;
  }
  throw new Error(`${pathStr}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}

// ─────────────────────────────────────────────────────────────
// A. 数据等价
// ─────────────────────────────────────────────────────────────

console.log('\nA. 数据等价（JSON 产物 vs 原脚本常量）\n');

const DATA_CONSTS = {
  'characters.json': ['CHARACTER_DATA'],
  'game-config.json': ['MAIN_ENTRY_CONFIG', 'MAIN_PROB_WEIGHTS', 'MAIN_ATTR_TO_SUB', 'SUBSTAT_SPECIAL_WEIGHTS', 'ENTRY_NAMES', 'ENTRY_IDX_MAP'],
  'enka-mapping.json': ['ENKA_ID_MAP', 'MAIN_STAT_NAME_MAP', 'SUBSTAT_INDEX_MAP'],
  'themes.json': ['themes'],
  'localization.zh-CN.json': ['LOC_ZH_CN'],
};

function evalDecl(declSrc) {
  const name = /^\s*const\s+(\w+)\s*=/.exec(declSrc)[1];
  const sandbox = { __out: undefined };
  vm.createContext(sandbox);
  vm.runInContext(`${declSrc}\n;__out = ${name};`, sandbox, { timeout: 10000 });
  return sandbox.__out;
}

for (const [filename, names] of Object.entries(DATA_CONSTS)) {
  const jsonPath = path.join(BUILD, 'src', 'data', filename);
  check(`${filename} 存在且可解析`, () => {
    if (!fs.existsSync(jsonPath)) throw new Error('文件不存在');
    JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  });

  const bundle = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  for (const name of names) {
    check(`${filename} → ${name} 深度相等`, () => {
      const decl = extractDeclaration(scriptText, name);
      if (!decl) throw new Error(`原文件找不到 ${name}`);
      const original = evalDecl(decl);
      if (!(name in bundle)) throw new Error(`产物的 JSON 里没有键 ${name}`);
      deepEqual(bundle[name], original, name);
    });
  }
}

// ─────────────────────────────────────────────────────────────
// B. 算法等价
// ─────────────────────────────────────────────────────────────

console.log('\nB. 算法等价（产物模块 vs 原函数）\n');

const original = buildOriginalRuntime();
const domainUrl = pathToFileURL(path.join(BUILD, 'src', 'domain', 'probability.js')).href;
const domain = await import(domainUrl);

check('产物模块导出全部成员', () => {
  const missing = [...ALGO_CONSTS, ...ALGO_FUNCS].filter(n => !(n in domain));
  if (missing.length) throw new Error(`缺少导出：${missing.join(', ')}`);
});

check('常量值一致', () => {
  for (const n of ALGO_CONSTS) eq(domain[n], original[n], n);
});

// 固定用例：每个都是 { label, types, goal, scaleFactor, directed }
function mkTypes(spec) {
  // spec: [{rest, score, specialWeight, typeIndex?}]
  return spec.map((t, i) => ({
    typeIndex: t.typeIndex ?? i,
    score: t.score,
    rest: t.rest,
    specialWeight: t.specialWeight,
  }));
}

const FIXED_CASES = [
  {
    label: '典型 10 词条 / 目标 12',
    types: mkTypes(Array.from({ length: 10 }, (_, i) => ({ rest: 8, score: (i % 3) * 0.4, specialWeight: [10,10,9,9,8,10,10,8,8,8][i] }))),
    goal: 12, scaleFactor: 1 / 6,
  },
  {
    label: '目标已达成（goal 极小）',
    types: mkTypes(Array.from({ length: 6 }, (_, i) => ({ rest: 5, score: 1 + i * 0.1, specialWeight: 10 }))),
    goal: 0.5, scaleFactor: 1,
  },
  {
    label: '库存刚好 4 个',
    types: mkTypes([{ rest: 4, score: 0.5, specialWeight: 10 }, { rest: 0, score: 0.5, specialWeight: 8 }, { rest: 0, score: 0.3, specialWeight: 9 }]),
    goal: 2, scaleFactor: 1 / 6,
  },
  {
    label: '库存不足 4 个（应返回 0 而非崩溃）',
    types: mkTypes([{ rest: 1, score: 0.5, specialWeight: 10 }, { rest: 1, score: 0.2, specialWeight: 8 }]),
    goal: 2, scaleFactor: 1,
  },
  {
    label: '单一种类库存充足（高分）',
    types: mkTypes([{ rest: 10, score: 3, specialWeight: 10 }]),
    goal: 6, scaleFactor: 1,
  },
  {
    label: '带定向词条',
    types: mkTypes(Array.from({ length: 10 }, (_, i) => ({ rest: 6, score: (i % 4) * 0.5, specialWeight: [10,10,9,9,8,10,10,8,8,8][i] }))),
    goal: 10, scaleFactor: 1 / 60, directedTypes: [2, 7],
  },
  {
    label: '定向词条不存在于池中（结果应为 0）',
    types: mkTypes(Array.from({ length: 5 }, (_, i) => ({ rest: 6, score: 1, specialWeight: 10 }))),
    goal: 4, scaleFactor: 1, directedTypes: [99],
  },
  {
    label: '分数为小数（浮点路径）',
    types: mkTypes(Array.from({ length: 8 }, (_, i) => ({ rest: 7, score: 0.1 * (i + 1), specialWeight: 9 }))),
    goal: 1.7, scaleFactor: 1 / 36,
  },
  {
    label: '分数为 0（全零权重）',
    types: mkTypes(Array.from({ length: 6 }, () => ({ rest: 5, score: 0, specialWeight: 10 }))),
    goal: 1, scaleFactor: 1,
  },
];

for (const c of FIXED_CASES) {
  check(`calculateCore — ${c.label}`, () => {
    const a = domain.calculateCore(structuredClone(c.types), c.goal, c.scaleFactor, c.directedTypes ?? []);
    const b = original.calculateCore(structuredClone(c.types), c.goal, c.scaleFactor, c.directedTypes ?? []);
    for (const k of ['mchanceA', 'mchanceB', 'chance', 'scaledChance']) eq(a[k], b[k], k);
  });
  check(`calculateCoreGame — ${c.label}`, () => {
    const a = domain.calculateCoreGame(structuredClone(c.types), c.goal, c.scaleFactor, c.directedTypes ?? []);
    const b = original.calculateCoreGame(structuredClone(c.types), c.goal, c.scaleFactor, c.directedTypes ?? []);
    for (const k of ['mchanceA', 'mchanceB', 'chance', 'scaledChance']) eq(a[k], b[k], k);
  });
}

check('parseNumber 全分支一致', () => {
  const cases = ['', '  ', '12', '12.5', '25/2', '1/6', '1/0', 'abc', '1/2/3', ' 3 / 4 ', '-5', '0'];
  for (const s of cases) {
    const a = domain.parseNumber(s), b = original.parseNumber(s);
    if (Number.isNaN(a) && Number.isNaN(b)) continue;
    eq(a, b, `parseNumber(${JSON.stringify(s)})`);
  }
});

check('passChance 一致', () => {
  const group = mkTypes([{ rest: 9, score: 0.6, specialWeight: 10 }, { rest: 9, score: 0.3, specialWeight: 8 }, { rest: 9, score: 1.2, specialWeight: 9 }]);
  for (const [times, need] of [[5, 2], [4, 1.5], [5, 0], [4, 3.6]]) {
    eq(domain.passChance(times, need, group), original.passChance(times, need, group), `passChance(${times}, ${need})`);
  }
});

// ─────────────────────────────────────────────────────────────
// B2. 模糊测试（固定种子，保证可复现）
// ─────────────────────────────────────────────────────────────

check(`模糊测试 ${SAMPLES} 组随机输入全部逐位相等`, () => {
  let seed = 0xC0FFEE;
  const rnd = () => {
    // xorshift32
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5; seed >>>= 0;
    return seed / 0x100000000;
  };
  const pick = arr => arr[Math.floor(rnd() * arr.length)];

  for (let n = 0; n < SAMPLES; n++) {
    const typeCount = 1 + Math.floor(rnd() * 7);      // 1..7 种
    const types = [];
    for (let i = 0; i < typeCount; i++) {
      types.push({
        typeIndex: i,
        score: Math.round(rnd() * 8) / 2,            // 0, 0.5, ... 4
        rest: Math.floor(rnd() * 12),                // 0..11
        specialWeight: pick([8, 9, 10]),
      });
    }
    const totalRest = types.reduce((s, t) => s + t.rest, 0);
    const goal = Math.round(rnd() * 24) / 2;
    const scaleFactor = pick([1, 1 / 6, 1 / 36, 1 / 60]);
    const useDirect = rnd() < 0.3;
    const directedTypes = useDirect ? [Math.floor(rnd() * (typeCount + 1))] : [];

    for (const fnName of ['calculateCore', 'calculateCoreGame']) {
      const a = domain[fnName](structuredClone(types), goal, scaleFactor, directedTypes);
      const b = original[fnName](structuredClone(types), goal, scaleFactor, directedTypes);
      for (const k of ['mchanceA', 'mchanceB', 'chance', 'scaledChance']) {
        if (!Object.is(a[k], b[k])) {
          throw new Error(
            `第 ${n} 组 ${fnName} 的 ${k} 不等\n` +
            `  输入 types=${JSON.stringify(types)}\n` +
            `  goal=${goal} scaleFactor=${scaleFactor} directed=${JSON.stringify(directedTypes)}\n` +
            `  产物=${formatNum(a[k])} 原始=${formatNum(b[k])}\n` +
            `  （总库存 ${totalRest}）`
          );
        }
      }
    }
  }
});

// ─────────────────────────────────────────────────────────────
// C. 覆盖度 / 死代码
// ─────────────────────────────────────────────────────────────

console.log('\nC. 覆盖度与死代码\n');

/** 去掉 JS 注释（含字符串内的 // 不误伤：这里只需保守处理，够用即可）。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(l => !/^\s*\/\//.test(l))
    .join('\n');
}

check('domain/probability.js 的代码正文不含 DOM 引用', () => {
  // 注意：必须剥掉注释再扫，否则自己写的「不依赖 localStorage」这句注释会被误判。
  const src = stripComments(fs.readFileSync(path.join(BUILD, 'src', 'domain', 'probability.js'), 'utf8'));
  const hits = ['document.', 'window.', 'localStorage', 'alert(', 'innerHTML']
    .filter(tok => src.includes(tok));
  if (hits.length) throw new Error(`发现 DOM 依赖：${hits.join(', ')}`);
});

check('在删除全部 DOM 全局变量的进程里调用模块仍正常', async () => {
  const { execFileSync } = await import('node:child_process');
  const probe = path.join(BUILD, '.dsh-probe-noDom.mjs');
  fs.writeFileSync(probe, `
    // 硬删 DOM 全局，模拟纯 Node 环境
    for (const k of ['document','window','localStorage','sessionStorage','alert','fetch','navigator']) {
      try { delete globalThis[k]; } catch {}
      if (k in globalThis) throw new Error('无法删除全局 ' + k);
    }
    const m = await import(${JSON.stringify(pathToFileURL(path.join(BUILD, 'src', 'domain', 'probability.js')).href)});
    const types = Array.from({length: 10}, (_, i) => ({
      typeIndex: i, score: (i % 3) * 0.4, rest: 8, specialWeight: 10
    }));
    // 目标分必须可达：score ∈ {0, 0.4, 0.8}，4 个词条上限 3.2，故 goal 取 2。
    // 若 goal 超出可达上限，两套算法都会返回 0，探针会假绿/假红（踩过这个坑）。
    const r = m.calculateCoreGame(types, 2, 1/6, []);
    if (!(r.chance > 0 && r.chance < 1)) throw new Error('计算结果不合理：' + r.chance);
    console.log('OK ' + r.chance.toPrecision(17));
  `, 'utf8');
  try {
    const out = execFileSync(process.execPath, [probe], { encoding: 'utf8', timeout: 30000 }).trim();
    if (!out.startsWith('OK ')) throw new Error(`探针输出异常：${out}`);
  } finally {
    fs.rmSync(probe, { force: true });
  }
});

check('数据产物不含死代码 LOC_ZH_TW', () => {
  const files = fs.readdirSync(path.join(BUILD, 'src', 'data'));
  for (const f of files) {
    const content = fs.readFileSync(path.join(BUILD, 'src', 'data', f), 'utf8');
    if (content.includes('LOC_ZH_TW')) throw new Error(`${f} 里出现了 LOC_ZH_TW`);
  }
});

check('LOC_ZH_CN 与 LOCALIZATION 内容量级合理（非空且 > 10KB）', () => {
  const loc = JSON.parse(fs.readFileSync(path.join(BUILD, 'src', 'data', 'localization.zh-CN.json'), 'utf8'));
  const size = JSON.stringify(loc.LOC_ZH_CN).length;
  if (size < 10000) throw new Error(`LOC_ZH_CN 序列化后仅 ${size} 字节，疑似残缺`);
});

check('characters.json 含 59 个角色且每个 weights 长度为 10', () => {
  const data = JSON.parse(fs.readFileSync(path.join(BUILD, 'src', 'data', 'characters.json'), 'utf8'));
  const roles = data.CHARACTER_DATA.flatMap(f => f.roles);
  if (roles.length !== 59) throw new Error(`角色数 ${roles.length}，期望 59`);
  const bad = roles.filter(r => !Array.isArray(r.weights) || r.weights.length !== 10);
  if (bad.length) throw new Error(`weights 长度异常：${bad.map(r => r.name).join(', ')}`);
});

check('产物自包含：build/ 下无符号链接，图片是逐字节拷贝的真文件', () => {
  const links = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) links.push(path.relative(BUILD, p));
      else if (e.isDirectory()) walk(p);
    }
  })(BUILD);
  if (links.length) throw new Error(`build/ 下存在符号链接：${links.slice(0, 5).join(', ')}`);

  // 图片必须与源文件逐字节相同：拷贝而不是软链，且没拷错/拷漏。
  const ASSET_EXT = /\.(png|jpe?g|gif|svg|webp|ico)$/i;
  const assets = fs.readdirSync(ROOT).filter(f => ASSET_EXT.test(f));
  const missing = [], differ = [];
  for (const f of assets) {
    const dst = path.join(BUILD, f);
    if (!fs.existsSync(dst)) { missing.push(f); continue; }
    if (!fs.readFileSync(dst).equals(fs.readFileSync(path.join(ROOT, f)))) differ.push(f);
  }
  if (missing.length) throw new Error(`build/ 缺图片：${missing.slice(0, 5).join(', ')}`);
  if (differ.length) throw new Error(`build/ 图片与源文件不一致：${differ.slice(0, 5).join(', ')}`);
});

// ─────────────────────────────────────────────────────────────
// D. HTML 骨架结构等价
// ─────────────────────────────────────────────────────────────

console.log('\nD. HTML 骨架结构等价\n');

const skelLines = fs.readFileSync(path.join(BUILD, 'index.html'), 'utf8').split('\n');

check('骨架含完整 head/body 闭合', () => {
  const src = skelLines.join('\n');
  for (const tag of ['<html', '</head>', '<body', '</body>', '</html>']) {
    if (!src.includes(tag)) throw new Error(`缺少 ${tag}`);
  }
});

check('骨架不再含内联 <style> / <script>', () => {
  const src = skelLines.join('\n');
  if (/<style>/.test(src)) throw new Error('仍有内联 <style>');
  if (/<script>/.test(src)) throw new Error('仍有内联 <script>');
  if (!/rel="stylesheet" href="\.\/src\/ui\/styles\.css"/.test(src)) throw new Error('缺少 css 外链');
  if (!/<script type="module" src="\.\/src\/main\.js"><\/script>/.test(src)) throw new Error('缺少 main.js 外链');
});

check('静态标记段与原文件逐字一致（id 序列 / 内联事件 / 可见文本）', () => {
  // 原文件：从 </style> 之后两行（跳过 </head>）到 <script> 之前
  const origStatic = lines.slice(styleClose + 2, scriptOpen).join('\n');
  const skelHeadEnd = skelLines.findIndex(l => /^\s*<\/head>\s*$/.test(l));
  const skelBody = skelLines.slice(skelHeadEnd + 1).join('\n');

  const idsOf = s => [...s.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  const o = idsOf(origStatic), n = idsOf(skelBody);
  if (JSON.stringify(o) !== JSON.stringify(n)) {
    throw new Error(`id 序列不同：原 ${o.length} 个，产物 ${n.length} 个`);
  }
  for (const attr of ['onclick', 'onchange', 'oninput']) {
    const c = (s) => (s.match(new RegExp(`${attr}=`, 'g')) || []).length;
    if (c(origStatic) !== c(skelBody)) throw new Error(`${attr} 数量不同：${c(origStatic)} vs ${c(skelBody)}`);
  }
  const textOf = s => s.replace(/<[^>]+>/g, '').replace(/[ \t]+/g, ' ').trim();
  if (textOf(origStatic) !== textOf(skelBody)) throw new Error('可见文本不一致');
  if (!skelBody.includes(origStatic)) throw new Error('静态标记段未逐字保留');
});

check('styles.css 覆盖原 <style> 的全部选择器', () => {
  const origCss = lines.slice(styleOpen + 1, styleClose).join('\n');
  const newCss = fs.readFileSync(path.join(BUILD, 'src', 'ui', 'styles.css'), 'utf8');
  const sel = css => new Set(
    [...css.matchAll(/^\s*([^{}@/][^{}]*)\{/gm)]
      .flatMap(m => m[1].split(','))
      .map(x => x.trim())
      .filter(Boolean)
  );
  const a = sel(origCss), b = sel(newCss);
  const missing = [...a].filter(x => !b.has(x));
  if (missing.length) throw new Error(`缺少 ${missing.length} 个选择器：${missing.slice(0, 5).join(' | ')}`);
  if (newCss.replace(/\s/g, '').length < origCss.replace(/\s/g, '').length) {
    throw new Error('CSS 去空白后变短，疑似丢规则');
  }
});

check('main.js 完整保留了原脚本（行数与关键调用点）', () => {
  const src = fs.readFileSync(path.join(BUILD, 'src', 'main.js'), 'utf8');
  const origScript = lines.slice(scriptOpen + 1, scriptClose).join('\n');
  if (!src.includes(origScript.trim())) throw new Error('原脚本未被逐字保留');
  const origNonEmpty = origScript.split('\n').filter(l => l.trim()).length;
  const newNonEmpty = src.split('\n').filter(l => l.trim()).length;
  if (newNonEmpty < origNonEmpty) throw new Error(`非空行减少：${origNonEmpty} → ${newNonEmpty}`);
});

// ─────────────────────────────────────────────────────────────
// 汇总
// ─────────────────────────────────────────────────────────────

// 等待全部异步断言完成后再判定
if (pendingAsync.length) await Promise.all(pendingAsync);

console.log('\n' + '─'.repeat(60));
if (failures.length === 0) {
  console.log(`全部通过：${checks} 项断言（含 ${SAMPLES} 组模糊测试）`);
  process.exit(0);
} else {
  console.log(`失败 ${failures.length} / ${checks} 项：`);
  for (const f of failures) console.log(`  · ${f.name}\n    ${f.message}`);
  process.exit(1);
}