// 角色面板：阵营页签、角色卡、每个角色的位置配置与存档选择器。

import {
  buildGameDirectOptions,
  buildPosEnhance,
  initCharEntries,
  renderMainEntriesForPos,
  toggleGameDirect,
  updateCharWeights,
} from './entries.js';
import { calcPosScore, getCurrentPositions, updatePosScale } from './positions.js';
import {
  collectCharConfigData,
  deleteCurrentSave,
  newSave,
  readCurrentSave,
  refreshSaveSelect,
  renameCurrentSave,
  restoreCharConfigData,
  saveCurrentConfig,
} from './saves.js';
import { state } from './store.js';
import { CHARACTER_DATA } from '../data/characters.js';

export function renderFactionTabs(cId) { const ct = document.getElementById(cId); ct.innerHTML = ''; CHARACTER_DATA.forEach((f, i) => { const tb = document.createElement('div'); tb.className = `faction-tab ${i===0?'active':''}`; tb.textContent = f.faction; tb.onclick = () => { ct.querySelectorAll('.faction-tab').forEach(x => x.classList.remove('active')); tb.classList.add('active'); renderCharacterGrid(i); }; ct.appendChild(tb); }); }

export function renderCharacterGrid(fi = 0) { const g = document.getElementById('game-character-grid'); g.innerHTML = ''; CHARACTER_DATA[fi].roles.forEach(ch => { const cd = document.createElement('div'); cd.className = 'character-card'; const isActive = state.gameSelectedChars.some(c => c.name === ch.name); if (isActive) cd.classList.add('active'); cd.innerHTML = `<img src="./${ch.image}" alt="${ch.name}" class="character-avatar" onerror="this.style.display='none'"><div class="character-name">${ch.name}</div>`; cd.onclick = () => { const idx = state.gameSelectedChars.findIndex(c => c.name === ch.name); if (idx >= 0) state.gameSelectedChars.splice(idx, 1); else state.gameSelectedChars.push(ch); renderCharacterGrid(fi); renderAllCharacterConfigs(); }; g.appendChild(cd); }); }

export function cacheCurrentPanels() { const panels = document.querySelectorAll('#char-configs-container .char-panel'); panels.forEach(panel => { const charName = panel.dataset.charName; if (!charName) return; const idx = state.gameSelectedChars.findIndex(c => c.name === charName); if (idx === -1) return; const data = collectCharConfigData(idx); if (data) state.charConfigsCache[charName] = data; }); }

