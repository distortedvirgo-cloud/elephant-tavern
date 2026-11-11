/*
 * Elephant Game — the prompt editor (Герой → Промпты).
 *
 * Every instruction the game sends to a model is listed here; the player can read it, edit it by
 * hand, reset it, or describe a change in plain words and let the helper model rewrite the
 * templates ("Изменить через ИИ"). Edits are global (extension settings), not per chat.
 */
import * as P from './prompts.js';

const $ = (...a) => globalThis.jQuery(...a);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

let D = null;      // deps from index.js: { S, ctx, callHelper, hasHelper, stageSettings, openSheet, toast, log, back }
let view = { name: 'list' };

const store = () => { const s = D.S(); s.prompts ??= {}; return s.prompts; };
function commit() {
    P.setOverrides(store());
    D.ctx().saveSettingsDebounced();
}
function setText(id, text) {
    const st = store();
    if (text === P.defaultText(id)) delete st[id]; else st[id] = text;
}

const kids = (id) => Object.entries(P.PROMPTS).filter(([, p]) => p.parent === id).map(([k]) => k);
const family = (id) => [id, ...kids(id)];
const changedFamily = (id) => family(id).some(P.isChanged);
const lostVars = (id) => family(id).flatMap(k => P.missingVars(k, P.textOf(k)));

// ------------------------------------------------------------------ list

function listHtml() {
    const s = D.S();
    const groups = Object.entries(P.GROUPS).map(([gid, g]) => {
        const rows = Object.entries(P.PROMPTS).filter(([, p]) => p.group === gid && !p.parent).map(([id, p]) => {
            const lost = lostVars(id);
            const empty = !P.textOf(id).trim();
            return `<button class="eg2-prow" data-pid="${id}">
                <span class="eg2-prow-main"><b>${esc(p.title)}</b><small>${esc(p.desc)}</small></span>
                ${lost.length ? '<span class="eg2-pill eg2-pill-bad">⚠ нет вставки</span>' : changedFamily(id) ? '<span class="eg2-pill eg2-pill-gold">изменён</span>' : empty ? '<span class="eg2-pill">пусто</span>' : ''}
                <i class="fa-solid fa-chevron-right"></i>
            </button>`;
        }).join('');
        return `<h4 class="eg-h">${g.ru} <small>${g.hint}</small></h4><div class="eg2-sec eg2-sec-list">${rows}</div>`;
    }).join('');
    const anyChanged = Object.keys(P.PROMPTS).some(P.isChanged);
    return `
        <div class="eg2-head"><h3 class="eg-title">📝 Промпты игры</h3><button class="eg2-x" data-pa="close" aria-label="Закрыть">✕</button></div>
        <p class="eg-muted eg2-lead">Все инструкции, которые игра отправляет моделям. Правки действуют сразу и во всех чатах.</p>
        <div class="eg2-ai">
            <b>✨ Изменить словами</b>
            <textarea id="egp_ask" class="text_pole" rows="3" placeholder="Например: «пусть судья реже просит броски, а в магазине будет больше зелий»">${esc(view.ask || '')}</textarea>
            <button class="eg-btn" id="egp_go" ${D.hasHelper(D.stageSettings()) ? '' : 'disabled'}>Изменить через ИИ</button>
            ${D.hasHelper(D.stageSettings()) ? '<small class="eg-muted">Служебная модель сама найдёт нужные промпты и покажет правки перед сохранением.</small>' : '<small class="eg-warn">Нужна служебная модель (Сцена и арт → служебная модель).</small>'}
        </div>
        ${groups}
        <label class="eg-check-opt eg2-all"><input type="checkbox" id="egp_all" ${s.promptsAll ? 'checked' : ''}><span><b>Править и формат ответа</b><br><small>Для опытных: формат — это JSON, который игра разбирает. Если его испортить, часть игры перестанет работать (сброс всё вернёт).</small></span></label>
        ${anyChanged ? '<button class="eg-link eg-danger" data-pa="reset-all">Сбросить все промпты к стандартным</button>' : ''}`;
}

// ------------------------------------------------------------------ editor

