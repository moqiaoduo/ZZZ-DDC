// 角色查找与数据自检的回归测试。
//
// 这里守的是两类曾经真出过问题的契约：
//   1. 名字解析：旧实现用子串兜底，既漏（「猫又」匹配不到「猫宫又奈」）又错
//      （「比利」会命中「星徽·比利」）。现在只做精确匹配 + 别名。
//   2. 表间结构：词条索引 0-9 在五处并行定义、角色名跨三张表对齐、weights 必须与
//      ENTRY_NAMES 等长。任何一处漏改都不会抛异常，只会让数值悄悄变错。

import { CHARACTER_ALIASES, CHARACTER_DATA } from '../src/data/characters.js';
import { ENKA_ID_MAP } from '../src/data/enka-mapping.js';
import { ENTRY_NAMES } from '../src/data/game-config.js';
import { validateData } from '../src/data/validate.js';
import { findCharacterByImportedName } from '../src/domain/characters.js';

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (e) {
    failures.push({ name, message: e.message });
  }
}

function eq(actual, expected, what) {
  if (actual !== expected) throw new Error(`${what}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

function ok(value, what) {
  if (!value) throw new Error(what);
}

const ROLES = CHARACTER_DATA.flatMap((f) => f.roles);
const NAMES = new Set(ROLES.map((r) => r.name));

// ── A. 名字解析：旧模糊匹配的坏例，现在必须判对 ────────────────────────
check('A1「猫又」能命中「猫宫又奈」（旧实现返回 null）', () => {
  eq(findCharacterByImportedName('猫又')?.name, '猫宫又奈', '猫又');
});

check('A2「雅」「悠真」「柳」分别命中全名', () => {
  eq(findCharacterByImportedName('雅')?.name, '星见雅', '雅');
  eq(findCharacterByImportedName('悠真')?.name, '浅羽悠真', '悠真');
  eq(findCharacterByImportedName('柳')?.name, '月城柳', '柳');
});

check('A3「安比」命中「安比·德玛拉」，不命中「零号·安比」', () => {
  eq(findCharacterByImportedName('安比')?.name, '安比·德玛拉', '安比');
});

check('A4「比利」命中「比利·奇德」，不命中「星徽·比利」', () => {
  eq(findCharacterByImportedName('比利')?.name, '比利·奇德', '比利');
});

check('A5「星徽·比利」精确命中全名角色', () => {
  eq(findCharacterByImportedName('星徽·比利')?.name, '星徽·比利', '星徽·比利');
});

check('A6「零号·安比」精确命中自己，不被「安比」抢走', () => {
  eq(findCharacterByImportedName('零号·安比')?.name, '零号·安比', '零号·安比');
});

check('A7 无名片段不再返回任何角色', () => {
  eq(findCharacterByImportedName('安'), null, '单字「安」');
  eq(findCharacterByImportedName('乔'), null, '单字「乔」');
  eq(findCharacterByImportedName('不存在的角色'), null, '不存在的名字');
});

check('A8 空值与非字符串不抛异常，返回 null', () => {
  for (const v of ['', '   ', null, undefined, 0, {}, []]) {
    eq(findCharacterByImportedName(v), null, `输入 ${JSON.stringify(v)}`);
  }
});

check('A9 剥离书名号后仍能命中（旧存档里带「」）', () => {
  eq(findCharacterByImportedName('「扳机」')?.name, '扳机', '「扳机」');
  eq(findCharacterByImportedName('「11号」')?.name, '11号', '「11号」');
});

check('A10 Enka 的 59 个短名全部能解析回角色', () => {
  for (const [id, short] of Object.entries(ENKA_ID_MAP)) {
    const role = findCharacterByImportedName(short);
    ok(role, `ID ${id} 的短名「${short}」解析不到角色`);
    eq(role.image, `assets/characters/${id}.png`, `ID ${id}（${short}）的头像`);
  }
});

check('A11 59 个角色全名都能解析到自己', () => {
  for (const r of ROLES) eq(findCharacterByImportedName(r.name)?.name, r.name, r.name);
});

// ── B. 别名表本身 ───────────────────────────────────────────────────
check('B1 别名条数为 29，每一条都有用（目标存在、键不是全名）', () => {
  eq(Object.keys(CHARACTER_ALIASES).length, 29, '别名条数');
  for (const [short, full] of Object.entries(CHARACTER_ALIASES)) {
    ok(NAMES.has(full), `别名「${short}」的目标「${full}」不在角色表`);
    ok(!NAMES.has(short), `别名键「${short}」本身就是全名，冗余`);
  }
});

check('B2 每个别名都是某个 Enka 短名的解析途径（无游离条目）', () => {
  const shorts = new Set(Object.values(ENKA_ID_MAP));
  for (const short of Object.keys(CHARACTER_ALIASES)) ok(shorts.has(short), `别名「${short}」不对应任何 Enka 短名`);
});

// ── C. 数据自检本身 ─────────────────────────────────────────────────
check('C1 当前数据通过校验', () => {
  const problems = validateData();
  eq(problems.length, 0, `问题列表：${JSON.stringify(problems.slice(0, 5))}`);
});

check('C2 校验能发现 weights 长度不对（注入坏副本）', () => {
  const role = ROLES[0];
  const saved = role.weights;
  try {
    role.weights = saved.slice(0, 9);
    const problems = validateData();
    ok(problems.some((p) => p.message.includes('weights 长度 9')), '没报出 weights 长度问题');
  } finally {
    role.weights = saved;
  }
  eq(validateData().length, 0, '复原后应重新通过');
});

check('C3 校验能发现角色重名', () => {
  const dup = { ...ROLES[0] };
  try {
    CHARACTER_DATA[1].roles.push(dup);
    const problems = validateData();
    ok(problems.some((p) => p.message.includes('角色名重复')), '没报出重名');
  } finally {
    CHARACTER_DATA[1].roles.pop();
  }
  eq(validateData().length, 0, '复原后应重新通过');
});

check('C4 校验能发现别名指向不存在的角色', () => {
  try {
    CHARACTER_ALIASES.__probe__ = '不存在的角色';
    const problems = validateData();
    ok(problems.some((p) => p.message.includes('不存在的角色')), '没报出悬空别名');
  } finally {
    delete CHARACTER_ALIASES.__probe__;
  }
  eq(validateData().length, 0, '复原后应重新通过');
});

check('C5 校验能发现图片路径不符合约定', () => {
  const role = ROLES[0];
  const saved = role.image;
  try {
    role.image = '屏幕截图 2026-08-16 163440.png';
    const problems = validateData();
    ok(problems.some((p) => p.message.includes('不符合 assets/characters')), '没报出图片路径问题');
  } finally {
    role.image = saved;
  }
  eq(validateData().length, 0, '复原后应重新通过');
});

// ── D. 词条表长度契约 ───────────────────────────────────────────────
check('D1 59 个角色的 weights 全部与 ENTRY_NAMES 等长', () => {
  for (const r of ROLES) eq(r.weights.length, ENTRY_NAMES.length, `${r.name} 的 weights`);
});

check('D2 角色数与阵营数符合数据（59 / 19）', () => {
  eq(ROLES.length, 59, '角色数');
  eq(CHARACTER_DATA.length, 19, '阵营数');
});

// ── 结果 ────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`\n失败 ${failures.length} 项：`);
  for (const f of failures) console.error(`  ✗ ${f.name}\n    ${f.message}`);
  console.error(`\n通过 ${passed} 项，失败 ${failures.length} 项`);
  process.exit(1);
}
console.log(`角色查找与数据自检：全部通过 ${passed} 项`);
