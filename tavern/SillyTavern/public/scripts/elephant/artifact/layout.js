export const SCROLL_LABELS = new Map([
    ['messages', 'История переписки'],
    ['inbox', 'Входящие сообщения'],
    ['log', 'Записи журнала'],
    ['document', 'Текст записи'],
]);

const BLOCK = 'h1,h2,h3,h4,h5,h6,p,blockquote,li,dt,dd,pre,summary,td,th,div,section,article,main,header,footer';

export const SCREEN_STYLE = `
html, body { margin: 0 !important; min-width: 0 !important; max-width: 100% !important; overflow: clip !important; }
body *, body { box-sizing: border-box !important; min-width: 0 !important; max-width: 100% !important; overflow-wrap: anywhere !important; }
pre { white-space: pre-wrap !important; }
[data-action] { white-space: normal !important; }
[data-action]:focus-visible, [data-scroll]:focus-visible { outline: 2px solid currentColor; outline-offset: -2px; }
[data-scroll] {
    min-height: 0 !important;
    max-height: 100dvh !important;
    overflow-x: hidden !important;
    overflow-y: auto !important;
    overscroll-behavior: contain;
}
`;

const COMPACT_STYLE = `
html { color-scheme: dark; }
body { background: #211f23; color: #f0ece5; font: 14px/1.35 system-ui, sans-serif; }
main {
    height: 100dvh; display: grid; grid-template-rows: minmax(0, 1fr) auto;
    gap: 8px; padding: 10px;
}
.ea-copy { display: flex; flex-direction: column; align-items: stretch; gap: 6px; }
.ea-copy > *, .ea-record p { margin: 0; white-space: pre-line; }
h2 { font-size: 1.15em; line-height: 1.25; }
nav { display: grid; gap: 5px; }
nav[data-columns="2"] { grid-template-columns: repeat(2, minmax(0, 1fr)); }
nav[data-columns="3"] { grid-template-columns: repeat(3, minmax(0, 1fr)); }
button, summary {
    min-height: 44px; padding: 5px 7px; background: #332e33; color: inherit;
    border: 1px solid #5d5156; border-radius: 8px; font: inherit;
    text-align: start; cursor: pointer;
}
nav[data-columns="3"] button { font-size: 12px; }
.ea-copy > [data-scroll] { flex: 1 1 auto; }
.ea-copy > details { flex: 1 1 0; min-height: 0; }
.ea-record { padding: 6px 2px; }
.ea-record p + p { margin-top: 6px; }
`;

function collect(doc, actions) {
    const entries = [];
    let previous;
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (parent.closest('[data-scroll], [data-action]')) continue;
        if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.dataset.scroll) {
                entries.push({ region: node });
                previous = undefined;
            }
            if (node.localName === 'br' && previous) previous.text += '\n';
            const action = node.dataset.action;
            if (action && actions.has(action)) {
                const text = node.textContent.trim() || node.getAttribute('aria-label') || node.title
                    || actions.get(action).name || 'Открыть';
                entries.push({ text, tag: 'button', action });
                previous = undefined;
            }
            continue;
        }
        const owner = parent.closest(BLOCK) || doc.body;
        if (!node.textContent.trim() && previous?.owner !== owner) continue;
        if (previous?.owner === owner) {
            previous.text += node.textContent;
        } else {
            previous = { owner, text: node.textContent, tag: /^h[1-6]$/i.test(owner.localName) ? 'h2' : 'p' };
            entries.push(previous);
        }
    }
    return entries.filter(entry => entry.region || entry.text.trim());
}

function overflows(doc, width, height) {
    const root = doc.documentElement;
    if (root.scrollHeight > height + 1 || root.scrollWidth > width + 1
        || doc.body.scrollHeight > height + 1 || doc.body.scrollWidth > width + 1) return true;
    return Array.from(doc.body.querySelectorAll('*')).some(node => {
        if (node.parentElement.closest('[data-scroll]')) return false;
        if (!node.textContent.trim() && !node.matches('[data-action], [data-scroll]')) return false;
        const rect = node.getBoundingClientRect();
        if (rect.width && rect.height && (rect.left < -1 || rect.top < -1
            || rect.right > width + 1 || rect.bottom > height + 1)) return true;
        if (node.hasAttribute('data-scroll')) return node.scrollWidth > node.clientWidth + 1;
        const style = doc.defaultView.getComputedStyle(node);
        return (/auto|scroll|hidden|clip/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1)
            || (/auto|scroll|hidden|clip/.test(style.overflowX) && node.scrollWidth > node.clientWidth + 1);
    });
}

