// 从 Enka API 的 JSON 导入角色数据。

import { onPositionChange, renderAllCharacterConfigs, renderCharacterGrid } from './character-panel.js';
import { onMainEntryChange } from './entries.js';
import { calcPosScore, updatePosScale } from './positions.js';
import { state } from './store.js';
import { CHARACTER_DATA } from '../data/characters.js';
import { ENKA_ID_MAP, MAIN_STAT_NAME_MAP, SUBSTAT_INDEX_MAP } from '../data/enka-mapping.js';
import { ENTRY_NAMES } from '../data/game-config.js';
import { SUIT_NAME_MAP } from '../data/suits.js';
import { findCharacterByImportedName } from '../domain/characters.js';

export function updateJsonLink() {
        const uid = document.getElementById('enka-uid').value.trim();
        const container = document.getElementById('json-link-container');
        const link = document.getElementById('json-link');
        if (uid) {
            const url = `https://enka.network/api/zzz/uid/${uid}/`;
            link.href = url;
            link.textContent = url;
            container.style.display = 'block';
        } else {
            container.style.display = 'none';
        }
    }

export function applyPosOcrData(charIdx, posData) {
        if (posData.pos >= 4 && posData.mainStat) {
            const mainCheckboxes = document.querySelectorAll(`#main-${charIdx}-${posData.pos} input[type="checkbox"]`);
            mainCheckboxes.forEach(cb => { cb.checked = (cb.value === posData.mainStat); });
            onMainEntryChange(charIdx, posData.pos);
        }
        if (posData.setName) {
            const configDiv = document.getElementById(`pos-config-${charIdx}-${posData.pos}`);
            if (configDiv) {
                configDiv.dataset.setId = posData.setId || '0';
                configDiv.dataset.setName = posData.setName;
                const header = configDiv.querySelector('h4');
                if (header) header.textContent = `${posData.setName} - ${posData.pos}号位配置`;
            }
        }
        const existingChecks = document.querySelectorAll(`#pos-config-${charIdx}-${posData.pos} .enhance-check-${charIdx}-${posData.pos}`);
        existingChecks.forEach(cb => cb.checked = false);
        posData.substats.forEach(sub => {
            const enhanceCheck = document.querySelector(`#pos-config-${charIdx}-${posData.pos} .enhance-check-${charIdx}-${posData.pos}[data-idx="${sub.entryIdx}"]`);
            if (enhanceCheck) enhanceCheck.checked = true;
            const timesInput = document.querySelector(`#pos-config-${charIdx}-${posData.pos} .enhance-times-${charIdx}-${posData.pos}[data-idx="${sub.entryIdx}"]`);
            if (timesInput) timesInput.value = sub.times;
        });
        calcPosScore(charIdx, posData.pos);
        updatePosScale(charIdx, posData.pos);
    }

export async function importFromJSON() { const input = document.getElementById('json-input'); const jsonText = input.value.trim(); if (!jsonText) { alert('请先粘贴 JSON 数据！'); return; } try { const data = JSON.parse(jsonText); const avatarList = data.PlayerInfo?.ShowcaseDetail?.AvatarList; if (!avatarList || avatarList.length === 0) throw new Error("粘贴的数据中缺少角色列表"); let charactersToAdd = []; for (const avatar of avatarList) { const charId = String(avatar.Id); const charName = ENKA_ID_MAP[charId]; if (!charName) continue; const ch = findCharacterByImportedName(charName); if (!ch) { console.warn(`未找到角色：${charName} (ID: ${charId})`); continue; } const ocrPositions = avatar.EquippedList.map(disc => { const pos = disc.Slot; const mainProp = disc.Equipment.MainPropertyList[0]; const mainStatId = String(mainProp.PropertyId); const mainStatName = MAIN_STAT_NAME_MAP[mainStatId] || mainStatId; const substats = disc.Equipment.RandomPropertyList.map(sub => { const subId = String(sub.PropertyId); const entryIdx = SUBSTAT_INDEX_MAP[subId]; if (entryIdx === undefined) return null; return { entryIdx, entryName: ENTRY_NAMES[entryIdx], times: Math.max(0, (sub.PropertyLevel || 1) - 1) }; }).filter(s => s !== null); const setId = String(Math.floor(disc.Equipment.Id / 100)); const setName = SUIT_NAME_MAP[setId] || '未知'; return { pos, mainStat: mainStatName, substats, setId, setName }; }); charactersToAdd.push({ ch, ocrPositions, charName: ch.name }); } if (charactersToAdd.length === 0) { alert('未能匹配到任何角色数据，请检查 ID 映射。'); return; } const addedNames = new Set(); let needsRender = false; for (const item of charactersToAdd) { const existingIdx = state.gameSelectedChars.findIndex(c => c.name === item.charName); if (existingIdx === -1 && !addedNames.has(item.charName)) { state.gameSelectedChars.push(item.ch); addedNames.add(item.charName); needsRender = true; } } if (needsRender) { const firstNewName = [...addedNames][0]; const fIdx = CHARACTER_DATA.findIndex(f => f.roles.some(r => r.name === firstNewName)); if (fIdx !== -1) renderCharacterGrid(fIdx); renderAllCharacterConfigs(); } for (const item of charactersToAdd) { const idx = state.gameSelectedChars.findIndex(c => c.name === item.charName); if (idx === -1) continue; const positionsToCheck = item.ocrPositions.map(p => p.pos); const posCheckboxes = document.querySelectorAll(`#char-positions-${idx} input[type="checkbox"]`); posCheckboxes.forEach(cb => { cb.checked = positionsToCheck.includes(parseInt(cb.value)); }); onPositionChange(idx); for (const posData of item.ocrPositions) { applyPosOcrData(idx, posData); } } state.lastImportedChars = [...new Set(charactersToAdd.map(item => item.charName))]; document.getElementById('one-click-save-btn').style.display = 'inline-block'; if (state.settings.autoCollapseImport) { charactersToAdd.forEach(item => { const idx = state.gameSelectedChars.findIndex(c => c.name === item.charName); if (idx !== -1) { const panel = document.getElementById(`char-panel-${idx}`); if (panel) panel.classList.add('collapsed'); } }); } alert(`成功导入 ${charactersToAdd.length} 个角色的数据！`); } catch (error) { console.error(error); alert('导入失败：' + error.message); } }
