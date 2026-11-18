/**
 * 旧站存档 → v2 存档 的转换内核。
 *
 * 这个文件被两处共用，所以刻意不碰 fs、不碰 process、不碰 DOM——
 * 只接收「已经取出来的角色表」和「已经解析好的旧站导出对象」，返回纯数据。
 *
 *   tools/migrate-legacy-saves.mjs  命令行版：读 index.html + 读写文件
 *   tools/migrate-server.mjs        本地小工具页：HTTP 服务端调用
 *
 * 两边共用同一份逻辑，是为了避免「CLI 修了、页面没修」这种漂移。
 */

/** 新键规范。改这里必须同步改新站 infra/storage.js，两处不一致会导致读不到档。 */
export const SCHEMA = 2;
export const PREFIX_SAVES = 'zzz.ddc.v2.saves.';
export const KEY_SETTINGS = 'zzz.ddc.v2.settings';
export const KEY_SCHEMA = 'zzz.ddc.v2.schema';
export const LEGACY_FORMAT = 'zzz-ddc/legacy-saves';

/**
 * 四个角色在「短名 → 全名」的别名表里缺项，旧站只能靠模糊匹配兜到正确的人，
 * 而「猫又」连模糊匹配都兜不住（猫宫又奈 不含 猫又 二字，实测返回 null）。
 * 这里显式补齐，让迁移不依赖模糊匹配——新站会删掉那两级兜底。
 */
export const ALIAS_PATCH = { '猫又': '猫宫又奈', '雅': '星见雅', '悠真': '浅羽悠真', '柳': '月城柳' };

/** 只搬认识的设置键，未知键记下来不丢也不写。 */
export const KNOWN_SETTINGS = ['autoCollapseImport', 'autoCollapseOutput'];

/** 旧键名里常带「」书名号，报告里再包一层就成「「扳机」」了，展示前先剥掉。 */
export function stripBrackets(name) {
  return String(name == null ? '' : name).replace(/^[「『]+|[」』]+$/g, '');
}

/**
 * 用三张角色表构建「名字 → 稳定 ID」的解析器。
 *
 * @param {object} tables
 * @param {Array}  tables.CHARACTER_DATA  index.html 的角色表（全名）
 * @param {object} tables.ENKA_ID_MAP     { 数字ID: 短名 }
 * @param {object} tables.ALIAS_MAP       aliasMap（短名 → 全名）
 * @returns {{resolveCharId, NAME_TO_ID, ID_TO_NAME, unresolvedNames, orphanIds, ok}}
 */
export function buildRoleTables({ CHARACTER_DATA, ENKA_ID_MAP, ALIAS_MAP }) {
  const fullToShort = {};
  for (const [short, full] of Object.entries(ALIAS_MAP || {})) if (short !== full) fullToShort[full] = short;

  // ALIAS_PATCH 的键是短名，需要一张「全名 → 短名」的反向表才查得到
  const patchFullToShort = {};
  for (const [short, full] of Object.entries(ALIAS_PATCH)) patchFullToShort[full] = short;

  const shortToId = {};
  for (const [id, short] of Object.entries(ENKA_ID_MAP || {})) shortToId[short] = Number(id);

  const NAME_TO_ID = {};
  const ID_TO_NAME = {};
  const unresolvedNames = [];

  for (const faction of CHARACTER_DATA || []) {
    for (const role of faction.roles || []) {
      const short = fullToShort[role.name] ?? patchFullToShort[role.name] ?? role.name;
      const id = shortToId[short];
      if (id === undefined) { unresolvedNames.push(role.name); continue; }
      NAME_TO_ID[role.name] = id;
      ID_TO_NAME[id] = role.name;
    }
  }

  const orphanIds = Object.keys(ENKA_ID_MAP || {}).map(Number).filter(id => !(id in ID_TO_NAME));

  /**
   * 旧键名 → 稳定 ID。
   *
   * 旧站的键是「角色显示名」，而显示名在两套表里不一致：
   *   - CHARACTER_DATA 用全名（艾莲·乔、11号、扳机）
   *   - ENKA_ID_MAP 用短名（艾莲、11号、扳机）
   *   - 部分存档键还带着「」书名号
   *
   * 按优先级逐级归一，**不做模糊匹配**——旧站靠 includes 兜底，
   * 正是新站要删掉的那两级（会把「安比」串到「零号·安比」）。
   * 归一失败返回 undefined，由调用方隔离，不悄悄写错角色。
   */
  function resolveCharId(rawName) {
    if (typeof rawName !== 'string' || !rawName) return undefined;
    const name = rawName.replace(/[「」『』\s]/g, '');

    if (NAME_TO_ID[name] !== undefined) return NAME_TO_ID[name];          // 全名直接命中

    const short = fullToShort[name] ?? patchFullToShort[name] ?? name;
    if (shortToId[short] !== undefined) return shortToId[short];           // 短名命中

    const viaAlias = ALIAS_MAP?.[name] ?? ALIAS_PATCH[name];
    if (viaAlias && NAME_TO_ID[viaAlias] !== undefined) return NAME_TO_ID[viaAlias];

    return undefined;
  }

  const ok = unresolvedNames.length === 0 && orphanIds.length === 0;
  return { resolveCharId, NAME_TO_ID, ID_TO_NAME, unresolvedNames, orphanIds, ok };
}

