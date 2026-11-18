#!/usr/bin/env node
/**
 * split-index.mjs — 把单体 index.html 机械拆分为模块化结构
 *
 * 设计原则：
 *   1. 只做「搬运」，不做「重写」。所有被抽出的常量与函数源码逐字保留。
 *   2. 不修改原 index.html。产物写入 build/，人工比对后再决定是否替换。
 *   3. 每个产物都可被 tools/verify.mjs 验证与原文件逐位等价。
 *   4. 产物自包含：图片是拷贝而不是软链，build/ 可以直接打包部署。
 *
 * 用法：
 *   node tools/split-index.mjs            # 拆分到 build/
 *   node tools/split-index.mjs --out dir  # 指定输出目录
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');
// 输入是归档的原版单体：仓库根 index.html 已由 tools/split.mjs 接管为骨架。
  const SRC_HTML = path.join(ROOT, 'legacy', 'index.v0.html');
const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const OUT_ROOT = outIdx >= 0 ? path.resolve(args[outIdx + 1]) : path.join(ROOT, 'build');

// ─────────────────────────────────────────────────────────────
// 1. 读取并切分 index.html
// ─────────────────────────────────────────────────────────────

const html = fs.readFileSync(SRC_HTML, 'utf8');
const lines = html.split('\n');

function findOnce(re, label) {
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) return i;
  }
  throw new Error(`定位失败：${label}`);
}

const styleOpen = findOnce(/^\s*<style>\s*$/, '<style>');
const styleClose = findOnce(/^\s*<\/style>\s*$/, '</style>');
const scriptOpen = findOnce(/^\s*<script>\s*$/, '<script>');
const scriptClose = findOnce(/^\s*<\/script>\s*$/, '</script>');

const cssText = lines.slice(styleOpen + 1, styleClose).join('\n');
const bodyMarkup = lines.slice(styleClose + 1, scriptOpen).join('\n');
const scriptText = lines.slice(scriptOpen + 1, scriptClose).join('\n');

// ─────────────────────────────────────────────────────────────
// 2. 从脚本中按「顶层 const NAME = ...」抽取声明（括号配平）
// ─────────────────────────────────────────────────────────────

/**
 * 从脚本源码里摘出 `const NAME = ...;` 的完整声明源码。
 * 用括号/引号状态机定位结尾分号，避免被字符串里的 ; 骗到。
 */
function extractDeclaration(source, name) {
  const re = new RegExp(`^(\\s*)const\\s+${name}\\s*=`, 'm');
  const m = re.exec(source);
  if (!m) return null;

  const start = m.index;
  let i = m.index + m[0].length;
  let depth = 0;
  let inStr = null;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (; i < source.length; i++) {
    const c = source[i];
    const prev = source[i - 1];
    const next = source[i + 1];

    if (inLineComment) { if (c === '\n') inLineComment = false; continue; }
    if (inBlockComment) { if (c === '*' && next === '/') { inBlockComment = false; i++; } continue; }
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (inTemplate) {
      if (c === '\\') { i++; continue; }
      if (c === '`') inTemplate = false;
      continue;
    }

    if (c === '/' && next === '/') { inLineComment = true; i++; continue; }
    if (c === '/' && next === '*') { inBlockComment = true; i++; continue; }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === '`') { inTemplate = true; continue; }

    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
    else if (c === ';' && depth === 0) { i++; break; }
  }

  return source.slice(start, i);
}

/** 从脚本中摘出顶层函数声明源码（含函数体括号配平）。 */
function extractFunction(source, name) {
  const re = new RegExp(`^(\\s*)(?:async\\s+)?function\\s+${name}\\s*\\(`, 'm');
  const m = re.exec(source);
  if (!m) return null;

  const start = m.index;
  let i = source.indexOf('{', m.index);
  if (i < 0) return null;

  let depth = 0;
  let inStr = null;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];

    if (inLineComment) { if (c === '\n') inLineComment = false; continue; }
    if (inBlockComment) { if (c === '*' && next === '/') { inBlockComment = false; i++; } continue; }
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (inTemplate) {
      if (c === '\\') { i++; continue; }
      if (c === '`') inTemplate = false;
      continue;
    }
    if (c === '/' && next === '/') { inLineComment = true; i++; continue; }
    if (c === '/' && next === '*') { inBlockComment = true; i++; continue; }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === '`') { inTemplate = true; continue; }

    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
  }

  return source.slice(start, i);
}

/** 在 vm 沙箱里求值一段声明，拿到运行时值（用于序列化成 JSON）。 */
function evalInSandbox(declSrc) {
  const sandbox = { __out: undefined };
  vm.createContext(sandbox);
  vm.runInContext(`${declSrc}\n;__out = ${getDeclaredName(declSrc)};`, sandbox, { timeout: 5000 });
  return sandbox.__out;
}

function getDeclaredName(declSrc) {
  const m = /^\s*const\s+(\w+)\s*=/.exec(declSrc);
  return m[1];
}

