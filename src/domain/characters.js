// 角色查找。
//
// 只做精确匹配，三级依次尝试：全名 → 别名 → 反查别名。
// 刻意不做子串匹配：旧实现用 `r.name.includes(name)` 与 `name.includes(r.name)` 兜底，
// 会把「安比」匹配到「零号·安比」、「比利」匹配到「星徽·比利」，而「猫又」这类
// 真需要的短名反倒匹配不上（`猫宫又奈` 不含「猫又」二字）。缺的短名一律补进别名表。

import { CHARACTER_ALIASES, CHARACTER_DATA } from '../data/characters.js';

/** 全名 → 角色对象。数据无重名，59 条一一对应。 */
const BY_NAME = new Map();
/** 别名 → 全名。 */
const ALIAS_TO_NAME = new Map(Object.entries(CHARACTER_ALIASES));
for (const faction of CHARACTER_DATA) {
  for (const role of faction.roles) BY_NAME.set(role.name, role);
}

/**
 * 按导入数据里的角色名查角色。
 *
 * @param {string} name Enka 的短名，或角色全名。
 * @returns {object|null} 角色对象；查不到返回 null（不猜）。
 */
export function findCharacterByImportedName(name) {
  const raw = typeof name === 'string' ? name.replace(/^[「『]+|[」』]+$/g, '').trim() : '';
  if (!raw) return null;
  return BY_NAME.get(raw) ?? BY_NAME.get(ALIAS_TO_NAME.get(raw)) ?? null;
}
