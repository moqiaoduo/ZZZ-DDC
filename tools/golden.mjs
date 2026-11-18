#!/usr/bin/env node
/**
 * 领域层行为的黄金快照（golden snapshot）。
 *
 * 为什么需要它：重构要动代码，就得有「行为没变」的证据。文本层面的证据
 * （「搬过去的代码与原文逐字相同」）只在「只搬运不改写」时成立，一旦真的
 * 分层就没法用了。快照把证据从「文本相同」换成「数值相同」，这个证据在
 * 重构之后依然成立，也是后续改算法的回归基线。
 *
 * 覆盖范围只包含「会长期存在」的东西：4 个概率常量 + parseNumber / dfsUp /
 * passChance / calculateCoreGame。calculateCore 与 firstGroup 在口径定案后
 * 要删（见方案 Phase 2.1），刻意不进快照——否则删它们时快照会假报警。
 *
 * 精度：浮点用 toPrecision(17) 存（双精度能精确往返的最大有效位数），
 * 比对用 Object.is 而不是 ===，把 -0 与 NaN 也纳入判定。
 *
 * 用法：
 *   node tools/golden.mjs --gen           从当前实现生成 test/golden.json
 *   node tools/golden.mjs                 校验当前实现是否与快照一致
 *   node tools/golden.mjs --from <path>   指定实现来源（index.html 或 src/domain/probability.js）
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN = path.join(ROOT, 'test', 'golden.json');

/** 快照里记哪几个导出。顺序即生成顺序。 */
const SURVIVORS = [
  'Achance', 'Bchance', 'Atimes', 'Btimes',
  'parseNumber', 'dfsUp', 'passChance', 'calculateCoreGame',
];

/**
 * 从 index.html 里抠出「4 个常量 + 6 个算法」并求值。
 *
 * 切片是硬编码的行号，切错的表现很隐蔽：只抽算法段会 ReferenceError
 * （Achance is not defined），多抽一行会把事件绑定带进来抛
 * document is not defined。所以这里用常量名反查行号，不信手写数字。
 */
