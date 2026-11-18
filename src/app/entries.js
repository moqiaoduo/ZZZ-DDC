// 词条录入区的构建与联动：主词条下拉、副词条权重、定向词条。

import { onPositionChange } from './character-panel.js';
import { calcPosScore, getBlockedSubIdxForPos, updatePosScale } from './positions.js';
import { state } from './store.js';
import { ENTRY_NAMES, MAIN_ENTRY_CONFIG, SUBSTAT_SPECIAL_WEIGHTS } from '../data/game-config.js';
import { parseNumber } from '../domain/probability.js';

export function initCharEntries(idx, ch) { const ct = document.getElementById(`char-entries-${idx}`); ct.innerHTML = ''; ENTRY_NAMES.forEach((n, i) => { const d = document.createElement('div'); d.className = 'entry-grid'; d.innerHTML = `<div class="entry-item"><label>词条名称</label><input type="text" value="${n}" disabled></div><div class="entry-item"><label>库存</label><input type="number" class="game-rest-${idx}" data-idx="${i}" min="0" value="1"></div><div class="entry-item"><label>权重</label><input type="text" class="game-weight-${idx}" data-idx="${i}" placeholder="整数/小数/分数"></div>`; ct.appendChild(d); }); document.querySelectorAll(`.game-weight-${idx}`).forEach(inp => inp.addEventListener('input', () => { onPositionChange(idx); })); }

export function updateCharWeights(idx) { const ch = state.gameSelectedChars[idx]; if (!ch) return; const weights = [...ch.weights]; const aliceCb = document.getElementById(`char-alice-c6-${idx}`); const vivianCb = document.getElementById(`char-vivian-c4-${idx}`); if (aliceCb && aliceCb.checked) weights[7] += 0.3; if (vivianCb && vivianCb.checked) weights[7] = 0.6; const wi = document.querySelectorAll(`.game-weight-${idx}`); const ri = document.querySelectorAll(`.game-rest-${idx}`); for (let i = 0; i < 10; i++) { if (wi[i]) { wi[i].value = weights[i] === 0 ? '' : weights[i]; wi[i].disabled = false; } if (ri[i]) { ri[i].disabled = false; ri[i].value = 1; } } onPositionChange(idx); }

export function onMainEntryChange(idx, pos) {
        updatePosScale(idx, pos);
        buildPosEnhance(idx, pos);
        buildGameDirectOptions(idx, pos);
    }

export function renderMainEntriesForPos(idx, pos) {
        const ct = document.getElementById(`main-${idx}-${pos}`);
        if (!ct) return;
        ct.innerHTML = '';
        (MAIN_ENTRY_CONFIG[pos] || []).forEach(n => {
            const it = document.createElement('label');
            it.className = 'main-entry-item';
            it.innerHTML = `<input type="checkbox" value="${n}" onchange="onMainEntryChange(${idx},${pos})"> ${n}`;
            ct.appendChild(it);
        });
    }

export function buildPosEnhance(idx, pos) {
        const area = document.getElementById(`enhance-${idx}-${pos}`);
        if (!area) return;
        const weightInputs = document.querySelectorAll(`.game-weight-${idx}`);
        const blockedIdxs = getBlockedSubIdxForPos(idx, pos);
        area.innerHTML = '';
        for (let i = 0; i < weightInputs.length; i++) {
            if (blockedIdxs.includes(i)) continue;
            const w = parseNumber(weightInputs[i].value);
            if (isNaN(w) || w <= 0) continue;
            const div = document.createElement('div');
            div.className = 'enhance-row';
            div.innerHTML = `
                <label class="enhance-name-col">
                    <input type="checkbox" class="enhance-check-${idx}-${pos}" data-idx="${i}" onchange="calcPosScore(${idx},${pos})"> ${ENTRY_NAMES[i]}
                </label>
                <span class="enhance-subval" id="sub-val-${idx}-${pos}-${i}">当前副词条数值：0</span>
                <span>权重：${w}</span>
                <div>
                    <input type="number" class="enhance-times-${idx}-${pos}" data-idx="${i}" min="0" max="5" value="0" style="width:60px;" onchange="calcPosScore(${idx},${pos})">
                </div>`;
            area.appendChild(div);
        }
        calcPosScore(idx, pos);
    }

export function buildGameDirectOptions(idx, pos) {
        const container = document.getElementById(`game-direct-options-${idx}-${pos}`);
        if (!container) return;
        const weightInputs = document.querySelectorAll(`.game-weight-${idx}`);
        const blockedIdxs = getBlockedSubIdxForPos(idx, pos);
        container.innerHTML = '';
        for (let i = 0; i < 10; i++) {
            if (blockedIdxs.includes(i)) continue;
            const w = parseNumber(weightInputs[i]?.value) || 0;
            if (w > 0) {
                const label = document.createElement('label');
                label.className = 'main-entry-item';
                label.innerHTML = `<input type="checkbox" class="game-direct-check-${idx}-${pos}" value="${i}" onchange="limitGameDirect(${idx},${pos}, this)"> ${ENTRY_NAMES[i]}`;
                container.appendChild(label);
            }
        }
    }

export function toggleGameDirect(idx, pos) {
        const toggle = document.getElementById(`game-direct-toggle-${idx}-${pos}`);
        const area = document.getElementById(`game-direct-area-${idx}-${pos}`);
        if (!toggle || !area) return;
        area.style.display = toggle.checked ? 'block' : 'none';
        if (toggle.checked) buildGameDirectOptions(idx, pos);
    }

export function limitGameDirect(idx, pos, cb) {
        const checked = document.querySelectorAll(`.game-direct-check-${idx}-${pos}:checked`);
        if (checked.length > 2) cb.checked = false;
    }

export function getGameDirectTypes(idx, pos) {
        const toggle = document.getElementById(`game-direct-toggle-${idx}-${pos}`);
        if (!toggle || !toggle.checked) return [];
        return Array.from(document.querySelectorAll(`.game-direct-check-${idx}-${pos}:checked`)).map(cb => parseInt(cb.value));
    }

export function collectEntryListForSingleMain(idx, pos, mainName) {
        const rests = document.querySelectorAll(`.game-rest-${idx}`);
        const weights = document.querySelectorAll(`.game-weight-${idx}`);
        const types = [];
        let blockedIdxs = [];
        if (pos >= 4 && mainName) {
            blockedIdxs = getBlockedSubIdxForPos(idx, pos);
        }
        for (let i = 0; i < 10; i++) {
            let r = parseInt(rests[i].value) || 0;
            const w = parseNumber(weights[i].value) || 0;
            if (blockedIdxs.includes(i)) r = 0;
            types.push({ typeIndex: i, score: w, rest: r, specialWeight: SUBSTAT_SPECIAL_WEIGHTS[i] });
        }
        return types;
    }
