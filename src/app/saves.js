// 档位存取：localStorage 读写、存档命名/重命名/删除。

import { createPositionConfig } from './character-panel.js';
import { getGameDirectTypes, toggleGameDirect, updateCharWeights } from './entries.js';
import {
  calcPosScore,
  getCurrentPositions,
  getSelectedMainForPos,
  updatePosScale,
} from './positions.js';
import { state } from './store.js';

export function getSavesKey(chName) { return `zzz_disk_saves_${chName}`; }

export function loadSavesList(chName) { const raw = localStorage.getItem(getSavesKey(chName)); if (!raw) return []; try { return JSON.parse(raw); } catch (e) { return []; } }

export function saveSavesList(chName, list) { localStorage.setItem(getSavesKey(chName), JSON.stringify(list)); }

export function refreshSaveSelect(idx) { const mainSelect = document.getElementById(`char-save-select-${idx}`); const topSelect = document.getElementById(`char-save-select-top-${idx}`); const bottomSelect = document.getElementById(`char-save-select-bottom-${idx}`); if (!mainSelect || !state.gameSelectedChars[idx]) return; const chName = state.gameSelectedChars[idx].name; const saves = loadSavesList(chName); const fill = (select) => { if (!select) return; select.innerHTML = ''; saves.forEach((s, i) => { const option = document.createElement('option'); option.value = i; option.textContent = s.name; select.appendChild(option); }); if (saves.length === 0) { const option = document.createElement('option'); option.value = ''; option.textContent = '暂无存档'; select.appendChild(option); } }; fill(mainSelect); fill(topSelect); fill(bottomSelect); if (topSelect) topSelect.value = mainSelect.value; if (bottomSelect) bottomSelect.value = mainSelect.value; }

export function syncSaveSelects(idx, sourceSelect) { const mainSelect = document.getElementById(`char-save-select-${idx}`); const topSelect = document.getElementById(`char-save-select-top-${idx}`); const bottomSelect = document.getElementById(`char-save-select-bottom-${idx}`); const val = sourceSelect.value; if (mainSelect && mainSelect !== sourceSelect) mainSelect.value = val; if (topSelect && topSelect !== sourceSelect) topSelect.value = val; if (bottomSelect && bottomSelect !== sourceSelect) bottomSelect.value = val; }

export function collectCharConfigData(idx) { if (!state.gameSelectedChars[idx]) return null; const ch = state.gameSelectedChars[idx]; const positions = getCurrentPositions(idx); const data = { charName: ch.name, positions: {}, special: {} }; if (ch.special === 'alice') { const cb = document.getElementById(`char-alice-c6-${idx}`); data.special.aliceC6 = cb ? cb.checked : false; } if (ch.special === 'vivian') { const cb = document.getElementById(`char-vivian-c4-${idx}`); data.special.vivianC4 = cb ? cb.checked : false; } positions.forEach(pos => { const posData = {}; if (pos >= 4) { posData.mains = getSelectedMainForPos(idx, pos); } const directToggle = document.getElementById(`game-direct-toggle-${idx}-${pos}`); posData.directEnabled = directToggle ? directToggle.checked : false; if (posData.directEnabled) { posData.directTypes = getGameDirectTypes(idx, pos); } posData.enhance = {}; const rows = document.querySelectorAll(`#pos-config-${idx}-${pos} .enhance-row`); rows.forEach(row => { const cb = row.querySelector(`.enhance-check-${idx}-${pos}`); const timesInput = row.querySelector(`.enhance-times-${idx}-${pos}`); if (!cb || !timesInput) return; const i = parseInt(cb.dataset.idx); posData.enhance[i] = { checked: cb.checked, times: parseInt(timesInput.value) || 0 }; }); data.positions[pos] = posData; }); return data; }

export function restoreCharConfigData(idx, data) { if (!data || !state.gameSelectedChars[idx] || state.gameSelectedChars[idx].name !== data.charName) return; if (data.special) { if (data.special.aliceC6 !== undefined) { const cb = document.getElementById(`char-alice-c6-${idx}`); if (cb) { cb.checked = data.special.aliceC6; updateCharWeights(idx); } } if (data.special.vivianC4 !== undefined) { const cb = document.getElementById(`char-vivian-c4-${idx}`); if (cb) { cb.checked = data.special.vivianC4; updateCharWeights(idx); } } } const allPosCheckboxes = document.querySelectorAll(`#char-positions-${idx} input[type="checkbox"]`); allPosCheckboxes.forEach(cb => { cb.checked = false; }); const posKeys = Object.keys(data.positions).map(Number); posKeys.forEach(pos => { const cb = document.querySelector(`#char-positions-${idx} input[value="${pos}"]`); if (cb) cb.checked = true; createPositionConfig(idx, pos); }); posKeys.forEach(pos => { const posData = data.positions[pos]; if (pos >= 4 && posData.mains) { const mainContainer = document.getElementById(`main-${idx}-${pos}`); if (mainContainer) { const checkboxes = mainContainer.querySelectorAll('input[type="checkbox"]'); checkboxes.forEach(cb => { cb.checked = posData.mains.includes(cb.value); }); } } const directToggle = document.getElementById(`game-direct-toggle-${idx}-${pos}`); if (directToggle) { directToggle.checked = !!posData.directEnabled; toggleGameDirect(idx, pos); } if (posData.directEnabled && posData.directTypes) { const directChecks = document.querySelectorAll(`.game-direct-check-${idx}-${pos}`); directChecks.forEach(cb => { cb.checked = posData.directTypes.includes(parseInt(cb.value)); }); } if (posData.enhance) { Object.keys(posData.enhance).forEach(i => { const iNum = parseInt(i); const rowCb = document.querySelector(`#pos-config-${idx}-${pos} .enhance-check-${idx}-${pos}[data-idx="${iNum}"]`); const rowTimes = document.querySelector(`#pos-config-${idx}-${pos} .enhance-times-${idx}-${pos}[data-idx="${iNum}"]`); if (rowCb) rowCb.checked = posData.enhance[i].checked; if (rowTimes) rowTimes.value = posData.enhance[i].times; }); } updatePosScale(idx, pos); calcPosScore(idx, pos); }); }

