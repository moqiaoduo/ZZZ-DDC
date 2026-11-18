import { applyTheme } from '../ui/theme.js';

// 应用状态。原先是散落在脚本顶部的 6 个可变全局，全部收进这一个对象，
// 谁在读、谁在写都从这里能查清。

export const state = {
  /** 当前选中的角色（顺序即面板顺序，索引会变，不要当身份用）。 */
  gameSelectedChars: [],
  /** 上次导入的角色名，用于「一键保存」。 */
  lastImportedChars: [],
  /** 角色面板的 DOM 片段缓存，键是角色名。 */
  charConfigsCache: {},
  /** 上一次游戏版计算的过程数据，用于推荐文案。 */
  extractionList: [],
  /** 用户设置，持久化在 localStorage 的 zzz_calc_settings。 */
  settings: {
    autoCollapseImport: true,
    autoCollapseOutput: true,
  },
};

// 读取设置。原来的写法是顶层 try/catch 吞掉异常，这里保留同样的语义：
// 存档坏了就当没有，不让页面白屏——但不再完全无声，出问题会在控制台留一行。
try {
  const raw = localStorage.getItem('zzz_calc_settings');
  if (raw) Object.assign(state.settings, JSON.parse(raw));
} catch (e) {
  console.warn('设置读取失败，使用默认值：', e);
}

export function saveSettings() {
  localStorage.setItem('zzz_calc_settings', JSON.stringify(state.settings));
}
