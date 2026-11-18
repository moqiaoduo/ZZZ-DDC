// 概率计算核心。纯函数：不碰 DOM、不读全局状态，同样的入参永远同样的结果。
//
// ── 为什么有 SCALE ───────────────────────────────────────────────────
// 词条分值都是 0.4 / 0.8 / 1.2 这种一位小数。直接浮点累加会出事：
//
//   0.4 + 0.4 + 0.4 = 1.2000000000000002   → 略大于 1.2，判「已达标」
//   1.2 + 1.2 + 1.2 = 3.5999999999999996   → 略小于 3.6，判「未达标」
//
// 判定用的是严格大于，于是同一道题（强化 5 次，4 条词条，目标分 2.4）
// 因为累加顺序不同会给出不同答案：1024 条序列里有 71 条被误判。
// 用户看到的表现是「同一个角色同一套配置，刷新一次概率变了」。
//
// 解法：把分数与目标分统一放大 10000 倍取整后再比较。1e-4 的粒度远小于
// 页面允许输入的最小分值间隔，不会引入可见误差；而整数累加与顺序无关。
const SCALE = 10000;

export const Achance = 0.2011577424023155;

export const Bchance = 0.798842257597684516;

export const Atimes = 5;

export const Btimes = 4;

export function parseNumber(str) {
  str = str.trim();
  if (str === '') return 0;
  if (str.includes('/')) {
    const p = str.split('/');
    if (p.length !== 2) return NaN;
    return parseFloat(p[0]) / parseFloat(p[1]);
  }
  return parseFloat(str);
}

/** 强化 times 次后，累计分严格大于目标分的概率。 */
export function passChance(times, need, nowGroup) {
  return passChanceUnits(times, Math.round(need * SCALE), nowGroup);
}

/**
 * 以内置的整数单位计算，needU 已是放大后的整数。
 *
 * 做法是逐次卷积：dp[s] = 累计分为 s 个单位的序列条数。times 次卷积后
 * 每个计数都是精确整数，与遍历顺序无关。用 gcd 把分值集合压缩成最小步长，
 * 数组长度因此只有 times × 步长，而不是 times × maxU。
 */
function passChanceUnits(times, needU, nowGroup) {
  const n = nowGroup.length;
  if (times <= 0) return needU < 0 ? 1 : 0;
  if (n === 0) return (0 > needU) ? 1 : 0;
  if (needU < 0) return 1;

  let maxU = 0;
  let g = 0;
  for (let i = 0; i < n; i++) {
    const u = nowGroup[i].score * SCALE;
    const r = Math.round(u);
    if (Math.abs(u - r) > 1e-6 || !Number.isFinite(r)) {
      return passChanceSlow(times, needU / SCALE, nowGroup);
    }
    if (r > maxU) maxU = r;
    g = gcd(g, Math.abs(r));
  }
  // 全部为 0 分：永远不达标（needU >= 0 已在上面排除）。
  if (g === 0) return 0;

  const step = maxU / g;
  const span = times * step;
  if (span > 8192) return passChanceSlow(times, needU / SCALE, nowGroup);

  const size = span + 1;
  let a = scratchA.length >= size ? scratchA : (scratchA = new Float64Array(size));
  let b = scratchB.length >= size ? scratchB : (scratchB = new Float64Array(size));
  a.fill(0, 0, size);
  b.fill(0, 0, size);
  a[0] = 1;

  const idx = new Int32Array(n);
  for (let i = 0; i < n; i++) idx[i] = Math.round(nowGroup[i].score * SCALE) / g;

  let hi = 0;
  for (let t = 0; t < times; t++) {
    const nhi = hi + step;
    b.fill(0, 0, nhi + 1);
    for (let s = 0; s <= hi; s++) {
      const c = a[s];
      if (c === 0) continue;
      for (let i = 0; i < n; i++) b[s + idx[i]] += c;
    }
    const tmp = a; a = b; b = tmp;
    hi = nhi;
  }

  let total = 0;
  let pass = 0;
  for (let s = 0; s <= hi; s++) {
    const c = a[s];
    if (c === 0) continue;
    total += c;
    if (s * g > needU) pass += c;
  }
  return total === 0 ? 0 : pass / total;
}