function compactScreen(doc, actions) {
    const entries = collect(doc, actions);
    const shell = doc.createElement('main');
    const copy = doc.createElement('div');
    copy.className = 'ea-copy';
    const menu = doc.createElement('nav');
    for (const entry of entries) {
        if (entry.region) {
            // Keep the author's choice of a reading region and its usable controls.
            for (const node of [entry.region, ...entry.region.querySelectorAll('[style]')]) node.removeAttribute('style');
            copy.append(entry.region);
            continue;
        }
        const node = doc.createElement(entry.tag);
        node.textContent = entry.text.trim();
        if (entry.action) {
            node.type = 'button';
            node.dataset.action = entry.action;
            menu.append(node);
        } else {
            copy.append(node);
        }
    }
    menu.dataset.columns = String(menu.childElementCount > 8 ? 3 : menu.childElementCount > 3 ? 2 : 1);
    shell.append(copy);
    if (menu.childElementCount) shell.append(menu);
    doc.head.querySelectorAll('style').forEach(style => style.remove());
    const style = doc.createElement('style');
    style.textContent = SCREEN_STYLE + COMPACT_STYLE;
    doc.head.append(style);
    doc.body.removeAttribute('style');
    doc.body.replaceChildren(shell);

    let details;
    let summary;
    let record;
    return () => {
        if (!details) {
            // A legacy page can contain more prose than any readable phone screen.
            // Fold the record in place while keeping the page title and navigation.
            if (copy.scrollHeight <= copy.clientHeight + 1) return;
            const title = copy.firstElementChild?.matches('h2') && copy.clientHeight > 100
                ? copy.firstElementChild : null;
            title?.remove();
            details = doc.createElement('details');
            summary = doc.createElement('summary');
            summary.textContent = 'Читать полностью';
            record = doc.createElement('div');
            record.className = 'ea-record';
            record.dataset.scroll = 'document';
            record.tabIndex = 0;
            record.setAttribute('role', 'region');
            record.setAttribute('aria-label', SCROLL_LABELS.get('document'));
            for (const node of copy.querySelectorAll('[data-scroll]')) {
                node.removeAttribute('data-scroll');
                node.removeAttribute('tabindex');
            }
            record.append(...copy.childNodes);
            details.append(summary, record);
            if (title) copy.append(title);
            copy.append(details);
        }
        record.style.height = `${Math.max(0, details.clientHeight - summary.offsetHeight)}px`;
    };
}

function fitIntrinsicHeight(doc, frame, width, height) {
    // A naturally sized page should end near its last control. A page whose
    // design stretches to the viewport keeps the whole available height.
    const bottom = Math.ceil(doc.body.getBoundingClientRect().bottom);
    const borderHeight = frame.offsetHeight - height;
    const naturalHeight = Math.max(bottom + borderHeight + 1, 132);
    if (naturalHeight > height - 24) return;
    frame.style.setProperty('--ea-content-height', `${naturalHeight}px`);
    if (overflows(doc, width, doc.documentElement.clientHeight)) {
        frame.style.removeProperty('--ea-content-height');
    }
}

export function fitArtifactPage(doc, actions, frame) {
    let viewport;
    let fitCompact;
    function layout(force = false) {
        const root = doc.documentElement;
        const size = `${root.clientWidth}:${root.clientHeight}`;
        if (!root.clientWidth || !root.clientHeight || (!force && size === viewport)) return;
        frame.style.removeProperty('--ea-content-height');
        const { clientWidth, clientHeight } = root;
        if (!fitCompact) {
            if (overflows(doc, clientWidth, clientHeight)) fitCompact = compactScreen(doc, actions);
            else fitIntrinsicHeight(doc, frame, clientWidth, clientHeight);
        }
        fitCompact?.();
        viewport = `${root.clientWidth}:${root.clientHeight}`;
    }
    const observer = new ResizeObserver(() => layout());
    const onToggle = () => layout(true);
    observer.observe(doc.documentElement);
    doc.addEventListener('toggle', onToggle, true);
    layout();
    return () => {
        observer.disconnect();
        doc.removeEventListener('toggle', onToggle, true);
    };
}
