// 纯展示格式化：数值 → 带图标的成本文本、配色 → rgb 三元组。

export function hexToRgb(hex) { let result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex); return result ? `${parseInt(result[1],16)}, ${parseInt(result[2],16)}, ${parseInt(result[3],16)}` : '255, 69, 0'; }

export function formatCost(value, imgSrc) {
        if (value === Infinity || isNaN(value)) return '∞';
        if (!imgSrc) return `<span>${value.toFixed(2)}</span>`;
        return `<span>${value.toFixed(2)} <img src="${imgSrc}" class="resource-img"></span>`;
    }