// ─────────────────────────────────────────────────────────────
// 3. 清单：哪些东西搬到哪
// ─────────────────────────────────────────────────────────────

const DATA_CONSTS = {
  'characters.json': ['CHARACTER_DATA'],
  'game-config.json': ['MAIN_ENTRY_CONFIG', 'MAIN_PROB_WEIGHTS', 'MAIN_ATTR_TO_SUB', 'SUBSTAT_SPECIAL_WEIGHTS', 'ENTRY_NAMES', 'ENTRY_IDX_MAP'],
  'enka-mapping.json': ['ENKA_ID_MAP', 'MAIN_STAT_NAME_MAP', 'SUBSTAT_INDEX_MAP'],
  'themes.json': ['themes'],
  'localization.zh-CN.json': ['LOC_ZH_CN'],
};

// 明确不搬的东西（死代码），单独列出以便验证脚本断言它们不在产物里
const DROPPED_CONSTS = ['LOC_ZH_TW'];

const DOMAIN_CONSTS = ['Achance', 'Bchance', 'Atimes', 'Btimes'];
const DOMAIN_FUNCS = ['parseNumber', 'dfsUp', 'passChance', 'firstGroup', 'calculateCore', 'calculateCoreGame'];

// ─────────────────────────────────────────────────────────────
// 4. 执行拆分
// ─────────────────────────────────────────────────────────────

fs.rmSync(OUT_ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT_ROOT, 'src', 'data'), { recursive: true });
fs.mkdirSync(path.join(OUT_ROOT, 'src', 'domain'), { recursive: true });

const report = { data: [], domain: [], dropped: [], missing: [] };

// 4a. 数据 → JSON
for (const [filename, names] of Object.entries(DATA_CONSTS)) {
  const bundle = {};
  for (const name of names) {
    const decl = extractDeclaration(scriptText, name);
    if (!decl) { report.missing.push(name); continue; }
    try {
      bundle[name] = evalInSandbox(decl);
    } catch (e) {
      report.missing.push(`${name} (求值失败: ${e.message})`);
      continue;
    }
  }
  const outPath = path.join(OUT_ROOT, 'src', 'data', filename);
  fs.writeFileSync(outPath, JSON.stringify(bundle, null, 2) + '\n', 'utf8');
  report.data.push({
    file: path.relative(ROOT, outPath),
    keys: Object.keys(bundle),
    bytes: fs.statSync(outPath).size,
  });
}

// 4b. 算法 → 纯函数模块
const domainParts = [];
domainParts.push('// 由 tools/split-index.mjs 从 index.html 机械提取。源码逐字保留，未做任何改写。');
domainParts.push('// 本文件不依赖 DOM / window / localStorage，可在 Node 下直接 import。');
domainParts.push('');

for (const name of DOMAIN_CONSTS) {
  const decl = extractDeclaration(scriptText, name);
  if (!decl) { report.missing.push(name); continue; }
  domainParts.push(decl.trim());
  report.domain.push(`const ${name}`);
}
domainParts.push('');
for (const name of DOMAIN_FUNCS) {
  const fn = extractFunction(scriptText, name);
  if (!fn) { report.missing.push(name); continue; }
  domainParts.push(fn.trim());
  domainParts.push('');
  report.domain.push(`function ${name}`);
}

const domainPath = path.join(OUT_ROOT, 'src', 'domain', 'probability.js');
fs.writeFileSync(domainPath, domainParts.join('\n'), 'utf8');

// 追加 ESM 导出
const exportLine = `\nexport { ${[...DOMAIN_CONSTS, ...DOMAIN_FUNCS].join(', ')} };\n`;
fs.appendFileSync(domainPath, exportLine, 'utf8');

// 4c. 死代码确认存在（供报告用；产物里不含它，因为不在任何清单里）
for (const name of DROPPED_CONSTS) {
  if (extractDeclaration(scriptText, name)) report.dropped.push(name);
}

// 4d. CSS → 独立文件（逐字搬运，仅去掉每行公共缩进）
const cssOutPath = path.join(OUT_ROOT, 'src', 'ui', 'styles.css');
fs.mkdirSync(path.dirname(cssOutPath), { recursive: true });
const cssDedented = dedent(cssText);
fs.writeFileSync(cssOutPath, cssDedented + '\n', 'utf8');

// 4e. 静态标记 → 框架 HTML（去掉内联 <script> 与 <style>，改为外链）
//
// 这里只做「最小可运行替换」：保留全部 DOM 结构与 id，把 <style> 换成 <link>，
// 把内联 <script> 换成 type="module" 的外链。事件绑定仍留在原脚本里，
// 因此这一步不改变任何行为——原脚本被整体搬到 src/main.js（见 4f）。
const headEnd = lines.findIndex(l => /^\s*<\/head>\s*$/.test(l));
if (headEnd < 0) throw new Error('定位失败：</head>');
const htmlHead = lines.slice(0, styleOpen).join('\n');          // <!DOCTYPE ... 到 <style> 之前
const htmlTail = lines.slice(headEnd).join('\n');               // </head> 起（含 </head>、body 全体）

