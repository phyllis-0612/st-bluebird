import { getSettings, setSetting } from './settings.js?v=0.5.1';

/** 使用直接点选按钮，避免移动端原生选择器提交时序影响入口切换。 */
export function createEntryModeControl() {
    const group = document.createElement('div');
    group.className = 'bb-entry-options';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', '入口显示方式');
    for (const [value, text] of [['floating', '悬浮球'], ['wand', '收进魔法棒']]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'bb-entry-choice';
        button.dataset.bbEntryChoice = value;
        button.textContent = text;
        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            setSetting('entryMode', value);
            syncEntryModeControls();
        });
        group.appendChild(button);
    }
    syncEntryModeControls(group);
    return group;
}

export function syncEntryModeControls(scope = document) {
    const mode = getSettings().entryMode;
    scope.querySelectorAll('[data-bb-entry-choice]').forEach((button) => {
        const active = button.dataset.bbEntryChoice === mode;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', String(active));
    });
}
