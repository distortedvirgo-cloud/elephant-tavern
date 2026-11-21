import dagre from '../../../lib/dagre/dagre-1.1.5.js';

const width = 128;
const height = 56;
const normalize = text => typeof text === 'string' ? text.trim().replace(/\s+/g, ' ') : '';

function placeGraph(initial, chat, state) {
    const graph = new dagre.graphlib.Graph();
    graph.setGraph({ rankdir: 'TB', nodesep: 26, ranksep: 50, marginx: 18, marginy: 20, ranker: 'tight-tree' });
    const ids = new Map();
    let previous;
    function visit(location) {
        const label = normalize(location);
        if (!label) return;
        const key = label.toLowerCase();
        if (!ids.has(key)) {
            const id = String(ids.size);
            ids.set(key, id);
            graph.setNode(id, { label, width, height, exits: new Set() });
        }
        const id = ids.get(key);
        if (previous !== undefined && previous !== id) {
            graph.node(previous).exits.add(id);
            // The same corridor gets a second arrowhead once a return trip occurs.
            if (graph.hasEdge(id, previous)) graph.edge(id, previous).both = true;
            else if (!graph.hasEdge(previous, id)) graph.setEdge(previous, id, { both: false });
        }
        previous = id;
    }
    visit(initial?.location);
    for (const message of chat) visit(message.extra?.elephant_game?.state?.location);
    visit(state.location);
    if (ids.size) dagre.layout(graph);
    return { graph, current: ids.get(normalize(state.location).toLowerCase()) };
}

export function renderMap(panel, initial, chat, state, escape) {
    const { graph, current } = placeGraph(initial, chat, state);
    panel.innerHTML = '<h3 class="eg-title">Карта мест</h3>';
    if (!graph.nodeCount()) {
        panel.insertAdjacentHTML('beforeend', '<p class="eg-muted">В этом чате пока не зафиксировано место действия.</p>');
        return;
    }
    const ids = graph.nodes();
    const size = graph.graph();
    panel.insertAdjacentHTML('beforeend', `
        <div class="eg-map-tools">
            <select class="text_pole" aria-label="Найти место">${ids.map(id => `<option value="${id}">${escape(graph.node(id).label)}</option>`).join('')}</select>
            <button data-map="here" ${current === undefined ? 'disabled' : ''}>Где я</button>
        </div>
        <div class="eg-map-view" tabindex="0" aria-label="Схема переходов">
            <div class="eg-map-size"><div class="eg-map-plane">
                <svg width="${size.width}" height="${size.height}" aria-hidden="true">
                    <defs><marker id="eg-map-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 Z" fill="#bac2ce"/></marker></defs>
                    ${graph.edges().map(edge => {
                        const { points, both } = graph.edge(edge);
                        return `<polyline points="${points.map(p => p.x + ',' + p.y).join(' ')}" fill="none" stroke="#949ba7" stroke-width="2" marker-end="url(#eg-map-arrow)" ${both ? 'marker-start="url(#eg-map-arrow)"' : ''}/>`;
                    }).join('')}
                </svg>
                ${ids.map(id => {
                    const node = graph.node(id);
                    return `<button class="eg-map-node" data-node="${id}" style="left:${node.x - width / 2}px;top:${node.y - height / 2}px;width:${width}px;height:${height}px" title="${escape(node.label)}">
                        <span>${escape(node.label)}</span>${id === current ? '<small>Вы здесь</small>' : ''}
                    </button>`;
                }).join('')}
            </div></div>
        </div>
        <div class="eg-map-tools eg-map-scale"><button data-map="minus" aria-label="Уменьшить">−</button><button data-map="fit">Вся карта</button><button data-map="plus" aria-label="Увеличить">+</button></div>
        <div class="eg-map-detail" aria-live="polite"></div>`);
    const view = panel.querySelector('.eg-map-view');
    const plane = panel.querySelector('.eg-map-plane');
    const spacer = panel.querySelector('.eg-map-size');
    const picker = panel.querySelector('select');
    const detail = panel.querySelector('.eg-map-detail');
    let selected = current ?? ids[0];
    let scale = 1;
    function zoom(value) {
        scale = Math.max(0.01, Math.min(2, value));
        spacer.style.width = size.width * scale + 'px';
        spacer.style.height = size.height * scale + 'px';
        plane.style.transform = `scale(${scale})`;
        const p = graph.node(selected);
        view.scrollTo(spacer.offsetLeft + p.x * scale - view.clientWidth / 2, p.y * scale - view.clientHeight / 2);
    }
    function select(id, center) {
        panel.querySelector(`[data-node="${selected}"]`).setAttribute('aria-pressed', 'false');
        selected = id;
        picker.value = id;
        panel.querySelector(`[data-node="${id}"]`).setAttribute('aria-pressed', 'true');
        const { label, exits } = graph.node(id);
        detail.innerHTML = `<b>${escape(label)}</b><small>${exits.size ? 'Отсюда переходили' : 'Из этого места пока нет записанных переходов.'}</small>
            ${[...exits].map(to => `<button data-exit="${to}">→ ${escape(graph.node(to).label)}</button>`).join('')}`;
        if (center) zoom(Math.max(scale, 0.8));
    }
    const fit = () => zoom(Math.min(1, view.clientWidth / size.width, view.clientHeight / size.height));
    panel.onclick = event => {
        const button = event.target.closest('button');
        if (!button) return;
        if (button.dataset.node !== undefined) select(button.dataset.node, scale < 0.65);
        if (button.dataset.exit !== undefined) select(button.dataset.exit, true);
        switch (button.dataset.map) {
            case 'here': select(current, true); break;
            case 'fit': fit(); break;
            case 'plus': zoom(scale * 1.4); break;
            case 'minus': zoom(scale / 1.4); break;
        }
    };
    picker.onchange = () => select(picker.value, true);
    select(selected, false);
    requestAnimationFrame(() => {
        if (panel.isConnected) zoom(Math.max(0.75, Math.min(1, view.clientWidth / size.width, view.clientHeight / size.height)));
    });
}