const VARS_RU = {
    user: 'имя игрока', char: 'имя персонажа', state: 'состояние игры: время, место, навыки, деньги, персонажи', format: 'формат ответа (JSON), который разбирает игра',
    narration: 'последний ответ рассказчика', action: 'что написал игрок', reply: 'ответ рассказчика за этот ход', player: 'сообщение игрока за этот ход',
    eroge: 'пометка эроге-режима (пусто, если он выключен)', memory: 'карточка сюжета из Elephant Memory', counted: 'что игра уже посчитала сама', scale: 'масштаб цен мира',
    currency: 'валюта', money: 'сколько денег у игрока', setting: 'мир и персонаж вкратце', time: 'время в мире', location: 'место', npcs: 'знакомые персонажи', goals: 'цели игрока',
    level: 'уровень героя', name: 'имя персонажа', card: 'карточка персонажа', era: 'эпоха', description: 'описание из карточки', scenario: 'сценарий из карточки',
    opening: 'первые сообщения чата', today: 'сегодняшняя дата', forced: 'пометка «она начала без спроса»', partner_record: 'что игра знает о партнёрше', cards: 'правила карточек',
    round: 'номер раунда', variant: 'вариация сцены', partner: 'с кем сцена', sheet: 'сведения о партнёрше или противнике', bars: 'шкалы сцены', last_moves: 'последние ходы',
    participants: 'участники', target: 'выбранная цель',
};

function varsHtml(id, text) {
    const vars = P.varsOf(P.defaultText(id));
    if (!vars.length) return '';
    const lost = P.missingVars(id, text);
    return `<div class="eg2-vars"><small class="eg-muted">Вставки — игра заменяет их данными. Нажми, чтобы вставить:</small><div class="eg-chips">${vars.map(v => `<button class="eg-chip ${lost.includes(v) ? 'eg-chip-limit' : ''}" data-var="${v}">{{${v}}}</button>`).join('')}</div><ul class="eg2-legend">${vars.map(v => `<li><code>{{${v}}}</code> — ${VARS_RU[v] || 'данные игры'}</li>`).join('')}</ul>${lost.length ? `<p class="eg-warn">В тексте нет вставки ${lost.map(v => `{{${v}}}`).join(', ')} — модель не получит эту часть.</p>` : ''}</div>`;
}

function editHtml(id) {
    const p = P.PROMPTS[id];
    const all = D.S().promptsAll;
    const formats = kids(id).map(k => {
        const kp = P.PROMPTS[k];
        return all
            ? `<h4 class="eg-h">${esc(kp.title)} <small>осторожно: это разбирает игра</small></h4><textarea class="text_pole eg2-ta eg2-ta-fmt" data-tid="${k}" rows="6" spellcheck="false">${esc(P.textOf(k))}</textarea>`
            : `<details class="eg2-fmt"><summary>${esc(kp.title)} <small>только чтение</small></summary><pre>${esc(P.textOf(k))}</pre></details>`;
    }).join('');
    return `
        <div class="eg2-head"><button class="eg2-x" data-pa="back" aria-label="Назад"><i class="fa-solid fa-arrow-left"></i></button><h3 class="eg-title">${esc(p.title)}</h3></div>
        <p class="eg-muted eg2-lead">${esc(p.desc)}</p>
        <textarea class="text_pole eg2-ta" data-tid="${id}" id="egp_text" rows="14" spellcheck="false" placeholder="${p.text ? '' : 'Пусто. Напиши свои правила — по-английски модель понимает точнее, по-русски тоже можно.'}">${esc(P.textOf(id))}</textarea>
        <div id="egp_vars">${varsHtml(id, P.textOf(id))}</div>
        ${formats}
        <div class="eg2-actions">
            <button class="eg-btn" data-pa="save">Сохранить</button>
            <button class="eg-btn eg-btn-ghost" data-pa="reset" ${changedFamily(id) ? '' : 'disabled'}>Сбросить</button>
        </div>`;
}

// ------------------------------------------------------------------ AI edit

/** Sentence-level diff, good enough to show a player what an edit did. */
function diffHtml(before, after) {
    const split = (t) => String(t).split(/(?<=[.!?:;])\s+|\n+/).map(x => x.trim()).filter(Boolean);
    const a = split(before), b = split(after);
    const inA = new Set(a), inB = new Set(b);
    const added = b.filter(x => !inA.has(x));
    const removed = a.filter(x => !inB.has(x));
    if (!added.length && !removed.length) return '<p class="eg-muted">Текст не изменился.</p>';
    return `${removed.length ? `<div class="eg2-diff eg2-diff-del"><small>Убрано</small>${removed.map(x => `<p>${esc(x)}</p>`).join('')}</div>` : ''}${added.length ? `<div class="eg2-diff eg2-diff-ins"><small>Добавлено</small>${added.map(x => `<p>${esc(x)}</p>`).join('')}</div>` : ''}`;
}

