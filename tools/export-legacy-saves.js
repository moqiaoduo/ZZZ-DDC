/* 旧站存档导出脚本 —— 在旧版页面（qfmyqqx.github.io/ZZZ-DDC）的浏览器 Console 里整段粘贴执行。
 *
 * 背景：新站把存档键从 zzz_disk_saves_${角色显示名} 换成 zzz.ddc.v2.saves.${charId}
 *       （显示名会变，数字 ID 不会），且不做双读兼容——旧键在新站一律不读。
 *       所以换键之前必须先给用户一个出口：本脚本把旧存档原样搬出来存成 JSON。
 *
 * 完整链路（三步，缺一不可）：
 *   1. 本脚本       在旧站 Console 跑 → 下载 zzz-ddc-saves-<时间>.json
 *   2. migrate-legacy-saves.mjs  本地跑 → 生成 apply-in-console.js
 *   3. apply-in-console.js       在新站 Console 跑 → 写入新键
 * 第 1 步必须在旧站还能打开的时候做；旧键不会自动失效，但新站不再读它们。
 *
 * 设计约束：
 *   1. 纯搬运，不解析业务结构。解析留给导入侧（那边有角色表，这里没有可信的角色表）。
 *   2. 不依赖页面上的任何函数或变量（旧站的 findCharacterByImportedName 等随时可能被改）。
 *   3. 自检只做「能不能 JSON.parse / 是不是数组 / 每条有没有 name 与 data」，
 *      发现问题记进 warnings 而不中断——半份数据也比零份强。
 *   4. 同时写 window.__zzzLegacyExport 便于调试与自动化测试。
 */
(function exportLegacySaves() {
  'use strict';

  var SAVE_PREFIX = 'zzz_disk_saves_';
  var SETTINGS_KEY = 'zzz_calc_settings';
  var FORMAT = 'zzz-ddc/legacy-saves';
  var VERSION = 1;

  function warn(list, msg) { list.push(msg); }

  function build() {
    var payload = {
      format: FORMAT,
      version: VERSION,
      exportedAt: new Date().toISOString(),
      source: (typeof location !== 'undefined' ? location.href : 'unknown'),
      origin: (typeof location !== 'undefined' ? location.origin : 'unknown'),
      characters: {},
      settings: null,
      warnings: []
    };
    var w = payload.warnings;

    if (typeof localStorage === 'undefined') {
      warn(w, '当前环境没有 localStorage，无法导出。');
      return payload;
    }

    var keys = [];
    for (var i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
    keys.sort();

    var saveKeys = keys.filter(function (k) { return k && k.indexOf(SAVE_PREFIX) === 0; });

    if (saveKeys.length === 0) {
      warn(w, '没找到任何 ' + SAVE_PREFIX + '* 键。可能你不在旧站页面上，或从未存过档。');
    }

    var totalSaves = 0;
    saveKeys.forEach(function (key) {
      var charName = key.slice(SAVE_PREFIX.length);
      var raw = localStorage.getItem(key);
      if (raw === null) { warn(w, charName + '：键存在但读取为 null，已跳过。'); return; }

      var list;
      try {
        list = JSON.parse(raw);
      } catch (e) {
        warn(w, charName + '：JSON 解析失败（' + e.message + '），原始内容已保留在 raw 字段。');
        payload.characters[charName] = { broken: true, raw: raw };
        return;
      }
      if (!Array.isArray(list)) {
        warn(w, charName + '：解析结果不是数组，原始内容已保留在 raw 字段。');
        payload.characters[charName] = { broken: true, raw: raw };
        return;
      }
      if (list.length === 0) {
        warn(w, charName + '：存档列表为空，跳过了。');
        return;
      }

      var clean = [];
      list.forEach(function (entry, idx) {
        if (!entry || typeof entry !== 'object') {
          warn(w, charName + '[' + idx + ']：不是对象，已跳过。');
          return;
        }
        if (typeof entry.name !== 'string' || !entry.name) {
          warn(w, charName + '[' + idx + ']：缺少 name，已跳过。');
          return;
        }
        if (!entry.data || typeof entry.data !== 'object') {
          warn(w, charName + '[' + idx + ']：缺少 data，已跳过。');
          return;
        }
        if (entry.data.charName && entry.data.charName !== charName) {
          warn(w, charName + '[' + idx + ']：data.charName 是「' + entry.data.charName +
            '」，与键名不一致（角色改过名？）。已按原样保留，导入时可能被守卫拦下。');
        }
        clean.push({ name: entry.name, data: entry.data });
      });

      if (clean.length > 0) {
        payload.characters[charName] = { saves: clean };
        totalSaves += clean.length;
      }
    });

    var rawSettings = localStorage.getItem(SETTINGS_KEY);
    if (rawSettings !== null) {
      try {
        payload.settings = JSON.parse(rawSettings);
      } catch (e) {
        warn(w, '设置项解析失败（' + e.message + '），已忽略。');
      }
    }

    payload.stats = {
      saveKeys: saveKeys.length,
      charactersWithSaves: Object.keys(payload.characters).length,
      totalSaves: totalSaves
    };

    // 顺手列出 localStorage 里其他不属于本应用的键，帮用户确认没漏东西。
    var others = keys.filter(function (k) {
      return k && k.indexOf(SAVE_PREFIX) !== 0 && k !== SETTINGS_KEY;
    });
    if (others.length > 0) payload.otherKeys = others;

    return payload;
  }

  function download(payload) {
    if (typeof document === 'undefined' || typeof Blob === 'undefined') return false;
    try {
      var text = JSON.stringify(payload, null, 2);
      var blob = new Blob([text], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      var stamp = payload.exportedAt.replace(/[:.]/g, '-');
      a.href = url;
      a.download = 'zzz-ddc-saves-' + stamp + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
      return true;
    } catch (e) {
      return false;
    }
  }

  var payload = build();
  if (typeof window !== 'undefined') window.__zzzLegacyExport = payload;

  var downloaded = download(payload);

  /* eslint-disable no-console */
  console.log('%c旧站存档导出', 'font-weight:bold;font-size:14px');
  console.log('来源 origin：' + payload.origin);
  console.log('存档键：' + payload.stats.saveKeys + ' 个，涉及角色 ' +
    payload.stats.charactersWithSaves + ' 个，共 ' + payload.stats.totalSaves + ' 条存档');
  if (Object.keys(payload.characters).length) {
    console.table(Object.keys(payload.characters).map(function (n) {
      var v = payload.characters[n];
      return { 角色: n, 存档数: v.broken ? '损坏' : v.saves.length };
    }));
  }
  if (payload.warnings.length) {
    console.log('%c警告 ' + payload.warnings.length + ' 条：', 'color:#c60');
    payload.warnings.forEach(function (m) { console.log('  · ' + m); });
  }
  if (payload.otherKeys) {
    console.log('localStorage 里还有这些不属于本应用的键（未导出）：' + payload.otherKeys.join(', '));
  }
  if (downloaded) {
    console.log('%c已下载 JSON 文件，去新站用它导入。', 'color:#080');
  } else {
    console.log('%c自动下载失败，请手动复制：copy(__zzzLegacyExport)', 'color:#c00');
    console.log('或执行 copy(JSON.stringify(__zzzLegacyExport)) 后再粘贴到文件里。');
  }
  return payload;
})();
