// 游戏版计算：读面板 → 逐个主词条算概率 → 渲染结果与推荐。

import { collectEntryListForSingleMain, getGameDirectTypes } from './entries.js';
import { getCurrentPositions, getPosGoal, getSelectedMainForPos } from './positions.js';
import { state } from './store.js';
import { MAIN_ENTRY_CONFIG, MAIN_PROB_WEIGHTS } from '../data/game-config.js';
import { formatCost } from '../domain/format.js';
import { calculateCoreGame } from '../domain/probability.js';

export function calculateGame() {
        state.extractionList = [];
        if (state.gameSelectedChars.length === 0) {
            alert('请至少选择一个角色');
            return;
        }
        const allCharResults = [];
        state.gameSelectedChars.forEach((ch, idx) => {
            const positions = getCurrentPositions(idx);
            if (positions.length === 0) return;
            let totalRandom = 0;
            const perPosResults = [];
            positions.forEach(pos => {
                const goal = getPosGoal(idx, pos);
                let mainList = [];
                if (pos <= 3) mainList = [null];
                else {
                    const selected = getSelectedMainForPos(idx, pos);
                    mainList = selected.length > 0 ? selected : [...MAIN_ENTRY_CONFIG[pos]];
                }
                const probWeights = pos >= 4 ? MAIN_PROB_WEIGHTS[pos] : null;
                const totalWeight = probWeights ? Object.values(probWeights).reduce((a,b)=>a+b,0) : 1;
                let posRandom = 0, posDirected = 0, posSumA = 0, posSumB = 0, posCount = 0;
                let posDirectedNoDirect = 0;
                const directedTypes = getGameDirectTypes(idx, pos);
                const posConfig = document.getElementById(`pos-config-${idx}-${pos}`);
                const setId = posConfig ? posConfig.dataset.setId || '0' : '0';
                const setName = posConfig ? posConfig.dataset.setName || '未知' : '未知';
                mainList.forEach(main => {
                    const types = collectEntryListForSingleMain(idx, pos, main);
                    if (types.reduce((sum,t)=>sum+t.rest,0) < 4) {
                        alert(`${ch.name} ${pos}号位（主词条：${main||'无'}）词条库存不足4`);
                        return;
                    }
                    let scaleFactor;
                    if (pos <= 3) scaleFactor = 1/6;
                    else {
                        const weight = probWeights[main] || 0;
                        scaleFactor = (1/6) * (weight / totalWeight);
                    }
                    const result = calculateCoreGame(types, goal, scaleFactor, directedTypes);
                    const resultNoDirect = calculateCoreGame(types, goal, scaleFactor, []);
                    const directedContrib = pos >= 4 ? result.chance / 6 : result.chance;
                    const directedContribNoDirect = pos >= 4 ? resultNoDirect.chance / 6 : resultNoDirect.chance;
                    posRandom += result.scaledChance;
                    posDirected += directedContrib;
                    posDirectedNoDirect += directedContribNoDirect;
                    posSumA += result.mchanceA;
                    posSumB += result.mchanceB;
                    posCount++;
                });
                if (pos === 5) {
                    posDirected *= 0.6;
                    posDirectedNoDirect *= 0.6;
                }
                let directedMain = null;
                let directedMainNoDirect = null;
                if (pos >= 4 && mainList[0] !== null) {
                    const generic46 = ["攻击力百分比","生命值百分比","防御力百分比","暴击率","暴击伤害"];
                    const generic5 = ["攻击力百分比","生命值百分比","防御力百分比"];
                    const selectedMains = mainList;
                    if (pos === 4 || pos === 6) {
                        if (selectedMains.length === 1 || !selectedMains.some(m => generic46.includes(m))) {
                            directedMain = posDirected * 6 / selectedMains.length;
                            directedMainNoDirect = posDirectedNoDirect * 6 / selectedMains.length;
                        }
                    } else if (pos === 5) {
                        if (selectedMains.length === 1 || !selectedMains.some(m => generic5.includes(m))) {
                            directedMain = posDirected * 10 / selectedMains.length;
                            directedMainNoDirect = posDirectedNoDirect * 10 / selectedMains.length;
                        }
                    }
                }
				
                let gradeText = null, gradeColor = 'white';
				let canEvaluate = true;
				if (pos >= 4) {
    				const selectedMains = getSelectedMainForPos(idx, pos);
    				if (selectedMains.length === 0) canEvaluate = false;
				}
				if (canEvaluate) {
    				const evalProb = posDirectedNoDirect;
    				if (evalProb <= 0.003) { gradeText = '完美毕业'; gradeColor = 'red'; }
    				else if (evalProb <= 0.033) { gradeText = '大毕业'; gradeColor = 'gold'; }
  				  	else if (evalProb < 0.064) { gradeText = '小毕业'; gradeColor = 'purple'; }
   	 				else if (evalProb < 0.12) { gradeText = '能用'; gradeColor = 'blue'; }
    				else { gradeText = '可提升空间极大'; gradeColor = 'white'; }
				}
				
                const avgA = posCount > 0 ? posSumA / posCount : 0;
                const avgB = posCount > 0 ? posSumB / posCount : 0;
                perPosResults.push({
                    pos,
                    random: posRandom,
                    directed: posDirected,
                    directedMain,
                    directedMainNoDirect,
                    gradeText,
                    gradeColor,
                    setId,
                    setName,
                    avgA,
                    avgB,
                    mainStat: mainList[0] !== null ? mainList[0] : null,
                    hasDirect: directedTypes.length > 0
                });
                totalRandom += posRandom;
                state.extractionList.push({
                    type: 'random',
                    char: ch.name,
                    suit: setName,
                    pos,
                    probability: posRandom,
                    costAudio: 1 / posRandom * 3,
                    costScott: 1 / posRandom * 2 / 2.5 * 60,
                    costScottDays: 1 / posRandom * 2 / 2.5 * 60 / 320
                });
                if (posDirected > 0) state.extractionList.push({
                    type: 'position',
                    char: ch.name,
                    suit: setName,
                    pos,
                    probability: posDirected,
                    costAudio: 1 / posDirected * 6
                });
                if (directedMain !== null && directedMain > 0) {
                    state.extractionList.push({
                        type: 'main',
                        char: ch.name,
                        suit: setName,
                        pos,
                        mainStat: mainList[0],
                        probability: directedMain,
                        costAudio1: 1 / directedMain * 6,
                        costAudio2: 1 / directedMain
                    });
                }
            });
            allCharResults.push({ name: ch.name, perPosResults, totalRandom });
        });

        let resultHtml = '';
        const multiChar = allCharResults.length > 1;
        allCharResults.forEach(cr => {
            const collapsedClass = (multiChar && state.settings.autoCollapseOutput) ? ' collapsed' : '';
            resultHtml += `<div class="role-result collapsible${collapsedClass}" data-role="${cr.name}">`;
            resultHtml += `<div class="role-result-header" style="display:flex; align-items:center; gap:8px; cursor:pointer;">
                <span class="collapse-icon"></span>
                <h3 style="color:var(--primary-color); margin:0;">${cr.name}</h3>
            </div>`;
            resultHtml += `<div class="role-result-body">`;
            let groupBySet = {};
            cr.perPosResults.forEach(r => {
                const setId = r.setId || '0';
                if (!groupBySet[setId]) groupBySet[setId] = { name: r.setName || '未知', items: [] };
                groupBySet[setId].items.push(r);
            });
            for (const setId in groupBySet) {
                const group = groupBySet[setId];
                const groupRandomSum = group.items.reduce((sum, r) => sum + r.random, 0);
                resultHtml += `<div style="margin-top:12px;"><h4 style="color:var(--primary-color); margin:0 0 6px;">${group.name}</h4></div>`;
                resultHtml += `<div>随机抽取综合练度提升概率 <strong>${(groupRandomSum*100).toFixed(15)}%</strong>（音像店刷出更好驱动盘期望消耗 ${formatCost(1/groupRandomSum*3, 'assets/costs/tape.png')}，哨站刷出更好驱动盘期望消耗 ${formatCost(1/groupRandomSum*2/2.5*60)} 电量（约和${(1/groupRandomSum*2/2.5*60/320).toFixed(2)}天体力））</div>`;
                resultHtml += '<br>';
                group.items.forEach(r => {
                    resultHtml += `<div style="margin-bottom:8px;">`;
                    resultHtml += `<div>${r.pos}号位：随机 <strong>${(r.random*100).toFixed(4)}%</strong>（音像店刷出更好驱动盘期望消耗 ${formatCost(1/r.random*3, 'assets/costs/tape.png')}，哨站刷出更好驱动盘期望消耗${formatCost(1/r.random*2/2.5*60)} 电量（约和${(1/r.random*2/2.5*60/320).toFixed(2)}天体力））</div>`;
                    resultHtml += `<div>定向位置 <strong>${(r.directed*100).toFixed(4)}%</strong>（音像店刷出更好驱动盘期望消耗 ${formatCost(1/r.directed*6, 'assets/costs/tape.png')}）</div>`;
                    if (r.directedMain !== null && r.directedMain > 0) {
                        resultHtml += `<div>定向主词条 <strong>${(r.directedMain*100).toFixed(4)}%</strong>（音像店刷出更好驱动盘期望消耗 ${formatCost(1/r.directedMain*6, 'assets/costs/tape.png')}、${formatCost(1/r.directedMain, 'assets/costs/directed-position.png')}${r.hasDirect ? `、${formatCost(1/r.directedMain, 'assets/costs/directed-substat.png')}` : ''}）</div>`;
                    }
                    if (r.gradeText) resultHtml += `<div>当前驱动盘练度评价：<span style="color:${r.gradeColor};font-weight:bold;">${r.gradeText}</span></div>`;
                    resultHtml += `<div>初始三词条驱动盘强化后练度提升概率：<strong>${(r.avgB*100).toFixed(15)}%</strong></div>`;
                    resultHtml += `<div>初始四词条驱动盘强化后练度提升概率：<strong>${(r.avgA*100).toFixed(15)}%</strong></div>`;
                    resultHtml += `</div>`;
                });
            }
            resultHtml += `</div></div>`;
        });
        document.getElementById('per-position-results').innerHTML = resultHtml;
        document.getElementById('per-position-results').querySelectorAll('.role-result').forEach(el => {
            el.querySelector('.role-result-header').addEventListener('click', () => el.classList.toggle('collapsed'));
        });
        document.getElementById('res-a').style.display = 'none';
        document.getElementById('res-b').style.display = 'none';
        document.getElementById('res-random').style.display = 'none';

        const recommendArea = document.getElementById('recommend-area');
        if (state.extractionList.length === 0) {
            recommendArea.innerHTML = '<div class="recommend-box">暂无驱动盘数据</div>';
        } else {
            let maxProbItem = state.extractionList.reduce((a,b) => a.probability > b.probability ? a : b);
            let scottMinItem = null;
            state.extractionList.forEach(item => {
                if (item.type === 'random' && (scottMinItem === null || item.costScott < scottMinItem.costScott)) scottMinItem = item;
            });
            let audioRandPosMinItem = null;
            state.extractionList.forEach(item => {
                if (item.type === 'random' || item.type === 'position') {
                    if (audioRandPosMinItem === null || item.costAudio < audioRandPosMinItem.costAudio) audioRandPosMinItem = item;
                }
            });
            let mainMinItem = null;
            state.extractionList.forEach(item => {
                if (item.type === 'main' && (mainMinItem === null || item.costAudio1 < mainMinItem.costAudio1)) mainMinItem = item;
            });
            let html = '';
            if (maxProbItem) {
                let probText = '';
                if (maxProbItem.type === 'random') {
                    probText = `随机抽取套装${maxProbItem.suit}`;
                } else if (maxProbItem.type === 'position') {
                    probText = `定向${maxProbItem.pos}号位为${maxProbItem.char}抽取${maxProbItem.suit}套装`;
                } else if (maxProbItem.type === 'main') {
                    probText = `${maxProbItem.pos}号位定向${maxProbItem.mainStat}主词条为${maxProbItem.char}抽取${maxProbItem.suit}套装`;
                }
                html += `<div class="recommend-box" style="margin-bottom:10px;"><span style="color:var(--primary-color);">出货概率最大的具体抽取方式：</span>${probText}，出货概率${(maxProbItem.probability*100).toFixed(4)}%</div>`;
            }
            if (scottMinItem) {
                html += `<div class="recommend-box" style="margin-bottom:10px;"><span style="color:var(--primary-color);">斯科特哨站资源消耗最小的具体抽取方式：</span>为${scottMinItem.char}刷取套装${scottMinItem.suit}，期望消耗${scottMinItem.costScott.toFixed(2)}电量（约和${(1/scottMinItem.probability*2/2.5*60/320).toFixed(2)}天体力）</div>`;
            }
            if (audioRandPosMinItem) {
                let methodText = '';
                if (audioRandPosMinItem.type === 'random') {
                    methodText = `随机抽取套装${audioRandPosMinItem.suit}`;
                } else {
                    methodText = `定向${audioRandPosMinItem.pos}号位为${audioRandPosMinItem.char}抽取${audioRandPosMinItem.suit}套装`;
                }
                html += `<div class="recommend-box" style="margin-bottom:10px;"><span style="color:var(--primary-color);">音像店抽取方式为随机，定向位置时资源消耗最小的具体抽取方式：</span>${methodText}，期望消耗${formatCost(audioRandPosMinItem.costAudio, 'assets/costs/tape.png')}</div>`;
            }
            if (mainMinItem) {
                let mainText = `${mainMinItem.pos}号位定向${mainMinItem.mainStat}主词条为${mainMinItem.char}抽取${mainMinItem.suit}套装`;
                html += `<div class="recommend-box" style="margin-bottom:10px;"><span style="color:var(--primary-color);">定向主词条时资源消耗最小的具体抽取方式：</span>${mainText}，期望消耗${formatCost(mainMinItem.costAudio1, 'assets/costs/tape.png')}${formatCost(mainMinItem.costAudio2, 'assets/costs/directed-position.png')}</div>`;
            }
            recommendArea.innerHTML = html;
        }
        document.getElementById('result-area').style.display = 'block';
    }
