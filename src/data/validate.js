// 数据自检：在应用启动时跑一遍，把「结构不一致」从静默出错变成明确报错。
//
// 为什么需要它：这些表之间全是隐式契约——词条索引 0-9 在五处并行定义、角色名跨三张表
// 对齐、每个角色的 weights 必须与 ENTRY_NAMES 等长。加一个角色、改一个词条、删一张图，
// 任何一处漏改都不会抛异常，只会让计算结果悄悄变错（旧版就踩过：猫又在旧站根本导不进来）。
//
// 校验只做「结构」，不判断数值是否合理——那是策划的事。

import { CHARACTER_ALIASES, CHARACTER_DATA } from './characters.js';
import { ENKA_ID_MAP, MAIN_STAT_NAME_MAP, SUBSTAT_INDEX_MAP } from './enka-mapping.js';
import { ENTRY_NAMES, MAIN_ATTR_TO_SUB, MAIN_ENTRY_CONFIG, MAIN_PROB_WEIGHTS, SUBSTAT_SPECIAL_WEIGHTS } from './game-config.js';

const IMAGE_RE = /^assets\/characters\/(\d+)\.png$/;

/**
 * 检查全部数据表的结构一致性。
 *
 * @returns {Array<{scope: string, message: string}>} 问题列表；空数组表示通过。
 */
