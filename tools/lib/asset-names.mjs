/**
 * 图片资产的新命名——唯一真相源。
 *
 * 为什么单独成文件：这套映射有两个消费者，方向相反。
 *   tools/rename-assets.mjs  仓库里真实文件的重命名（一次性）
 *   tools/split.mjs          从 legacy/ 的旧文档生成骨架时，要把引用改成新名
 * 两处各写一份必然漂移，所以放在这里。
 *
 * 角色头像是 assets/characters/<ENKA_ID>.png，ID 不写死在表里——它来自
 * tools/lib/legacy-migration-core.mjs 的三表对账（59 个角色全部可解析出唯一
 * ID）。写死一份 1021→猫宫又奈 之类的映射，等于给已经对齐的三张表再造第四张。
 */

/**
 * 非角色图的固定改名表。键是旧文件名（含空格与中文），值是仓库内新路径。
 *
 * 三个 163xxx 的用途是从代码上下文读出来的，不是猜游戏内名词：
 *   163440 → 音像店（随机抽取）的货币，出现在「音像店刷出更好驱动盘期望消耗」
 *   163519 → 定向位置道具，出现在「定向位置…期望消耗」
 *   163459 → 定向主词条道具，出现在 hasDirect 分支
 * 按「这一行代码在算什么」取名，猜错官方名词比名字难看更糟。
 */
export const FIXED_ASSET_NAMES = new Map([
  ['屏幕截图 2026-08-16 163440.png', 'assets/costs/tape.png'],
  ['屏幕截图 2026-08-16 163519.png', 'assets/costs/directed-position.png'],
  ['屏幕截图 2026-08-16 163459.png', 'assets/costs/directed-substat.png'],
  ['计算器图标.jpg', 'assets/site/logo.jpg'],
  ['微信图片_20260817233740.jpg', 'assets/site/reward-qr.jpg'],
]);

/** 角色头像的目标路径。 */
export function characterAssetPath(enkaId) {
  return `assets/characters/${enkaId}.png`;
}

/**
 * 把一段文本里的旧图片名全部换成新路径。
 *
 * 用「长名优先」排序做替换：`计算器图标.jpg` 是 `计算器图标.jpg.bak` 的前缀，
 * 短名先替换会留下残渣。这里面没有真出现这种文件名，但顺序依赖是免费的保险。
 */
export function rewriteAssetRefs(text, { nameToId } = {}) {
  let out = text;
  const pairs = [...FIXED_ASSET_NAMES.entries()].sort((a, b) => b[0].length - a[0].length);
  if (nameToId) {
    for (const [name, id] of nameToId) pairs.push([name, characterAssetPath(id)]);
  }
  for (const [from, to] of pairs) out = out.split(from).join(to);
  return out;
}
