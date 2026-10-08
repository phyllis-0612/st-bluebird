// 青鸟 · 图标（内联 SVG，颜色跟随 currentColor）

function svg(body, size = 22, strokeWidth = 1.7) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}

const BIRD = '<path d="M3 14.2c2.7.5 5.2-.4 6.9-2.6 1.6-2.1 2.6-5 5.5-5.7 1.8-.4 3.3.3 4.1 1.6l1.7.5-1.8 1.1c0 4.7-3.4 8.7-8.6 8.7-3.2 0-6-1.4-7.8-3.6z"/><path d="M9.6 13.3c1.6.7 3.5.5 4.8-.7"/><path d="M8.2 17.6l-2.4 3"/><circle cx="17" cy="8.4" r=".6" fill="currentColor"/>';

export const icons = {
    bird: (size = 22) => svg(BIRD, size, 1.5),
    close: (size = 22) => svg('<path d="M6 6l12 12M18 6L6 18"/>', size),
    chat: (size = 24) => svg('<path d="M5 5h14a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 17h-8l-4.5 3.5V17H5a1.5 1.5 0 0 1-1.5-1.5v-9A1.5 1.5 0 0 1 5 5z"/>', size),
    contacts: (size = 24) => svg('<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5"/>', size),
    settings: (size = 24) => svg('<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>', size),
};