export function renderAllCharacterConfigs() { cacheCurrentPanels(); const container = document.getElementById('char-configs-container'); container.innerHTML = ''; state.gameSelectedChars.forEach((ch, idx) => { const panel = document.createElement('div'); panel.className = 'char-panel collapsible'; panel.id = `char-panel-${idx}`; panel.dataset.charName = ch.name; let html = `<div class="char-panel-header" style="display:flex; align-items:center; gap:10px; cursor:pointer;">
            <span class="collapse-icon"></span>
            <h3 style="margin:0;">${ch.name}</h3>
        </div>`;
        html += `<div class="panel-body">`;
        if (ch.special === 'alice') html += `<div class="special-option"><input type="checkbox" id="char-alice-c6-${idx}" onchange="updateCharWeights(${idx})"> <label for="char-alice-c6-${idx}">爱丽丝6命（额外增加爆伤权重0.3）</label></div>`;
        if (ch.special === 'vivian') html += `<div class="special-option"><input type="checkbox" id="char-vivian-c4-${idx}" onchange="updateCharWeights(${idx})"> <label for="char-vivian-c4-${idx}">薇薇安4命（暴击伤害权重改为0.6）</label></div>`;

html += `<div style="margin-top:14px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;">`;
html += `<select id="char-save-select-${idx}" class="char-save-select" data-idx="${idx}" style="flex:1.5;padding:5px;background:var(--bg-secondary);border:1px solid var(--border-color);color:var(--text-color);border-radius:4px;"></select>`;
html += `<button class="btn btn-secondary" onclick="newSave(${idx})" style="padding:5px 12px;font-size:0.85rem;">新建</button>`;
html += `<button class="btn btn-secondary" onclick="readCurrentSave(${idx})" style="padding:5px 12px;font-size:0.85rem;">读取</button>`;
html += `<button class="btn btn-secondary" onclick="saveCurrentConfig(${idx})" style="padding:5px 12px;font-size:0.85rem;">保存</button>`;
html += `<button class="btn btn-secondary" onclick="renameCurrentSave(${idx})" style="padding:5px 12px;font-size:0.85rem;">改名</button>`;
html += `<button class="btn btn-secondary" onclick="deleteCurrentSave(${idx})" style="padding:5px 12px;font-size:0.85rem;">删除</button>`;
html += `</div>`;




        html += `<div class="form-group"><label>驱动盘号位（可多选）</label><div class="position-select" id="char-positions-${idx}">`;
        for (let p = 1; p <= 6; p++) html += `<label class="position-option"><input type="checkbox" value="${p}" onchange="togglePosition(${idx}, this.value, this.checked)"> ${p}号位</label>`;
        html += `</div></div>`;
        html += `<div id="position-configs-${idx}"></div>`;
        html += `<div style="margin-top:12px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;">`;
        html += `<select id="char-save-select-bottom-${idx}" class="char-save-select-bottom" data-idx="${idx}" style="flex:1.5;padding:5px;background:var(--bg-secondary);border:1px solid var(--border-color);color:var(--text-color);border-radius:4px;"></select>`;
        html += `<button class="btn btn-secondary" onclick="saveCurrentConfig(${idx})" style="padding:5px 12px;font-size:0.85rem;">保存</button>`;
        html += `</div>`;
        html += `<label class="section-label">角色基础词条库</label><div class="entries-list" id="char-entries-${idx}"></div>`;
        html += `</div>`;
        panel.innerHTML = html;
        container.appendChild(panel);

        const header = panel.querySelector('.char-panel-header');
        header.addEventListener('click', () => toggleCharPanel(panel));

        if (state.charConfigsCache[ch.name] && state.charConfigsCache[ch.name].collapsed) {
            panel.classList.add('collapsed');
        }

        initCharEntries(idx, ch);
        updateCharWeights(idx);
        onPositionChange(idx);
        refreshSaveSelect(idx);
        if (state.charConfigsCache[ch.name]) restoreCharConfigData(idx, state.charConfigsCache[ch.name]);
    }); }

export function toggleCharPanel(panel) {
        panel.classList.toggle('collapsed');
        const charName = panel.dataset.charName;
        if (!state.charConfigsCache[charName]) state.charConfigsCache[charName] = {};
        state.charConfigsCache[charName].collapsed = panel.classList.contains('collapsed');
    }

export function createPositionConfig(idx, pos) { const configsDiv = document.getElementById(`position-configs-${idx}`); if (!configsDiv || document.getElementById(`pos-config-${idx}-${pos}`)) return; const div = document.createElement('div'); div.className = 'pos-config'; div.id = `pos-config-${idx}-${pos}`; let inner = `<h4>${pos}号位配置</h4>`; if (pos >= 4) inner += `<label>主词条选择：</label><div class="main-entry-grid" id="main-${idx}-${pos}"></div>`; inner += `<div class="special-option" style="margin:10px 0;"><input type="checkbox" id="game-direct-toggle-${idx}-${pos}" onchange="toggleGameDirect(${idx},${pos})"> <label for="game-direct-toggle-${idx}-${pos}">定向副词条</label></div>`; inner += `<div id="game-direct-area-${idx}-${pos}" style="display:none; margin-bottom:10px; padding:10px; background:var(--bg-secondary); border:1px solid var(--border-color); border-radius:8px;"><label>选择定向副词条（最多2个）</label><div id="game-direct-options-${idx}-${pos}" class="main-entry-grid"></div></div>`; inner += `<label>当前驱动盘强化次数：</label><div id="enhance-${idx}-${pos}"></div>`; inner += `<div>当前驱动盘分数：<span id="score-percent-${idx}-${pos}">0分</span></div>`; inner += `<small style="color:var(--text-muted);">满分100分，为100倍当前驱动盘权重分数与驱动盘最大权重分数之比</small>`; inner += `<label>抽中对应号位主词条概率：<input type="text" id="scale-${idx}-${pos}" readonly></label><small style="color:var(--text-muted);">示例：随机抽得该位置概率1/6；4/6号位主词条仅1种可用输入1/36</small>`; div.innerHTML = inner; configsDiv.appendChild(div); if (pos >= 4) renderMainEntriesForPos(idx, pos); updatePosScale(idx, pos); buildGameDirectOptions(idx, pos); buildPosEnhance(idx, pos); }

