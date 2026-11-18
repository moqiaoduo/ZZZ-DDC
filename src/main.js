// 入口。绑定事件、启动应用。
// 原先是 <script> 末尾的若干条顶层语句，现在收拢到这里，加载顺序一目了然。

import { renderCharacterGrid, renderFactionTabs, togglePosition } from './app/character-panel.js';
import { calculateAdvanced, generateAdvancedEntries, toggleCustomDirect } from './app/custom-calc.js';
import {
  limitGameDirect,
  onMainEntryChange,
  toggleGameDirect,
  updateCharWeights,
} from './app/entries.js';
import { calculateGame } from './app/game-calc.js';
import { importFromJSON, updateJsonLink } from './app/importer.js';
import { calcPosScore } from './app/positions.js';
import {
  deleteCurrentSave,
  newSave,
  oneClickSaveImported,
  readCurrentSave,
  renameCurrentSave,
  saveCurrentConfig,
  syncSaveSelects,
} from './app/saves.js';
import { state } from './app/store.js';
import { themes } from './data/themes.js';
import {
  applyTheme,
  closeSettingsModal,
  closeTutorialModal,
  initThemeSelector,
  openSettingsModal,
  openTutorialModal,
  updateSetting,
} from './ui/theme.js';

document.getElementById('theme-toggle-btn').addEventListener('click', function() { var panel = document.getElementById('theme-selector'); panel.classList.toggle('active'); this.textContent = panel.classList.contains('active') ? '✕ 关闭配色' : '配色'; });

document.getElementById('update-log-btn').addEventListener('click', function() { document.getElementById('update-log-modal').style.display = 'flex'; });

document.getElementById('use-tutorial-btn').addEventListener('click', openTutorialModal);

document.getElementById('sponsor-wrapper').onclick = function() { var modal = document.getElementById('qr-modal'); var modalImg = document.getElementById('qr-modal-img'); modal.style.display = 'flex'; modalImg.src = this.querySelector('img').src; }

document.getElementById('settings-toggle-btn').addEventListener('click', openSettingsModal);

document.querySelectorAll('.tab-btn').forEach(b => b.addEventListener('click', () => { document.querySelectorAll('.tab-btn').forEach(x => x.classList.remove('active')); document.querySelectorAll('.panel').forEach(p => p.classList.remove('active')); b.classList.add('active'); document.getElementById(`${b.dataset.mode}-panel`).classList.add('active'); document.getElementById('result-area').style.display = 'none'; }));

document.addEventListener('change', function(e) { const target = e.target; if (target.classList.contains('char-save-select') || target.classList.contains('char-save-select-top') || target.classList.contains('char-save-select-bottom')) { const idx = parseInt(target.dataset.idx); if (!isNaN(idx)) syncSaveSelects(idx, target); } });

window.onload = () => { initThemeSelector(); generateAdvancedEntries(); renderFactionTabs('game-faction-tabs'); renderCharacterGrid(0); applyTheme(themes[0]); }

/**
 * 把内联处理器要用到的函数挂回 window。
 *
 * 静态标记里写的是 onclick="calculateGame()"，这类属性在全局作用域求值。模块里的
 * 函数不是全局的，所以必须显式暴露，否则按钮全部失灵且不报错（见 split.mjs 注释）。
 * 后续把内联写法换掉之后，这一段可以整块删除。
 */
Object.assign(window, {
  calcPosScore,
  calculateAdvanced,
  calculateGame,
  closeSettingsModal,
  closeTutorialModal,
  deleteCurrentSave,
  generateAdvancedEntries,
  importFromJSON,
  limitGameDirect,
  newSave,
  onMainEntryChange,
  oneClickSaveImported,
  readCurrentSave,
  renameCurrentSave,
  saveCurrentConfig,
  toggleCustomDirect,
  toggleGameDirect,
  togglePosition,
  updateCharWeights,
  updateJsonLink,
  updateSetting,
});