// 复用两块缓冲，避免每次调用都分配。JS 单线程，不用担心重入。
let scratchA = new Float64Array(64);
let scratchB = new Float64Array(64);

function gcd(a, b) {
  while (b) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

/**
 * 分数不是 1e-4 的整数倍时的退路（自定义面板允许手填任意小数）。
 * 逐个累加，与旧实现完全一致——它会踩浮点边界，但只在用户自己输入
 * 非常规小数时发生，且不参与游戏版的批量计算。
 */
function passChanceSlow(times, need, nowGroup) {
  const c = { total: 0, pass: 0 };
  dfsUp(times, 0, need, nowGroup, c);
  return c.total === 0 ? 0 : c.pass / c.total;
}

/** 暴力枚举的参考实现，只被 passChanceSlow 调用，也用作测试对照。 */
export function dfsUp(leaveTimes, nowAdd, need, nowGroup, counter) {
  if (leaveTimes <= 0) {
    counter.total++;
    if (nowAdd > need) counter.pass++;
    return;
  }
  for (let i = 0; i < nowGroup.length; i++) {
    dfsUp(leaveTimes - 1, nowAdd + nowGroup[i].score, need, nowGroup, counter);
  }
}

/**
 * 游戏版的概率计算。
 *
 * types 每项含 typeIndex / score / rest / specialWeight。抽出 4 次词条的所有
 * 组合（按类型集合去重、权重累加），再对每个组合算「5 次 A 套 / 4 次 B 套
 * 强化后总分能否超过目标分」，按组合权重加权平均。
 *
 * rest 的语义是「该词条最多能被抽中几次」：0 表示不存在，>= 4 时与 4 等价
 * （4 次抽取的上限）。
 */
export function calculateCoreGame(types, goal, scaleFactor, directedTypes = []) {
  const n = types.length;
  const sw = new Int32Array(n);
  const scU = new Float64Array(n);
  const ti = new Int32Array(n);
  const rest = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    sw[i] = types[i].specialWeight;
    scU[i] = types[i].score * SCALE;
    ti[i] = types[i].typeIndex;
    rest[i] = types[i].rest;
  }
  const goalU = Math.round(goal * SCALE);

  // 组合表。key 是 4 次抽取的类型下标升序拼成的字符串——只要对「多重集」
  // 是双射即可，排序方向不影响分组结果。
  const combos = new Map();
  const pick = new Int32Array(4);

  function walk(depth, weight, sumU) {
    if (depth === 4) {
      // key 用 typeIndex 而不是数组下标：分组语义是「抽中了哪几种词条」。
      const sorted = [ti[pick[0]], ti[pick[1]], ti[pick[2]], ti[pick[3]]].sort((x, y) => x - y);
      const key = sorted.join(',');
      const cur = combos.get(key);
      if (cur) cur.weight += weight;
      else combos.set(key, { weight, sumU, picks: Int32Array.from(pick) });
      return;
    }
    let totalW = 0;
    for (let i = 0; i < n; i++) if (rest[i] > 0) totalW += sw[i];
    if (totalW === 0) return;
    for (let i = 0; i < n; i++) {
      if (rest[i] <= 0) continue;
      rest[i]--;
      pick[depth] = i;
      walk(depth + 1, (weight * sw[i]) / totalW, sumU + scU[i]);
      rest[i]++;
    }
  }
  walk(0, 1, 0);

  const directedSet = directedTypes.length > 0 ? new Set(directedTypes) : null;
  const groupA = new Array(4);
  const groupB = new Array(4);
  let totalWeight = 0;
  let totalA = 0;
  let totalB = 0;

  for (const entry of combos.values()) {
    if (directedSet) {
      let ok = true;
      for (const dt of directedSet) {
        let found = false;
        for (let k = 0; k < 4; k++) if (ti[entry.picks[k]] === dt) { found = true; break; }
        if (!found) { ok = false; break; }
      }
      if (!ok) continue;
    }
    let pA;
    let pB;
    if (entry.sumU > goalU) {
      pA = 1;
      pB = 1;
    } else {
      for (let k = 0; k < 4; k++) {
        const o = { score: types[entry.picks[k]].score };
        groupA[k] = o;
        groupB[k] = o;
      }
      const needU = goalU - entry.sumU;
      pA = passChanceUnits(Atimes, needU, groupA);
      pB = passChanceUnits(Btimes, needU, groupB);
    }
    totalWeight += entry.weight;
    totalA += pA * entry.weight;
    totalB += pB * entry.weight;
  }

  if (totalWeight === 0) return { mchanceA: 0, mchanceB: 0, chance: 0, scaledChance: 0 };
  const mA = totalA / totalWeight;
  const mB = totalB / totalWeight;
  const ch = Achance * mA + Bchance * mB;
  return { mchanceA: mA, mchanceB: mB, chance: ch, scaledChance: ch * scaleFactor };
}

