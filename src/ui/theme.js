// 配色、设置弹窗、教程弹窗。

import { saveSettings, state } from '../app/store.js';
import { themes } from '../data/themes.js';
import { tutorialText } from '../data/tutorial.js';
import { hexToRgb } from '../domain/format.js';

export function applyTheme(t) { const root = document.documentElement; root.style.setProperty('--primary-color', t.primary); root.style.setProperty('--bg-color', t.bg); root.style.setProperty('--bg-secondary', t.bg2); root.style.setProperty('--text-color', t.text); root.style.setProperty('--text-muted', t.muted); root.style.setProperty('--border-color', t.border); root.style.setProperty('--text-on-primary', t.textOnPrimary); const rgb = hexToRgb(t.primary); root.style.setProperty('--primary-color-alpha', `rgba(${rgb}, 0.2)`); root.style.setProperty('--primary-color-alpha-light', `rgba(${rgb}, 0.05)`); root.style.setProperty('--primary-color-alpha-border', `rgba(${rgb}, 0.25)`); }

export function initThemeSelector() { const container = document.getElementById('theme-selector'); container.innerHTML = ''; themes.forEach((t, i) => { const btn = document.createElement('button'); btn.className = 'theme-btn' + (i === 0 ? ' active' : ''); btn.style.setProperty('--c1', t.left); btn.style.setProperty('--c2', t.right); btn.dataset.index = i; btn.onclick = () => { document.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('active')); btn.classList.add('active'); applyTheme(t); }; container.appendChild(btn); }); }

export function openSettingsModal() {
        document.getElementById('setting-auto-collapse-import').checked = state.settings.autoCollapseImport;
        document.getElementById('setting-auto-collapse-output').checked = state.settings.autoCollapseOutput;
        document.getElementById('settings-modal').style.display = 'flex';
    }

export function closeSettingsModal() {
        document.getElementById('settings-modal').style.display = 'none';
    }

export function updateSetting(key, value) {
        state.settings[key] = value;
        saveSettings();
    }

export function openTutorialModal() {
        document.getElementById('tutorial-modal').style.display = 'flex';
        document.getElementById('tutorial-content').innerHTML = tutorialText;
    }

export function closeTutorialModal() {
        document.getElementById('tutorial-modal').style.display = 'none';
    }