function loadFromHtml(htmlPath) {
  const lines = fs.readFileSync(htmlPath, 'utf8').split('\n');
  const findLine = (re) => {
    const i = lines.findIndex(l => re.test(l));
    if (i < 0) throw new Error(`index.html 里找不到 ${re}`);
    return i;
  };
  const constStart = findLine(/^\s*const Achance\s*=/);
  const constEnd = findLine(/^\s*const ENTRY_NAMES\s*=/);
  const fnStart = findLine(/^\s*function parseNumber\s*\(/);
  const fnEnd = findLine(/^\s*function calculateCoreGame\s*\(/);

  const code = [
    ...lines.slice(constStart, constEnd + 1),
    ...lines.slice(fnStart, fnEnd + 1),
    `globalThis.__golden = { ${SURVIVORS.join(', ')} };`,
  ].join('\n');

  const ctx = vm.createContext({});
  new vm.Script(code, { filename: htmlPath }).runInContext(ctx);
  return ctx.__golden;
}

async function loadFromModule(modulePath) {
  const mod = await import(pathToFileURL(modulePath).href);
  const out = {};
  for (const k of SURVIVORS) {
    if (!(k in mod)) throw new Error(`${modulePath} 缺少导出 ${k}`);
    out[k] = mod[k];
  }
  return out;
}

/** 按扩展名选加载方式。 */
async function loadImpl(from) {
  const abs = path.resolve(ROOT, from);
  if (!fs.existsSync(abs)) throw new Error(`实现来源不存在：${from}`);
  if (abs.endsWith('.json')) throw new Error('--from 不接受 JSON');
  if (abs.endsWith('.html')) return loadFromHtml(abs);
  return loadFromModule(abs);
}

/** 默认来源：src/ 已建立就用它，否则退回归档的单体版 legacy/index.v0.html。 */
function defaultFrom() {
  const mod = path.join(ROOT, 'src', 'domain', 'probability.js');
  return fs.existsSync(mod) ? 'src/domain/probability.js' : 'legacy/index.v0.html';
}

// ── 用例 ──────────────────────────────────────────────────────────────
// 分数取 0.4 / 0.8 / 1.2 这一组，是页面真实会出现的小数（词条每强化一次的
// 分值），也正是浮点边界会踩坑的地方（见源码解析 §5.6）。全用整数会漏掉它。

function makeTypes(rest) {
  return Array.from({ length: 10 }, (_, i) => ({
    typeIndex: i,
    score: (i % 3) * 0.4,
    rest,
    specialWeight: [10, 10, 9, 9, 8, 10, 10, 8, 8, 8][i],
  }));
}

function buildCases() {
  const cases = [];
  for (const rest of [1, 2, 3, 4, 6]) {
    for (const goal of [1, 2, 3, 4, 5]) {
      cases.push({ kind: 'game', rest, goal, directed: [] });
      // 定向只在 4/5 号位有意义，这里用两个真实会出现的主词条类型
      cases.push({ kind: 'game', rest, goal, directed: [2, 8] });
    }
  }
  return cases;
}

function runCases(impl) {
  const out = { constants: {}, parseNumber: [], passChance: [], cases: [] };

  for (const k of ['Achance', 'Bchance', 'Atimes', 'Btimes']) {
    out.constants[k] = String(impl[k]);
  }

  // parseNumber：空串、整数、小数、分数、坏分数、非数字
  const pnInputs = ['', '  ', '0', '1', '-2', '1.5', '25/2', '1/3', '1/0', 'a/b', 'abc', '3/x', '0.0001'];
  for (const s of pnInputs) {
    const v = impl.parseNumber(s);
    out.parseNumber.push({ input: s, value: fmt(v) });
  }

  // passChance：直接钉住 dfsUp 的浮点行为（含 §5.6 那个边界）
  const pcCases = [
    { times: 5, need: 1.2, scores: [0.4, 1.2, 0.8, 0] },
    { times: 5, need: 2.4, scores: [0.4, 1.2, 0.8, 0] },
    { times: 4, need: 2.0, scores: [0.4, 1.2, 0.8, 0] },
    { times: 5, need: 3, scores: [1, 1, 1, 0] },
    { times: 5, need: 0, scores: [0, 0, 0, 0] },
    { times: 5, need: 99, scores: [0.4, 1.2, 0.8, 0] },
  ];
  for (const c of pcCases) {
    const group = c.scores.map(s => ({ score: s }));
    out.passChance.push({
      times: c.times, need: c.need, scores: c.scores,
      value: fmt(impl.passChance(c.times, c.need, group)),
    });
  }

  // calculateCoreGame：真实调用形状（10 词条 × rest × goal，带/不带定向）
  for (const c of buildCases()) {
    const r = impl.calculateCoreGame(makeTypes(c.rest), c.goal, 1 / 6, c.directed);
    out.cases.push({
      rest: c.rest, goal: c.goal, directed: c.directed,
      mchanceA: fmt(r.mchanceA), mchanceB: fmt(r.mchanceB),
      chance: fmt(r.chance), scaledChance: fmt(r.scaledChance),
    });
  }
  return out;
}

/** 数值 → 可精确往返的字符串。NaN/Infinity 单独标，JSON 存不住。 */
function fmt(v) {
  if (Number.isNaN(v)) return 'NaN';
  if (v === Infinity) return 'Infinity';
  if (v === -Infinity) return '-Infinity';
  return v.toPrecision(17);
}

function parse(s) {
  if (s === 'NaN') return NaN;
  if (s === 'Infinity') return Infinity;
  if (s === '-Infinity') return -Infinity;
  return Number(s);
}

// ── 主流程 ────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const gen = argv.includes('--gen');
const fromIdx = argv.indexOf('--from');
const from = fromIdx >= 0 ? argv[fromIdx + 1] : defaultFrom();

const impl = await loadImpl(from);
const actual = runCases(impl);

if (gen) {
  fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
  const doc = {
    $comment: '领域层行为快照。由 node tools/golden.mjs --gen 生成，不要手改。',
    generatedFrom: from,
    generatedAt: new Date().toISOString(),
    precision: 'toPrecision(17)',
    ...actual,
  };
  fs.writeFileSync(GOLDEN, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  const n = actual.parseNumber.length + actual.passChance.length + actual.cases.length;
  console.log(`已写入 ${path.relative(ROOT, GOLDEN)}：${n} 组用例（来源 ${from}）`);
  process.exit(0);
}

if (!fs.existsSync(GOLDEN)) {
  console.error(`缺少 ${path.relative(ROOT, GOLDEN)}，先跑 node tools/golden.mjs --gen`);
  process.exit(1);
}

const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
const fails = [];
const eq = (a, b) => Object.is(parse(a), parse(b));

for (const k of Object.keys(golden.constants)) {
  if (!eq(golden.constants[k], actual.constants[k])) {
    fails.push(`常量 ${k}：快照 ${golden.constants[k]} ≠ 实际 ${actual.constants[k]}`);
  }
}
for (let i = 0; i < golden.parseNumber.length; i++) {
  const g = golden.parseNumber[i], a = actual.parseNumber[i];
  if (!eq(g.value, a.value)) fails.push(`parseNumber("${g.input}")：${g.value} ≠ ${a.value}`);
}
for (let i = 0; i < golden.passChance.length; i++) {
  const g = golden.passChance[i], a = actual.passChance[i];
  if (!eq(g.value, a.value)) {
    fails.push(`passChance(times=${g.times}, need=${g.need}, scores=[${g.scores}])：${g.value} ≠ ${a.value}`);
  }
}
for (let i = 0; i < golden.cases.length; i++) {
  const g = golden.cases[i], a = actual.cases[i];
  for (const f of ['mchanceA', 'mchanceB', 'chance', 'scaledChance']) {
    if (!eq(g[f], a[f])) {
      fails.push(`calculateCoreGame(rest=${g.rest}, goal=${g.goal}, directed=[${g.directed}]).${f}：${g[f]} ≠ ${a[f]}`);
    }
  }
}

const total = Object.keys(golden.constants).length
  + golden.parseNumber.length + golden.passChance.length + golden.cases.length * 4;

if (fails.length) {
  console.error(`golden 快照比对失败（${fails.length} / ${total}）：`);
  for (const f of fails.slice(0, 20)) console.error('  ✗ ' + f);
  if (fails.length > 20) console.error(`  …… 另有 ${fails.length - 20} 条`);
  console.error('\n如果这是有意的行为变更（例如修浮点边界），用 --gen 重新生成并 review diff。');
  process.exit(1);
}

console.log(`golden 快照通过：${total} 项（来源 ${from}）`);