export function newSave(idx) { if (!state.gameSelectedChars[idx]) return; const chName = state.gameSelectedChars[idx].name; const saves = loadSavesList(chName); const defaultName = `${saves.length + 1}号存档`; let name = prompt('请输入新存档名称：', defaultName); if (!name || name.trim() === '') return; name = name.trim(); const data = collectCharConfigData(idx); if (!data) return; saves.push({ name, data }); saveSavesList(chName, saves); refreshSaveSelect(idx); document.getElementById(`char-save-select-${idx}`).value = saves.length - 1; syncSaveSelects(idx, document.getElementById(`char-save-select-${idx}`)); }

export function saveCurrentConfig(idx) { if (!state.gameSelectedChars[idx]) return; const chName = state.gameSelectedChars[idx].name; const select = document.getElementById(`char-save-select-${idx}`); if (!select) return; const saves = loadSavesList(chName); if (saves.length === 0) { newSave(idx); return; } const index = parseInt(select.value); if (isNaN(index) || index < 0 || index >= saves.length) { newSave(idx); return; } const data = collectCharConfigData(idx); if (!data) return; saves[index].data = data; saveSavesList(chName, saves); refreshSaveSelect(idx); select.value = index; syncSaveSelects(idx, select); alert(`已保存至 ${chName} - ${saves[index].name}`); }

export function readCurrentSave(idx) { if (!state.gameSelectedChars[idx]) return; const chName = state.gameSelectedChars[idx].name; const select = document.getElementById(`char-save-select-${idx}`); if (!select) return; const saves = loadSavesList(chName); if (saves.length === 0) { alert('暂无存档'); return; } const index = parseInt(select.value); if (isNaN(index) || index < 0 || index >= saves.length) { alert('请选择有效存档'); return; } restoreCharConfigData(idx, saves[index].data); alert(`已读取 ${chName} - ${saves[index].name}`); }

export function deleteCurrentSave(idx) { if (!state.gameSelectedChars[idx]) return; const chName = state.gameSelectedChars[idx].name; const select = document.getElementById(`char-save-select-${idx}`); if (!select) return; const saves = loadSavesList(chName); if (saves.length === 0) { alert('暂无存档'); return; } const index = parseInt(select.value); if (isNaN(index) || index < 0 || index >= saves.length) { alert('请选择有效存档'); return; } if (confirm(`确定删除 ${chName} 存档 “${saves[index].name}” 吗？`)) { saves.splice(index, 1); saveSavesList(chName, saves); refreshSaveSelect(idx); } }

export function renameCurrentSave(idx) { if (!state.gameSelectedChars[idx]) return; const chName = state.gameSelectedChars[idx].name; const select = document.getElementById(`char-save-select-${idx}`); if (!select) return; const saves = loadSavesList(chName); if (saves.length === 0) { alert('暂无存档'); return; } const index = parseInt(select.value); if (isNaN(index) || index < 0 || index >= saves.length) { alert('请选择有效存档'); return; } const newName = prompt('请输入新名称：', saves[index].name); if (!newName || newName.trim() === '') return; saves[index].name = newName.trim(); saveSavesList(chName, saves); refreshSaveSelect(idx); select.value = index; syncSaveSelects(idx, select); }

export function oneClickSaveImported() {
        if (state.lastImportedChars.length === 0) { alert('没有可存档的导入数据'); return; }
        let savedCount = 0;
        for (const charName of state.lastImportedChars) {
            const idx = state.gameSelectedChars.findIndex(c => c.name === charName);
            if (idx === -1) continue;
            const data = collectCharConfigData(idx);
            if (!data) continue;
            const saves = loadSavesList(charName);
            let baseName = '一键导入存档';
            let finalName = baseName;
            let counter = 2;
            while (saves.some(s => s.name === finalName)) {
                finalName = `${baseName}(${counter})`;
                counter++;
            }
            saves.push({ name: finalName, data });
            saveSavesList(charName, saves);
            refreshSaveSelect(idx);
            savedCount++;
        }
        alert(`一键存档完成，已保存 ${savedCount} 个角色`);
        document.getElementById('one-click-save-btn').style.display = 'none';
    }