// 注意：htmlTail 必须从 headEnd 起（含 </head> 本身），不能从 headEnd+1 起，
// 否则产出一个缺 </head> 的畸形 HTML——浏览器会容错但 DOM 结构会位移。
const skeleton = [
  htmlHead,
  '    <link rel="stylesheet" href="./src/ui/styles.css">',
  htmlTail,
]
  .join('\n')
  // 去掉原内联脚本块，换成 module 外链
  .replace(
    /<script>[\s\S]*?<\/script>/,
    '<script type="module" src="./src/main.js"></script>'
  );

const skeletonPath = path.join(OUT_ROOT, 'index.html');
fs.writeFileSync(skeletonPath, skeleton, 'utf8');

// 4f. 原脚本整体搬为 main.js（行为零变更），追加 ESM 化的收尾说明
const mainPath = path.join(OUT_ROOT, 'src', 'main.js');
const mainBody = [
  '// 由 tools/split-index.mjs 从 index.html 的 <script> 块整体搬运。',
  '// 本阶段刻意不做任何改写：函数体、事件绑定、全局变量全部逐字保留，',
  '// 以保证「拆分后行为零变更」这一前提可被 tools/verify.mjs 证明。',
  '// 后续 Phase 才逐步把这里的逻辑替换为对 domain/ 与 data/ 的 import。',
  '',
  scriptText.trim(),
  '',
].join('\n');
fs.writeFileSync(mainPath, mainBody, 'utf8');

// 4g. 静态资源（图片）拷贝到产物目录
//
// 为什么是拷贝而不是符号链接：产物必须自包含。软链在 zip、rsync、Docker
// 打包、对象存储上传、GitHub Pages 部署里都可能不被跟随，到头来是一堆
// 打不开的图；而且软链一旦被误当文件移回源目录，会覆盖它自己的目标
// （实测 `mv link.png ./pic.png` 得到自引用链接，cat 报 Too many levels
// of symbolic links），65 张图当场全废。
//
// 4MB 副本不进版本库：build/ 已在 .gitignore 里，它是生成物，随时可由
// 本脚本重建。仓库里只有一份源图，不存在「两份漂移」的问题。
const ASSET_EXT = /\.(png|jpe?g|gif|svg|webp|ico)$/i;
const assets = fs.readdirSync(ROOT).filter(f => ASSET_EXT.test(f));
let assetBytes = 0;
const SAME_DIR = path.resolve(OUT_ROOT) === path.resolve(ROOT);
for (const f of assets) {
  const targetPath = path.join(OUT_ROOT, f);
  const sourcePath = path.join(ROOT, f);
  if (SAME_DIR) continue; // --out . 时源即目标，跳过以免截断自己
  try {
    // 先删掉旧产物（可能是上一版留下的软链——rmSync 删的是链接本身，不碰目标）
    const st = fs.lstatSync(targetPath);
    if (st.isSymbolicLink() || st.isFile()) fs.rmSync(targetPath, { force: true });
  } catch { /* 不存在，正常 */ }
  fs.copyFileSync(sourcePath, targetPath);
  assetBytes += fs.statSync(targetPath).size;
}

function dedent(text) {
  const ls = text.split('\n');
  const indents = ls
    .filter(l => l.trim())
    .map(l => (/^[ \t]*/.exec(l) || [''])[0].length);
  const min = indents.length ? Math.min(...indents) : 0;
  return ls.map(l => l.slice(min)).join('\n');
}

// ─────────────────────────────────────────────────────────────
// 5. 输出报告
// ─────────────────────────────────────────────────────────────

const summary = {
  源文件: 'index.html',
  源行数: lines.length,
  源字节: Buffer.byteLength(html, 'utf8'),
  输出目录: path.relative(ROOT, OUT_ROOT),
  数据产物: report.data,
  domain产物: {
    file: path.relative(ROOT, domainPath),
    成员: report.domain,
    字节: fs.statSync(domainPath).size,
  },
  其他产物: [
    { file: path.relative(ROOT, cssOutPath), 字节: fs.statSync(cssOutPath).size },
    { file: path.relative(ROOT, skeletonPath), 行数: skeleton.split('\n').length, 字节: fs.statSync(skeletonPath).size },
    { file: path.relative(ROOT, mainPath), 行数: mainBody.split('\n').length, 字节: fs.statSync(mainPath).size },
  ],
  拷贝的静态资源: { 数量: assets.length, 字节: assetBytes },
  已剔除的死代码: report.dropped,
  未找到: report.missing,
};

console.log(JSON.stringify(summary, null, 2));

if (report.missing.length > 0) {
  console.error('\n⚠️  有成员未成功提取，逐项检查上表「未找到」。');
  process.exitCode = 1;
}