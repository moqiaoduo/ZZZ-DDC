#!/usr/bin/env node
/**
 * 概率引擎的正确性与稳定性自测。
 *
 *   node tools/test-probability.mjs
 *
 * 为什么单独有这一套：golden.mjs 验的是「结果没变」，验不出「结果对不对」。
 * 引擎换过实现（浮点 DFS → 整数卷积），必须有一份不依赖被测实现的真值。
 *
 * 真值来源是独立写的暴力枚举：把分值放大成整数后用乘法分配律逐条枚举，
 * 全程只有整数加减与除法计数，不碰被测实现的任何函数。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');
const IMPL = path.join(ROOT, 'src', 'domain', 'probability.js');
const LEGACY = path.join(ROOT, 'legacy', 'index.v0.html');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    failures.push(name + (detail ? ' — ' + detail : ''));
    console.log('  ✗ ' + name + (detail ? ' — ' + detail : ''));
  }
}

const MOD = await import('file://' + IMPL);
const SCALE = 10000;
const SW = [10, 10, 9, 9, 8, 10, 10, 8, 8, 8];
const makeTypes = (rest, f = (i) => (i % 3) * 0.4) =>
  SW.map((w, i) => ({ typeIndex: i, score: f(i), rest, specialWeight: w }));

// ── 独立真值：纯整数暴力枚举 ────────────────────────────────────────────────
function exactPass(times, needU, scoresU) {
  const n = scoresU.length;
  if (n === 0) return needU < 0 ? 1 : 0;
  const total = n ** times;
  let hit = 0;
  for (let k = 0; k < total; k++) {
    let x = k;
    let sum = 0;
    for (let t = 0; t < times; t++) {
      sum += scoresU[x % n];
      x = (x / n) | 0;
    }
    if (sum > needU) hit++;
  }
  return hit / total;
}

function exactCalc(types, goalU, directed = []) {
  const n = types.length;
  const sw = types.map((t) => t.specialWeight);
  const scU = types.map((t) => Math.round(t.score * SCALE));
  const ti = types.map((t) => t.typeIndex);
  const rest = types.map((t) => t.rest);
  const combos = new Map();
  const pick = [];
  (function walk(depth, weight, sumU) {
    if (depth === 4) {
      const key = [...pick].sort((a, b) => a - b).join(',');
      const cur = combos.get(key);
      if (cur) cur.weight += weight;
      else combos.set(key, { weight, sumU, picks: [...pick] });
      return;
    }
    let tw = 0;
    for (let i = 0; i < n; i++) if (rest[i] > 0) tw += sw[i];
    if (tw === 0) return;
    for (let i = 0; i < n; i++) {
      if (rest[i] <= 0) continue;
      rest[i]--;
      pick.push(i);
      walk(depth + 1, (weight * sw[i]) / tw, sumU + scU[i]);
      pick.pop();
      rest[i]++;
    }
  })(0, 1, 0);

  let tw2 = 0;
  let tA = 0;
  let tB = 0;
  for (const e of combos.values()) {
    const got = e.picks.map((i) => ti[i]);
    if (directed.length > 0 && !directed.every((d) => got.includes(d))) continue;
    let pA;
    let pB;
    if (e.sumU > goalU) {
      pA = 1;
      pB = 1;
    } else {
      const g = e.picks.map((i) => scU[i]);
      pA = exactPass(5, goalU - e.sumU, g);
      pB = exactPass(4, goalU - e.sumU, g);
    }
    tw2 += e.weight;
    tA += pA * e.weight;
    tB += pB * e.weight;
  }
  if (tw2 === 0) return 0;
  return 0.2011577424023155 * (tA / tw2) + 0.798842257597684516 * (tB / tw2);
}

/** calculateCore 的独立真值：权重乘「抽这一下之前的剩余库存数」。 */
function exactCore(pool, goalU) {
  const n = pool.length;
  const rest = pool.map((t) => t.rest);
  const scU = pool.map((t) => Math.round(t.score * SCALE));
  const pick = [];
  let tw = 0;
  let tA = 0;
  let tB = 0;
  (function walk(depth, weight, sumU) {
    if (depth === 4) {
      let pA;
      let pB;
      if (sumU > goalU) { pA = 1; pB = 1; }
      else {
        const g = pick.map((i) => scU[i]);
        pA = exactPass(5, goalU - sumU, g);
        pB = exactPass(4, goalU - sumU, g);
      }
      tw += weight; tA += pA * weight; tB += pB * weight;
      return;
    }
    for (let i = 0; i < n; i++) {
      if (rest[i] <= 0) continue;
      const before = rest[i];
      rest[i]--;
      pick.push(i);
      walk(depth + 1, weight * before, sumU + scU[i]);
      pick.pop();
      rest[i]++;
    }
  })(0, 1, 0);
  if (tw === 0) return 0;
  return 0.2011577424023155 * (tA / tw) + 0.798842257597684516 * (tB / tw);
}