/**
 * 把一份旧站导出对象转成新键映射。
 *
 * @param {object} legacy   export-legacy-saves.js 的产物
 * @param {object} tables   buildRoleTables() 的返回值
 * @returns {{ok: boolean, error?: string, payload?: object, report?: object}}
 */
export function migrateLegacyExport(legacy, tables) {
  if (!legacy || legacy.format !== LEGACY_FORMAT) {
    return { ok: false, error: '文件格式不对（期望 format 为 "' + LEGACY_FORMAT + '"）。请确认用的是旧站导出的那份文件。' };
  }

  const { resolveCharId, ID_TO_NAME } = tables;
  const migrated = {};
  const report = {
    source: legacy.source,
    origin: legacy.origin,
    exportedAt: legacy.exportedAt,
    ok: [],                   // { charName, charId, legacyName, newKey, count }
    renamed: [],              // 旧键名与记录内 charName 不一致 / 多份键合并
    quarantined: [],          // { charName, reason, payload }
    skipped: [],              // 空列表、全条无效等
    settings: null,
  };

  for (const [legacyName, entry] of Object.entries(legacy.characters || {})) {
    if (entry && entry.broken) {
      report.quarantined.push({ charName: legacyName, reason: '旧站那份数据本身是坏的（JSON 解析失败或不是数组）', payload: entry });
      continue;
    }
    const saves = entry && entry.saves;
    if (!Array.isArray(saves) || saves.length === 0) {
      report.skipped.push({ charName: legacyName, reason: '没有有效存档' });
      continue;
    }

    // 身份判定优先用键名，因为旧站的键名就是查找依据；记录内 charName 只用于对账。
    let finalCharId = resolveCharId(legacyName);
    if (finalCharId === undefined) {
      // 键名可能是残缺的显示名，记录里反而是全名
      finalCharId = saves.map(s => resolveCharId(s && s.data && s.data.charName)).find(x => x !== undefined);
      if (finalCharId === undefined) {
        report.quarantined.push({
          charName: legacyName,
          reason: '当前角色表里没有这个名字（旧站可能有已删除/改名的角色）',
          payload: entry,
        });
        continue;
      }
      report.renamed.push({
        legacyName,
        note: '键名无法归一，按记录内 charName 归到 ' + ID_TO_NAME[finalCharId],
        mergedInto: PREFIX_SAVES + finalCharId,
      });
    }

    const canonicalName = ID_TO_NAME[finalCharId];
    const migratedSaves = [];
    for (const s of saves) {
      const data = s.data || {};
      if (data.charName !== legacyName) {
        report.renamed.push({
          legacyName,
          insideCharName: data.charName,
          saveName: s.name,
          resolvedTo: canonicalName,
          charId: finalCharId,
        });
      }
      migratedSaves.push({
        name: s.name,
        data: {
          ...data,
          // 身份字段改为 ID + 规范名，新站不再依赖这里做匹配
          charId: finalCharId,
          charName: canonicalName,
          legacyCharName: legacyName,
        },
      });
    }

    const newKey = PREFIX_SAVES + finalCharId;
    if (migrated[newKey]) {
      // 同一角色被两套键名存过（改名前后各存一份）——合并，不覆盖。
      const existing = JSON.parse(migrated[newKey]);
      existing.saves.push(...migratedSaves);
      existing.mergedFrom.push(legacyName);
      migrated[newKey] = JSON.stringify(existing);
      // 汇总表里那一行的条数也要跟着涨，否则总数比实际少算
      const okRow = report.ok.find(r => r.newKey === newKey);
      if (okRow) okRow.count = existing.saves.length;
      report.renamed.push({ legacyName, mergedInto: newKey, note: '同名角色存在多份旧键，已合并' });
      continue;
    }

    migrated[newKey] = JSON.stringify({
      schema: SCHEMA,
      charId: finalCharId,
      charName: canonicalName,
      mergedFrom: [legacyName],
      saves: migratedSaves,
    });
    report.ok.push({ charName: canonicalName, charId: finalCharId, legacyName, newKey, count: migratedSaves.length });
  }

  // 设置项：只搬认识的键，未知键记下来不丢
  if (legacy.settings && typeof legacy.settings === 'object') {
    const kept = {};
    const dropped = [];
    for (const [k, v] of Object.entries(legacy.settings)) {
      if (KNOWN_SETTINGS.includes(k)) kept[k] = v; else dropped.push(k);
    }
    if (Object.keys(kept).length) migrated[KEY_SETTINGS] = JSON.stringify(kept);
    report.settings = { migrated: kept, droppedUnknown: dropped };
  }

  migrated[KEY_SCHEMA] = String(SCHEMA);

  const payload = {
    format: 'zzz-ddc/migrated-saves',
    version: SCHEMA,
    migratedAt: new Date().toISOString(),
    sourceOrigin: legacy.origin,
    keys: migrated,
    quarantine: report.quarantined,
  };

  return { ok: true, payload, report };
}