export function removePositionConfig(idx, pos) { const el = document.getElementById(`pos-config-${idx}-${pos}`); if (el) el.remove(); }

export function togglePosition(idx, pos, checked) { if (checked) createPositionConfig(idx, parseInt(pos)); else removePositionConfig(idx, parseInt(pos)); }

export function onPositionChange(idx) { const configsDiv = document.getElementById(`position-configs-${idx}`); if (!configsDiv) return; const savedStates = {}; configsDiv.querySelectorAll('.pos-config').forEach(configDiv => { const pos = parseInt(configDiv.id.split('-').pop()); const state = { pos, mains: [], directEnabled: false, directTypes: [], enhance: {}, setId: configDiv.dataset.setId || '', setName: configDiv.dataset.setName || '' }; if (pos >= 4) { const mainContainer = configDiv.querySelector('.main-entry-grid'); if (mainContainer) { mainContainer.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => state.mains.push(cb.value)); } } const directToggle = configDiv.querySelector(`input[id^="game-direct-toggle-"]`); if (directToggle) { state.directEnabled = directToggle.checked; if (directToggle.checked) { configDiv.querySelectorAll(`input[id^="game-direct-check-"]:checked`).forEach(cb => state.directTypes.push(parseInt(cb.value))); } } configDiv.querySelectorAll('.enhance-row').forEach(row => { const cb = row.querySelector(`input[type="checkbox"]`); const timesInput = row.querySelector(`input[type="number"]`); if (cb && timesInput) { const entryIdx = parseInt(cb.dataset.idx); state.enhance[entryIdx] = { checked: cb.checked, times: parseInt(timesInput.value) || 0 }; } }); savedStates[pos] = state; }); configsDiv.innerHTML = ''; const positions = getCurrentPositions(idx); positions.forEach(pos => { createPositionConfig(idx, pos); }); 

    Object.values(savedStates).forEach(state => {
        const pos = state.pos;
        if (!positions.includes(pos)) return;
        const configDiv = document.getElementById(`pos-config-${idx}-${pos}`);
        if (!configDiv) return;
        if (state.setId) {
            configDiv.dataset.setId = state.setId;
            configDiv.dataset.setName = state.setName;
            const header = configDiv.querySelector('h4');
            if (header && state.setName) header.textContent = `${state.setName} - ${pos}号位配置`;
        }
        if (pos >= 4 && state.mains.length > 0) {
            const mainContainer = document.getElementById(`main-${idx}-${pos}`);
            if (mainContainer) {
                mainContainer.querySelectorAll('input[type="checkbox"]').forEach(cb => {
                    cb.checked = state.mains.includes(cb.value);
                });
            }
        }
        buildPosEnhance(idx, pos);
        buildGameDirectOptions(idx, pos);
        const directToggle = document.getElementById(`game-direct-toggle-${idx}-${pos}`);
        if (directToggle) {
            directToggle.checked = state.directEnabled;
            toggleGameDirect(idx, pos);
            if (state.directEnabled && state.directTypes.length > 0) {
                const directChecks = document.querySelectorAll(`.game-direct-check-${idx}-${pos}`);
                directChecks.forEach(cb => {
                    cb.checked = state.directTypes.includes(parseInt(cb.value));
                });
            }
        }
        Object.keys(state.enhance).forEach(entryIdx => {
            const iNum = parseInt(entryIdx);
            const rowCb = configDiv.querySelector(`.enhance-check-${idx}-${pos}[data-idx="${iNum}"]`);
            const rowTimes = configDiv.querySelector(`.enhance-times-${idx}-${pos}[data-idx="${iNum}"]`);
            if (rowCb) rowCb.checked = state.enhance[entryIdx].checked;
            if (rowTimes) rowTimes.value = state.enhance[entryIdx].times;
        });
        updatePosScale(idx, pos);
        calcPosScore(idx, pos);
    });}