// ── A. passChance 与真值一致 ───────────────────────────────────────────────
console.log('A. passChance 对独立真值');
{
  let worst = 0;
  let at = '';
  const scoreSets = [
    [0.4, 1.2, 0.8, 0],
    [0.4, 0.4, 0.4, 0],
    [1, 1, 1, 1],
    [0.8, 1.6, 0.4, 0],
  ];
  for (const scores of scoreSets) {
    const group = scores.map((s) => ({ score: s }));
    const scoresU = scores.map((s) => Math.round(s * SCALE));
    for (const times of [4, 5, 6]) {
      for (const need of [0, 0.2, 0.8, 1.2, 1.6, 2.0, 2.4, 3.2, 4.8]) {
        const got = MOD.passChance(times, need, group);
        const want = exactPass(times, Math.round(need * SCALE), scoresU);
        const d = Math.abs(got - want);
        if (d > worst) {
          worst = d;
          at = `times=${times} need=${need} scores=[${scores}]`;
        }
      }
    }
  }
  check('全部用例与真值逐位一致', worst === 0, worst ? `最大差 ${worst} @ ${at}` : '');
}

// ── B. 浮点稳定性：等价输入必须给同一答案 ───────────────────────────────────
console.log('\nB. 等价缩放下结果不变（旧实现在此失败）');
{
  let worst = 0;
  let at = '';
  for (const rest of [1, 2, 3, 4]) {
    for (const goal of [1.2, 2.4, 3.6, 4.8]) {
      const vals = [1, 5, 25].map((k) =>
        MOD.calculateCoreGame(makeTypes(rest, (i) => (i % 3) * 0.4 * k), goal * k, 1, []).chance
      );
      const spread = Math.max(...vals) - Math.min(...vals);
      if (spread > worst) {
        worst = spread;
        at = `rest=${rest} goal=${goal}`;
      }
    }
  }
  check('分值整体 ×k 后概率不变', worst === 0, worst ? `最大差 ${worst} @ ${at}` : '');
}

// ── C. calculateCoreGame 对独立真值 ────────────────────────────────────────
console.log('\nC. calculateCoreGame 对独立真值');
{
  let worst = 0;
  let at = '';
  for (const rest of [1, 2, 3, 4]) {
    for (const goal of [1, 2, 3, 4, 5, 6]) {
      for (const directed of [[], [2, 8]]) {
        const t = makeTypes(rest);
        const got = MOD.calculateCoreGame(t, goal, 1, directed).chance;
        const want = exactCalc(t, Math.round(goal * SCALE), directed);
        const rel = Math.abs(got - want) / Math.max(want, 1e-12);
        if (rel > worst) {
          worst = rel;
          at = `rest=${rest} goal=${goal} directed=[${directed}]`;
        }
      }
    }
  }
  check('48 组全部与真值相符', worst < 1e-12, worst ? `最大相对差 ${worst} @ ${at}` : '');
}

// ── D. 边界与退化输入 ──────────────────────────────────────────────────────
console.log('\nD. 边界与退化输入');
{
  const g = [{ score: 0.4 }, { score: 1.2 }, { score: 0.8 }, { score: 0 }];
  check('库存全为 0 时不崩且返回 0',
    MOD.calculateCoreGame(SW.map((w, i) => ({ typeIndex: i, score: 0.4, rest: 0, specialWeight: w })), 3, 1).chance === 0);
  check('目标分为负时必定达成', MOD.passChance(5, -0.1, g) === 1);
  check('时间为 0 时按已得分数判定', MOD.passChance(0, -0.1, g) === 1);
  check('分数全为 0 且目标分为 0 时返回 0（严格大于）', MOD.passChance(5, 0, [{ score: 0 }, { score: 0 }]) === 0);
  check('空词条组返回 0', MOD.passChance(5, 1, []) === 0);
  check('定向到不存在的类型时返回 0',
    MOD.calculateCoreGame(makeTypes(2), 3, 1, [99]).chance === 0);
  check('rest >= 4 与 rest = 4 等价',
    MOD.calculateCoreGame(makeTypes(4), 3, 1).chance === MOD.calculateCoreGame(makeTypes(20), 3, 1).chance);
  check('rest 递减语义：单条 rest=1 与 rest=3 结果不同',
    MOD.calculateCoreGame(makeTypes(1), 3, 1).chance !== MOD.calculateCoreGame(makeTypes(3), 3, 1).chance);
  const nanGroup = [{ score: NaN }];
  check('分数为 NaN 时不抛异常', typeof MOD.passChance(5, 1, nanGroup) === 'number');
}