/** 新站 Console 里粘贴执行的回写脚本。幂等：重复跑只覆盖同名键。 */
export function buildApplyScript(keys) {
  return `/* 在新站页面 Console 里整段粘贴执行：把转换好的存档写进 localStorage。
 * 幂等：重复执行只会覆盖同名新键，不会产生重复条目。
 * 执行前请确认已在新站 origin 下（而不是旧站）。
 */
(function applyMigratedSaves() {
  'use strict';
  var PAYLOAD = ${JSON.stringify({ keys }, null, 2)};
  var n = 0, bytes = 0;
  Object.keys(PAYLOAD.keys).forEach(function (k) {
    var v = PAYLOAD.keys[k];
    localStorage.setItem(k, v);
    n++; bytes += v.length;
  });
  console.log('%c已写入 ' + n + ' 个键，共 ' + (bytes / 1024).toFixed(1) + ' KB。', 'color:#080;font-weight:bold');
  console.log('刷新页面即可看到存档。');
  return n;
})();
`;
}

/** 人读的迁移报告（markdown）。 */
export function buildReportMarkdown(payload, report, now) {
  const md = [];
  md.push('# 旧站存档迁移报告');
  md.push('');
  md.push('- 来源：' + (report.origin || '未知') + '（导出于 ' + report.exportedAt + '）');
  md.push('- 转换时间：' + (now || payload.migratedAt));
  md.push('- 成功搬运：**' + report.ok.reduce((s, x) => s + x.count, 0) + '** 条存档，覆盖 **' + report.ok.length + '** 个角色');
  md.push('- 隔离未写入：' + report.quarantined.length + ' 个角色');
  md.push('- 跳过：' + report.skipped.length + ' 个键');
  md.push('');
  if (report.ok.length) {
    md.push('## 已搬运');
    md.push('');
    md.push('| 角色 | 稳定 ID | 旧键名 | 存档数 |');
    md.push('|---|---|---|---|');
    report.ok.forEach(x => md.push('| ' + x.charName + ' | ' + x.charId + ' | ' + x.legacyName + ' | ' + x.count + ' |'));
    md.push('');
  }
  if (report.renamed.length) {
    md.push('## 键名与记录内名字不一致（已按键名归一）');
    md.push('');
    report.renamed.forEach(x => {
      if (x.mergedInto) md.push('- 「' + stripBrackets(x.legacyName) + '」→ ' + x.mergedInto + '（' + x.note + '）');
      else md.push('- 存档「' + x.saveName + '」记录内写的是「' + stripBrackets(x.insideCharName) + '」，键名是「' + stripBrackets(x.legacyName) + '」→ 归到 ' + x.resolvedTo + '(' + x.charId + ')');
    });
    md.push('');
  }
  if (report.quarantined.length) {
    md.push('## 隔离（未写入，原始数据保留在 migrated.json 的 quarantine 字段里）');
    md.push('');
    report.quarantined.forEach(x => md.push('- **' + x.charName + '**：' + x.reason));
    md.push('');
  }
  if (report.skipped.length) {
    md.push('## 跳过');
    md.push('');
    report.skipped.forEach(x => md.push('- ' + x.charName + '：' + x.reason));
    md.push('');
  }
  if (report.settings) {
    md.push('## 设置项');
    md.push('');
    md.push('- 已迁移：' + (Object.keys(report.settings.migrated).join(', ') || '无'));
    if (report.settings.droppedUnknown.length) md.push('- 不认识、未迁移：' + report.settings.droppedUnknown.join(', '));
    md.push('');
  }
  md.push('## 怎么用');
  md.push('');
  md.push('1. 打开新站页面（同一个浏览器）。');
  md.push('2. F12 → Console，粘贴 `apply-in-console.js` 全部内容，回车。');
  md.push('3. 刷新页面。');
  md.push('');
  md.push('> `migrated.json` 是同一份数据的结构化版本，也可以由新站的「导入旧站存档」按钮读取。');
  return md.join('\n');
}