export function validateData() {
  const problems = [];
  const bad = (scope, message) => problems.push({ scope, message });

  // ── 词条表：索引 0-9 是全局约定，五处定义必须同长 ──
  const subCount = ENTRY_NAMES.length;
  if (subCount !== 10) bad('ENTRY_NAMES', `副词条应为 10 项，实际 ${subCount} 项`);
  if (SUBSTAT_SPECIAL_WEIGHTS.length !== subCount) {
    bad('SUBSTAT_SPECIAL_WEIGHTS', `长度 ${SUBSTAT_SPECIAL_WEIGHTS.length} 与 ENTRY_NAMES 的 ${subCount} 不一致`);
  }
  for (const [name, idx] of Object.entries(MAIN_ATTR_TO_SUB)) {
    if (!Number.isInteger(idx) || idx < 0 || idx >= subCount) {
      bad('MAIN_ATTR_TO_SUB', `${name} 指向副词条索引 ${idx}，超出 0..${subCount - 1}`);
    }
  }
  for (const [propId, idx] of Object.entries(SUBSTAT_INDEX_MAP)) {
    if (!Number.isInteger(idx) || idx < 0 || idx >= subCount) {
      bad('SUBSTAT_INDEX_MAP', `属性 ${propId} 指向副词条索引 ${idx}，超出 0..${subCount - 1}`);
    }
  }

  // ── 主词条表：4/5/6 三个位号，配置与权重必须一一对应 ──
  for (const pos of [4, 5, 6]) {
    const mains = MAIN_ENTRY_CONFIG[pos];
    const weights = MAIN_PROB_WEIGHTS[pos];
    if (!Array.isArray(mains) || mains.length === 0) {
      bad('MAIN_ENTRY_CONFIG', `${pos} 号位没有主词条`);
      continue;
    }
    if (!weights) {
      bad('MAIN_PROB_WEIGHTS', `缺少 ${pos} 号位的权重表`);
      continue;
    }
    const dup = mains.filter((m, i) => mains.indexOf(m) !== i);
    if (dup.length) bad('MAIN_ENTRY_CONFIG', `${pos} 号位主词条重复：${[...new Set(dup)].join('、')}`);
    const missing = mains.filter((m) => !(m in weights));
    if (missing.length) bad('MAIN_PROB_WEIGHTS', `${pos} 号位缺少权重：${missing.join('、')}`);
    const extra = Object.keys(weights).filter((w) => !mains.includes(w));
    if (extra.length) bad('MAIN_PROB_WEIGHTS', `${pos} 号位多出未配置的权重：${extra.join('、')}`);
    // 权重是相对值，不要求精确等于 100：实测 4/5/6 号位分别是 99 / 100 / 105，
    // 这是原站数据的既成事实。只拦「明显不对劲」，比如漏配某项导致合计掉一半。
    const sum = mains.reduce((acc, m) => acc + (weights[m] || 0), 0);
    if (Math.abs(sum - 100) > 15) bad('MAIN_PROB_WEIGHTS', `${pos} 号位权重合计 ${sum}，偏离 100 过多（可能漏配或重复）`);
  }
  for (const [name] of Object.entries(MAIN_STAT_NAME_MAP)) {
    if (!/^\d+$/.test(name)) bad('MAIN_STAT_NAME_MAP', `属性 ID「${name}」不是数字`);
  }

  // ── 角色表：59 条、无重名、weights 与词条表等长、图片名可推导且唯一 ──
  const seenNames = new Map();
  const seenIds = new Map();
  let roleCount = 0;
  for (const faction of CHARACTER_DATA) {
    if (!faction.faction) bad('CHARACTER_DATA', '存在没有 faction 名称的条目');
    for (const role of faction.roles || []) {
      roleCount += 1;
      const where = `角色「${role.name || '(未命名)'}」`;
      if (!role.name) {
        bad('CHARACTER_DATA', `${faction.faction} 下有角色缺少 name`);
        continue;
      }
      if (seenNames.has(role.name)) bad('CHARACTER_DATA', `角色名重复：${role.name}（${seenNames.get(role.name)} 与 ${faction.faction}）`);
      else seenNames.set(role.name, faction.faction);

      if (!Array.isArray(role.weights)) {
        bad(where, '缺少 weights 数组');
      } else {
        if (role.weights.length !== subCount) {
          bad(where, `weights 长度 ${role.weights.length}，应为 ${subCount}`);
        }
        role.weights.forEach((w, i) => {
          if (typeof w !== 'number' || !Number.isFinite(w) || w < 0) {
            bad(where, `weights[${i}]（${ENTRY_NAMES[i] ?? '越界'}）不是非负数：${w}`);
          }
        });
      }

      const m = IMAGE_RE.exec(role.image || '');
      if (!m) {
        bad(where, `image 路径「${role.image}」不符合 assets/characters/<EnkaID>.png`);
      } else {
        const id = m[1];
        if (seenIds.has(id)) bad(where, `Enka ID ${id} 与「${seenIds.get(id)}」重复`);
        else seenIds.set(id, role.name);
        if (String(ENKA_ID_MAP[id] ?? '') === '') bad(where, `Enka ID ${id} 不在 ENKA_ID_MAP 中`);
      }
    }
  }
  if (roleCount !== 59) bad('CHARACTER_DATA', `角色总数 ${roleCount}，应为 59`);

  // ── Enka 映射：每个短名都必须能解析回角色，别名的目标也必须存在 ──
  for (const [id, short] of Object.entries(ENKA_ID_MAP)) {
    if (!seenIds.has(id)) bad('ENKA_ID_MAP', `ID ${id}（${short}）在角色表里没有对应头像`);
    const full = CHARACTER_ALIASES[short] ?? short;
    if (!seenNames.has(full)) bad('ENKA_ID_MAP', `ID ${id} 的短名「${short}」解析不到角色（别名目标「${full}」不存在）`);
  }
  for (const [short, full] of Object.entries(CHARACTER_ALIASES)) {
    if (seenNames.has(short)) bad('CHARACTER_ALIASES', `「${short}」本身就是全名，不该出现在别名表`);
    if (!seenNames.has(full)) bad('CHARACTER_ALIASES', `别名「${short}」的目标「${full}」不在角色表`);
  }

  return problems;
}

/** 跑校验并把问题打到 console；返回是否通过。 */
export function assertData() {
  const problems = validateData();
  if (problems.length === 0) return true;
  console.error(`[数据自检] 发现 ${problems.length} 处结构问题：`);
  for (const p of problems) console.error(`  - ${p.scope}：${p.message}`);
  return false;
}