// ── E. 非 1e-4 整数倍的分值走退路仍正确 ────────────────────────────────────
console.log('\nE. 任意小数分值（自定义面板场景）');
{
  const scores = [0.333, 0.667, 1.111, 0];
  const group = scores.map((s) => ({ score: s }));
  let worst = 0;
  for (const times of [4, 5]) {
    for (const need of [0.5, 1.0, 1.5, 2.0, 2.5]) {
      const got = MOD.passChance(times, need, group);
      // 真值用带容差的浮点枚举（这些分数本身不能被 1e-4 精确表示）
      const total = scores.length ** times;
      let hit = 0;
      for (let k = 0; k < total; k++) {
        let x = k;
        let sum = 0;
        for (let t = 0; t < times; t++) {
          sum += scores[x % scores.length];
          x = (x / scores.length) | 0;
        }
        if (sum > need + 1e-9) hit++;
      }
      worst = Math.max(worst, Math.abs(got - hit / total));
    }
  }
  check('与暴力枚举一致（容差 1e-9）', worst < 1e-9, `最大差 ${worst}`);
}

// ── F. 性能门槛 ────────────────────────────────────────────────────────────
console.log('\nF. 性能门槛');
{
  const bench = (rest, n = 200) => {
    const t = makeTypes(rest);
    MOD.calculateCoreGame(t, 3, 1, []);
    const s = process.hrtime.bigint();
    for (let i = 0; i < n; i++) MOD.calculateCoreGame(t, 3, 1, []);
    return Number(process.hrtime.bigint() - s) / 1e6;
  };
  const r1 = bench(1);
  const r4 = bench(4);
  console.log(`    rest=1 200 次 ${r1.toFixed(0)}ms，rest=4 ${r4.toFixed(0)}ms`);
  check('rest=1 时 200 次调用 < 400ms', r1 < 400, `${r1.toFixed(0)}ms`);
  check('rest=4 时 200 次调用 < 800ms', r4 < 800, `${r4.toFixed(0)}ms`);
}

// ── F2. calculateCore（自定义面板口径）对独立真值 ──────────────────────────
console.log('\nF2. calculateCore 对独立真值');
{
  const pool = (rest, f = (i) => (i % 3) * 0.4) =>
    SW.map((w, i) => ({ typeIndex: i, score: f(i), rest, specialWeight: w }));

  let worst = 0;
  let at = '';
  for (const rest of [1, 2, 3]) {
    for (const goal of [2, 3, 4, 5]) {
      const p = pool(rest);
      const got = MOD.calculateCore(p, goal, 1, []).chance;
      const want = exactCore(p, Math.round(goal * SCALE));
      const rel = Math.abs(got - want) / Math.max(want, 1e-12);
      if (rel > worst) { worst = rel; at = `rest=${rest} goal=${goal}`; }
    }
  }
  check('12 组全部与真值相符', worst < 1e-12, worst ? `最大相对差 ${worst} @ ${at}` : '');

  let sp = 0;
  for (const rest of [1, 2, 4]) {
    for (const goal of [1.2, 2.4, 3.6]) {
      const vals = [1, 5, 25].map((k) =>
        MOD.calculateCore(pool(rest, (i) => (i % 3) * 0.4 * k), goal * k, 1, []).chance);
      sp = Math.max(sp, Math.max(...vals) - Math.min(...vals));
    }
  }
  check('等价缩放下结果不变', sp === 0, `spread=${sp}`);
}

// ── G. 旧实现确实有缺陷（防止有人「修回去」） ──────────────────────────────
if (fs.existsSync(LEGACY)) {
  console.log('\nG. 旧实现的可复现缺陷（回归护栏）');
  const lines = fs.readFileSync(LEGACY, 'utf8').split('\n');
  const findLine = (re) => {
    const i = lines.findIndex((l) => re.test(l));
    if (i < 0) throw new Error(`找不到 ${re}`);
    return i;
  };
  const code = [
    ...lines.slice(findLine(/^\s*const Achance\s*=/), findLine(/^\s*const ENTRY_NAMES\s*=/) + 1),
    ...lines.slice(findLine(/^\s*function parseNumber\s*\(/), findLine(/^\s*function calculateCoreGame\s*\(/) + 1),
    'globalThis.__old = { calculateCoreGame, calculateCore };',
  ].join('\n');
  const ctx = vm.createContext({});
  new vm.Script(code, { filename: LEGACY }).runInContext(ctx);
  const OLD = ctx.__old;

  const vals = [1, 5, 25].map((k) =>
    OLD.calculateCoreGame(makeTypes(2, (i) => (i % 3) * 0.4 * k), 2.4 * k, 1, []).chance
  );
  const spread = Math.max(...vals) - Math.min(...vals);
  check('旧实现存在缩放不一致（证明修复有意义）', spread > 1e-3, `spread=${spread}`);

  const oldAt4 = OLD.calculateCoreGame(makeTypes(2), 4, 1, []).chance;
  const truthAt4 = exactCalc(makeTypes(2), 4 * SCALE, []);
  check('旧实现在 goal=4 上偏离真值 > 15%',
    Math.abs(oldAt4 - truthAt4) / truthAt4 > 0.15,
    `偏差 ${((Math.abs(oldAt4 - truthAt4) / truthAt4) * 100).toFixed(1)}%`);
}

console.log('');
if (fail > 0) {
  console.log(`\n${fail} 项失败：`);
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log(`全部通过：${pass} 项`);