async function aiEdit(ask) {
    const ss = D.stageSettings();
    const all = D.S().promptsAll;
    const pool = Object.entries(P.PROMPTS).filter(([, p]) => all || !p.locked);
    const catalog = pool.map(([id, p]) => `### ${id} — ${p.title}${p.desc ? `: ${p.desc}` : ''}\n${P.textOf(id) || '(empty)'}`).join('\n\n');
    const pick = await D.callHelper(ss, 'You maintain the prompt templates of a narrative RPG app. Output only JSON.',
        `The player wants to change how the game behaves. Decide which prompt templates must be edited to do what they ask.

Player's request:
<request>
${ask.slice(0, 4000)}
</request>

Prompt templates (id — purpose, then the current text):
<templates>
${catalog}
</templates>

Reply with ONE line of JSON: {"changes":[{"id":"template id from the list","what":"exactly what to change in this template, in English; if the player gave exact text to insert, say where it goes and that it is inserted verbatim"}],"reply_ru":"одно-два предложения игроку по-русски: что именно будет изменено; если просьба не про поведение игры или её нельзя выполнить правкой промптов — объясни почему и оставь changes пустым"}
Pick only the templates that really need to change (usually one to three). Use only ids from the list. narrator_extra is the place for new standing rules for the storyteller that fit nowhere else. Keep "what" short: never copy the player's text into it, the editor will see the request itself. Answer at once with the JSON line: no reasoning, no preamble, no code fences.`, 2500, { json: true });
    const j = parseJson(pick) || salvage(pick);
    const wanted = (Array.isArray(j?.changes) ? j.changes : []).filter(c => pool.some(([id]) => id === c?.id) && String(c?.what || '').trim()).slice(0, 4);
    const out = { reply: String(j?.reply_ru || '').slice(0, 400) || (j ? '' : 'Модель ответила не по формату — попробуй ещё раз или поправь промпт вручную.'), changes: [] };
    for (const c of wanted) {
        const cur = P.textOf(c.id);
        const empty = !cur.trim();
        const text = await D.callHelper(ss, 'You edit one prompt template. Output only the complete new template text, nothing else.', empty
            ? `This prompt template is empty: it holds extra standing rules added to the game's instructions. Write only the rule lines the change needs: ${String(c.what).slice(0, 1200)}

The player's request (any exact text they give to add goes in word for word):
<request>
${ask.slice(0, 4000)}
</request>

Rules: English, one to five short lines starting with "- ", only what this change needs. No headings, no other rules, no explanations, no code fences. Output the lines and nothing else.`
            :
            `Rewrite this prompt template so that it does the following: ${String(c.what).slice(0, 1200)}

The player's request (any exact text they give to add goes in word for word):
<request>
${ask.slice(0, 4000)}
</request>

Rules: change only what the request needs and keep everything else word for word. Keep the template's language (English instructions stay English). Keep every {{placeholder}} in double braces exactly as it is. Output the complete new template and nothing else: no comments, no explanations, no code fences.

<template>
${cur}
</template>`, Math.min(4000, Math.round((cur.length + ask.length) / 2.2) + 1500));
        const clean = stripThink(text).replace(/^```[a-z]*\n?|\n?```$/g, '').replace(/^<template>\n?|\n?<\/template>$/g, '').trim();
        if (clean && clean !== cur.trim()) out.changes.push({ id: c.id, what: String(c.what), before: cur, after: clean });
    }
    return out;
}

/** Reasoning models sometimes put their thinking in the answer. */
const stripThink = (text) => String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*<\/think>/i, '').trim();