/**
 * 自定义面板的概率计算：库存加权口径。
 *
 * 与 calculateCoreGame 的区别在「抽中某个组合的权重怎么算」：
 * 那边是「每次抽取按 specialWeight 归一」，这边是「每次抽取按剩余库存数
 * 加权」。两者对应不同的现实假设，游戏版只用上面那个；这个保留是因为
 * 自定义面板允许用户自己填库存与权重，走的是这套语义。
 *
 * 枚举仍是「从池里有序抽 4 次」，用 rest 递减表示不放回。
 */
export function calculateCore(entryList, goal, scaleFactor, directedTypes = []) {
  const n = entryList.length;
  const rest = new Int32Array(n);
  const scU = new Float64Array(n);
  const ti = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    rest[i] = entryList[i].rest;
    scU[i] = entryList[i].score * SCALE;
    ti[i] = entryList[i].typeIndex;
  }
  const goalU = Math.round(goal * SCALE);
  const directedSet = directedTypes.length > 0 ? new Set(directedTypes) : null;

  const pick = new Int32Array(4);
  const group = new Array(4);
  let totalWeight = 0;
  let totalA = 0;
  let totalB = 0;

  function walk(depth, weight, sumU) {
    if (depth === 4) {
      if (directedSet) {
        let ok = true;
        for (const dt of directedSet) {
          let found = false;
          for (let k = 0; k < 4; k++) if (ti[pick[k]] === dt) { found = true; break; }
          if (!found) { ok = false; break; }
        }
        if (!ok) return;
      }
      let pA;
      let pB;
      if (sumU > goalU) {
        pA = 1;
        pB = 1;
      } else {
        for (let k = 0; k < 4; k++) group[k] = { score: entryList[pick[k]].score };
        const needU = goalU - sumU;
        pA = passChanceUnits(Atimes, needU, group);
        pB = passChanceUnits(Btimes, needU, group);
      }
      totalWeight += weight;
      totalA += pA * weight;
      totalB += pB * weight;
      return;
    }
    for (let i = 0; i < n; i++) {
      if (rest[i] <= 0) continue;
      // 权重乘的是「抽这一下之前」的剩余库存数（旧实现如此），不是递减后的。
      const before = rest[i];
      rest[i]--;
      pick[depth] = i;
      walk(depth + 1, weight * before, sumU + scU[i]);
      rest[i]++;
    }
  }
  walk(0, 1, 0);

  if (totalWeight === 0) return { mchanceA: 0, mchanceB: 0, chance: 0, scaledChance: 0 };
  const mA = totalA / totalWeight;
  const mB = totalB / totalWeight;
  const ch = Achance * mA + Bchance * mB;
  return { mchanceA: mA, mchanceB: mB, chance: ch, scaledChance: ch * scaleFactor };
}
