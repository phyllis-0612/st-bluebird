// 小型 DOM 替身只验证节点、事件和文本写入；不冒充浏览器布局/净化测试。
export function makeDOM() {
    let document;
    class Element {
        constructor(tag = 'div') {
            this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.attributes = {};
            this.style = {}; this.listeners = {}; this.className = ''; this.nodeType = 1;
            this.inert = false; this.hidden = false; this.disabled = false; this.tabIndex = 0;
            this.scrollTop = 0; this.scrollHeight = 900; this.clientHeight = 600;
            this.classList = {
                contains: key => this.className.split(/\s+/).includes(key),
                add: key => { if (!this.classList.contains(key)) this.className = (this.className + ' ' + key).trim(); },
                remove: key => { this.className = this.className.split(/\s+/).filter(c => c !== key).join(' '); },
                toggle: (key, on) => on ? this.classList.add(key) : this.classList.remove(key),
            };
        }
        get isConnected() { return this === document.body || !!this.parent?.isConnected; }
        appendChild(node) { node.remove?.(); node.parent = this; this.children.push(node); return node; }
        get firstChild() { return this.children[0] || null; }
        get nextSibling() { return this.parent?.children[this.parent.children.indexOf(this) + 1] || null; }
        insertBefore(node, before) {
            if (!before) return this.appendChild(node);
            if (node === before) return node;
            node.remove?.(); const index = this.children.indexOf(before);
            if (index < 0) throw new Error('Reference node is not a child');
            node.parent = this; this.children.splice(index, 0, node); return node;
        }
        append(...nodes) { nodes.forEach(node => this.appendChild(node)); }
        replaceChildren(...nodes) { for (const n of this.children) n.parent = null; this.children = []; this._text = ''; this.append(...nodes); }
        remove() { if (this.parent) this.parent.children = this.parent.children.filter(n => n !== this); this.parent = null; }
        set textContent(value) { this.replaceChildren(); this._text = String(value); }
        get textContent() { return (this._text || '') + this.children.map(n => n.textContent).join(''); }
        set innerHTML(value) { this.replaceChildren(); this.html = value; }
        get innerHTML() { return this.html || ''; }
        setAttribute(key, value) { this.attributes[key] = String(value); if (key === 'id') this.id = value; }
        getAttribute(key) {
            if (key.startsWith('data-')) return this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] ?? null;
            return key === 'id' ? this.id ?? null : this.attributes[key] ?? null;
        }
        removeAttribute(key) { delete this.attributes[key]; }
        addEventListener(name, handler) { (this.listeners[name] ||= []).push(handler); }
        click() { if (!this.disabled) for (const fn of this.listeners.click || []) fn({ target: this, preventDefault() {}, stopPropagation() {} }); }
        matches(selector) {
            const parts = selector.trim().split(/\s+/);
            const own = parts.pop();
            const tag = own.match(/^[a-z][\w-]*/i)?.[0];
            if (tag && tag.toUpperCase() !== this.tagName) return false;
            const id = own.match(/#([\w-]+)/)?.[1]; if (id && id !== this.id) return false;
            for (const m of own.matchAll(/\.([\w-]+)/g)) if (!this.classList.contains(m[1])) return false;
            for (const m of own.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
                const value = m[1] === 'hidden' ? (this.hidden ? '' : null) : m[1] === 'inert' ? (this.inert ? '' : null) : this.getAttribute(m[1]);
                if (value === null || (m[2] !== undefined && value !== m[2])) return false;
            }
            if (parts.length) { let p = this.parent; while (p && !p.matches(parts.join(' '))) p = p.parent; if (!p) return false; }
            return true;
        }
        querySelectorAll(selector) {
            const selectors = selector.split(',').map(s => s.trim());
            const nodes = this.children.flatMap(n => [n, ...n.descendants()]);
            return nodes.filter(n => selectors.some(s => n.matches(s)));
        }
        descendants() { return this.children.flatMap(n => [n, ...n.descendants()]); }
        querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
        closest(selector) { let n = this; while (n && !selector.split(',').some(s => n.matches(s))) n = n.parent; return n; }
        contains(node) { return node === this || this.descendants().includes(node); }
        focus() { document.activeElement = this; }
        getClientRects() { return this.hidden ? [] : [{}]; }
        scrollIntoView(options) { this.scrolled = options; }
    }
    document = { createElement: tag => new Element(tag), documentElement: new Element('html'), activeElement: null };
    document.body = new Element('body');
    document.querySelectorAll = selector => document.body.querySelectorAll(selector);
    document.querySelector = selector => document.body.querySelector(selector);
    document.getElementById = id => document.querySelector('#' + id);
    return { document, Element };
}