/** A JSON answer cut off mid-way: take whatever complete {"id","what"} pairs it has. */
function salvage(text) {
    const s = stripThink(text);
    const changes = [...s.matchAll(/"id"\s*:\s*"([\w-]+)"\s*,\s*"what"\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map(m => ({ id: m[1], what: m[2].replace(/\\"/g, '"') }));
    const r = s.match(/"reply_ru"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    return changes.length || r ? { changes, reply_ru: r ? r[1] : '' } : null;
}

function parseJson(text) {
    const m = stripThink(text).match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch { return null; }
}

function previewHtml(res) {
    return `
        <div class="eg2-head"><button class="eg2-x" data-pa="back" aria-label="Назад"><i class="fa-solid fa-arrow-left"></i></button><h3 class="eg-title">✨ Правки от ИИ</h3></div>
        ${res.reply ? `<p class="eg2-reply">${esc(res.reply)}</p>` : ''}
        ${res.changes.length ? res.changes.map((c, i) => {
        const lost = P.missingVars(c.id, c.after);
        return `<div class="eg2-sec eg2-change">
            <label class="eg-check-opt"><input type="checkbox" data-take="${i}" checked><span><b>${esc(P.PROMPTS[c.id].title)}</b></span></label>
            ${diffHtml(c.before, c.after)}
            ${lost.length ? `<p class="eg-warn">Пропала вставка ${lost.map(v => `{{${v}}}`).join(', ')} — эту правку лучше не применять.</p>` : ''}
        </div>`;
    }).join('') : '<p class="eg-muted">Менять нечего.</p>'}
        <div class="eg2-actions">
            ${res.changes.length ? '<button class="eg-btn" data-pa="apply">Применить отмеченное</button>' : ''}
            <button class="eg-btn eg-btn-ghost" data-pa="back">${res.changes.length ? 'Отмена' : 'Назад'}</button>
        </div>`;
}

// ------------------------------------------------------------------ wiring

function render() {
    const $b = $('#eg-prompts .eg-sheet-body');
    if (view.name === 'edit') $b.html(editHtml(view.id));
    else if (view.name === 'preview') $b.html(previewHtml(view.res));
    else $b.html(listHtml());
    $b.scrollTop(0);
}

function bind() {
    const $b = $('#eg-prompts .eg-sheet-body');
    $b.off('click input change')
        .on('click', '[data-pid]', function () { view = { name: 'edit', id: this.dataset.pid }; render(); })
        .on('click', '[data-pa="close"]', () => D.back())
        .on('click', '[data-pa="back"]', () => { view = { name: 'list', ask: view.ask }; render(); })
        .on('change', '#egp_all', function () { D.S().promptsAll = this.checked; D.ctx().saveSettingsDebounced(); })
        .on('input', '#egp_text', function () { $('#egp_vars').html(varsHtml(view.id, this.value)); })
        .on('click', '[data-var]', function () {
            const ta = document.getElementById('egp_text');
            if (!ta) return;
            const ins = `{{${this.dataset.var}}}`;
            const at = ta.selectionStart ?? ta.value.length;
            ta.value = ta.value.slice(0, at) + ins + ta.value.slice(ta.selectionEnd ?? at);
            ta.focus(); ta.selectionStart = ta.selectionEnd = at + ins.length;
            $('#egp_vars').html(varsHtml(view.id, ta.value));
        })
        .on('click', '[data-pa="save"]', () => {
            $b.find('textarea[data-tid]').each(function () { setText(this.dataset.tid, this.value); });
            commit();
            D.toast('Промпт сохранён', 'good');
            view = { name: 'list' }; render();
        })
        .on('click', '[data-pa="reset"]', async () => {
            const ok = await D.ctx().Popup.show.confirm('Сбросить промпт?', 'Вернётся стандартный текст. Твои правки этого промпта пропадут.', { okButton: 'Сбросить', cancelButton: 'Назад' });
            if (!ok) return;
            for (const k of family(view.id)) delete store()[k];
            commit();
            render();
        })
        .on('click', '[data-pa="reset-all"]', async () => {
            const ok = await D.ctx().Popup.show.confirm('Сбросить все промпты?', 'Все правки пропадут, игра вернётся к стандартным инструкциям.', { okButton: 'Сбросить всё', cancelButton: 'Назад' });
            if (!ok) return;
            D.S().prompts = {};
            commit();
            render();
        })
        .on('click', '#egp_go', async function () {
            const ask = String($('#egp_ask').val() || '').trim();
            if (ask.length < 4) { D.toast('Напиши, что изменить', 'warn'); return; }
            view.ask = ask;
            $(this).prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> Читаю промпты…');
            try {
                const res = await aiEdit(ask);
                view = { name: 'preview', res, ask };
            } catch (e) {
                D.log('prompt ai edit failed', e);
                D.toast('Не получилось: служебная модель не ответила', 'bad');
            }
            render();
        })
        .on('click', '[data-pa="apply"]', () => {
            let n = 0;
            $b.find('[data-take]:checked').each(function () { const c = view.res.changes[Number(this.dataset.take)]; if (c) { setText(c.id, c.after); n++; } });
            commit();
            D.toast(n ? `Изменено промптов: ${n}` : 'Ничего не выбрано', n ? 'good' : 'warn');
            view = { name: 'list' }; render();
        });
}

export function openPrompts(deps) {
    D = deps;
    view = { name: 'list' };
    render();
    bind();
    D.openSheet('eg-prompts');
}

/* tests only */
export const _test = { aiEdit: (...a) => aiEdit(...a), salvage, setDeps: (d) => { D = d; } };
