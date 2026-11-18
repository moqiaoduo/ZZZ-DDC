// 概率计算核心。纯函数：不碰 DOM、不读全局状态，同样的入参永远同样的结果。

export const Achance = 0.2011577424023155;

export const Bchance = 0.798842257597684516;

export const Atimes = 5;

export const Btimes = 4;

export function parseNumber(str) { str = str.trim(); if (str === '') return 0; if (str.includes('/')) { const p = str.split('/'); if (p.length !== 2) return NaN; return parseFloat(p[0]) / parseFloat(p[1]); } return parseFloat(str); }

export function dfsUp(leaveTimes, nowAdd, need, nowGroup, counter) { if (leaveTimes <= 0) { counter.total++; if (nowAdd > need) counter.pass++; return; } for (let i = 0; i < nowGroup.length; i++) dfsUp(leaveTimes - 1, nowAdd + nowGroup[i].score, need, nowGroup, counter); }

export function passChance(times, need, nowGroup) { const c = { total: 0, pass: 0 }; dfsUp(times, 0, need, nowGroup, c); return c.total === 0 ? 0 : c.pass / c.total; }

export function firstGroup(savePool, shortGroup, basicSc, presentWeight, allGroups, requiredTypes = []) { if (shortGroup.length === 4) { if (requiredTypes.length > 0) { const typesInGroup = new Set(shortGroup.map(item => item.typeIndex)); if (!requiredTypes.every(t => typesInGroup.has(t))) return; } allGroups.push({ firstFour: [...shortGroup], basicsc: basicSc, weight: presentWeight }); return; } for (let i = 0; i < savePool.length; i++) { if (savePool[i].rest <= 0) continue; const nP = savePool.map(item => ({ ...item })); nP[i].rest--; shortGroup.push({ ...savePool[i] }); firstGroup(nP, shortGroup, basicSc + savePool[i].score, presentWeight * savePool[i].rest, allGroups, requiredTypes); shortGroup.pop(); } }

export function calculateCore(entryList, goal, scaleFactor, directedTypes = []) { const allGroups = []; firstGroup(entryList, [], 0, 1, allGroups, directedTypes); let gA = 0, gB = 0, tW = 0; for (const gr of allGroups) { let sA, sB; if (gr.basicsc > goal) { sA = 1; sB = 1; } else { const nd = goal - gr.basicsc; sA = passChance(Atimes, nd, gr.firstFour); sB = passChance(Btimes, nd, gr.firstFour); } gA += sA * gr.weight; gB += sB * gr.weight; tW += gr.weight; } const mA = tW === 0 ? 0 : gA / tW; const mB = tW === 0 ? 0 : gB / tW; const ch = Achance * mA + Bchance * mB; return { mchanceA: mA, mchanceB: mB, chance: ch, scaledChance: ch * scaleFactor }; }

export function calculateCoreGame(types, goal, scaleFactor, directedTypes = []) { const combinationMap = new Map(); function enumerate(seqIndices, seqScores, currentWeight, remaining) { if (seqIndices.length === 4) { const key = [...seqIndices].sort((a,b)=>a-b).join(','); if (combinationMap.has(key)) combinationMap.get(key).weight += currentWeight; else combinationMap.set(key, { weight: currentWeight, scores: seqScores.map(s => ({score: s})) }); return; } const totalW = remaining.reduce((sum, t) => sum + (t.rest > 0 ? t.specialWeight : 0), 0); for (let i = 0; i < remaining.length; i++) { const t = remaining[i]; if (t.rest <= 0) continue; const prob = t.specialWeight / totalW; const nextRemaining = remaining.map(item => ({...item})); nextRemaining[i].rest--; enumerate([...seqIndices, t.typeIndex], [...seqScores, t.score], currentWeight * prob, nextRemaining); } } const initialRemaining = types.map(t => ({...t})); enumerate([], [], 1, initialRemaining); let totalWeight = 0, totalA = 0, totalB = 0; for (const [key, entry] of combinationMap.entries()) { const typeIndices = key.split(',').map(Number); if (directedTypes.length > 0 && !directedTypes.every(dt => typeIndices.includes(dt))) continue; const baseScore = entry.scores.reduce((sum, s) => sum + s.score, 0); const pA = baseScore > goal ? 1 : passChance(Atimes, goal - baseScore, entry.scores); const pB = baseScore > goal ? 1 : passChance(Btimes, goal - baseScore, entry.scores); totalWeight += entry.weight; totalA += pA * entry.weight; totalB += pB * entry.weight; } if (totalWeight === 0) return { mchanceA:0, mchanceB:0, chance:0, scaledChance:0 }; const mA = totalA / totalWeight; const mB = totalB / totalWeight; const ch = Achance * mA + Bchance * mB; return { mchanceA: mA, mchanceB: mB, chance: ch, scaledChance: ch * scaleFactor }; }
