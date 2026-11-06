/*
 * Elephant Core — the mobile chat screen.
 *
 *  • gestures on messages: swipe left on the last reply → another variant,
 *    swipe right → back; long-press any message → action sheet;
 *  • the per-message button row is replaced by that sheet on phones;
 *  • reply ideas: three short options for {{user}} (bold / careful / unexpected)
 *    from the helper model, as chips over the input — tap sends, hold edits.
 */
import { branchChat, createNewBookmark } from '../../bookmarks.js';
import { ctx, callHelper, hasHelper, memoryState, haptic, log, toast } from '../stage/helper.js';

const $ = (...a) => globalThis.jQuery(...a);
const MODULE = 'elephant_chat';
const DEFAULTS = { gestures: true, ideas: 'button' }; // ideas: off | button | auto

function S() {
    const es = ctx().extensionSettings;
    es[MODULE] ??= structuredClone(DEFAULTS);
    for (const [k, v] of Object.entries(DEFAULTS)) if (es[MODULE][k] === undefined) es[MODULE][k] = v;
    return es[MODULE];
}
const stageSettings = () => ctx().extensionSettings?.elephant_stage ?? {};
const shell = () => document.body.classList.contains('et-shell');

// ------------------------------------------------------------------ gestures

function lastMesId() { return (ctx().chat?.length ?? 0) - 1; }

function bindGestures() {
    const chatEl = document.getElementById('chat');
    if (!chatEl) return;
    let start = null;
    let pressTimer = null;
    let moved = false;

    const clear = () => { clearTimeout(pressTimer); pressTimer = null; };

    chatEl.addEventListener('touchstart', (e) => {
        if (!S().gestures || e.touches.length !== 1) return;
        const mes = e.target.closest('.mes');
        if (!mes || e.target.closest('textarea, input, button, a, .mes_buttons, .swipe_left, .swipe_right, .mes_edit_buttons, .mes_media_container')) return;
        if (mes.querySelector('.edit_textarea')) return;
        start = { x: e.touches[0].clientX, y: e.touches[0].clientY, mes, t: Date.now() };
        moved = false;
        pressTimer = setTimeout(() => {
            if (!moved && start) {
                haptic('tick');
                openActions(Number(mes.getAttribute('mesid')));
                start = null;
            }
        }, 480);
    }, { passive: true });

    chatEl.addEventListener('touchmove', (e) => {
        if (!start) return;
        const dx = e.touches[0].clientX - start.x;
        const dy = e.touches[0].clientY - start.y;
        if (Math.abs(dx) > 10 || Math.abs(dy) > 10) { moved = true; clear(); }
        const id = Number(start.mes.getAttribute('mesid'));
        if (id === lastMesId() && !ctx().chat[id]?.is_user && Math.abs(dx) > Math.abs(dy) * 1.4) {
            start.mes.style.transform = `translateX(${Math.max(-60, Math.min(60, dx * 0.35))}px)`;
        }
    }, { passive: true });

    chatEl.addEventListener('touchend', (e) => {
        clear();
        if (!start) return;
        const mes = start.mes;
        mes.style.transform = '';
        const dx = e.changedTouches[0].clientX - start.x;
        const dy = e.changedTouches[0].clientY - start.y;
        const id = Number(mes.getAttribute('mesid'));
        const fast = Date.now() - start.t < 700;
        start = null;
        if (!fast || Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.6) return;
        if (id !== lastMesId() || ctx().chat[id]?.is_user) return;
        haptic('tick');
        $(mes).find(dx < 0 ? '.swipe_right' : '.swipe_left').first().trigger('click');
    });
    chatEl.addEventListener('touchcancel', () => { clear(); if (start) start.mes.style.transform = ''; start = null; });
}

// ------------------------------------------------------------------ action sheet

function ensureSheet() {
    if (document.getElementById('ec-actions')) return;
    $('body').append('<div id="ec-scrim"></div><section id="ec-actions" class="ec-sheet"><div class="ec-grip"></div><div class="ec-preview"></div><div class="ec-list"></div></section>');
    $('#ec-scrim').on('click', closeActions);
}

function closeActions() {
    const open = $('#ec-actions').hasClass('ec-open');
    $('#ec-actions').removeClass('ec-open');
    $('body').removeClass('ec-sheet-open');
    return open;
}

function openActions(id) {
    const c = ctx();
    const msg = c.chat?.[id];
    if (!msg) return;
    ensureSheet();
    const isLast = id === lastMesId();
    const isChar = !msg.is_user && !msg.is_system;
    const $mes = $(`#chat .mes[mesid="${id}"]`);
    const items = [
        ['copy', 'fa-copy', 'Копировать'],
        ['edit', 'fa-pen', 'Редактировать'],
        isChar && isLast && ['continue', 'fa-forward', 'Продолжить ответ'],
        isChar && isLast && ['swipe', 'fa-shuffle', 'Другой вариант'],
        isChar && globalThis.ElephantStage && ['pov', 'fa-eye', 'POV-кадр этой сцены'],
        isChar && globalThis.ElephantStage && ['portrait', 'fa-image-portrait', 'Портрет персонажа'],
        $mes.find('.em_tr_toggle').length && ['translate', 'fa-globe', 'Перевод ⇄ оригинал'],
        ['branch', 'fa-code-branch', 'Ветка отсюда'],
        ['checkpoint', 'fa-flag', 'Чекпоинт'],
        ['delete', 'fa-trash-can', id === lastMesId() ? 'Удалить' : 'Удалить отсюда и ниже', 'ec-danger'],
    ].filter(Boolean);
    const text = String(msg.extra?.display_text || msg.mes || '').replace(/<[^>]+>/g, '').trim();
    $('#ec-actions .ec-preview').html(`<b>${escapeHtml(msg.name)}</b><span>${escapeHtml(text.slice(0, 160))}${text.length > 160 ? '…' : ''}</span>`);
    $('#ec-actions .ec-list').html(items.map(([act, icon, label, cls]) => `<button class="ec-item ${cls || ''}" data-act="${act}"><i class="fa-solid ${icon}"></i><span>${label}</span></button>`).join(''))
        .off('click').on('click', '.ec-item', async function () {
            closeActions();
            await runAction(this.dataset.act, id, $mes, text);
        });
    $('#ec-actions').addClass('ec-open');
    $('body').addClass('ec-sheet-open');
}

async function runAction(act, id, $mes, text) {
    const c = ctx();
    switch (act) {
        case 'copy':
            try { await navigator.clipboard.writeText(text); toast().success('Скопировано'); } catch { toast().warning('Не удалось скопировать'); }
            break;
        case 'edit': $mes.find('.mes_edit').first().trigger('click'); break;
        case 'continue': await c.executeSlashCommandsWithOptions('/continue'); break;
        case 'swipe': $mes.find('.swipe_right').first().trigger('click'); break;
        case 'pov': globalThis.ElephantStage?.generateFor(id, 'pov'); break;
        case 'portrait': globalThis.ElephantStage?.generateFor(id, 'portrait'); break;
        case 'translate': $mes.find('.em_tr_toggle').first().trigger('click'); break;
        case 'branch': await branchChat(id); break;
        case 'checkpoint': await createNewBookmark(id); break;
        case 'delete': {
            const last = lastMesId();
            const many = id < last;
            const ok = await c.Popup.show.confirm(many ? `Удалить ${last - id + 1} сообщ.?` : 'Удалить сообщение?', many ? 'Это сообщение и все после него.' : '');
            if (ok) await c.executeSlashCommandsWithOptions(`/cut ${id}-${last}`);
            break;
        }
        default:
    }
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// ------------------------------------------------------------------ reply ideas

const IDEAS_PROMPT = `You suggest what {{user}} could do or say next in an interactive story. {{user}} is the player; {{char}}'s narrator runs the world.

{{state}}Recent story:
<story>
{{messages}}
</story>
{{game}}
Give THREE distinct options for {{user}}'s next move, each a single short first-person line (max 15 words) that mixes action and/or speech in the story's style, e.g. *I step closer.* "Then prove it."
1. bold — direct, takes a risk; 2. careful — cautious or clever; 3. unexpected — a surprising but in-character turn.
Reply with ONE line of minified JSON: {"options":[{"tone":"bold","en":"...","ru":"то же по-русски"},{"tone":"careful","en":"...","ru":"..."},{"tone":"unexpected","en":"...","ru":"..."}]}`;

let ideasFor = -1;
let ideasBusy = false;

function ensureIdeasBar() {
    if (document.getElementById('ec-ideas')) return;
    $('#form_sheld').prepend('<div id="ec-ideas"></div>');
    if (!document.getElementById('ec-ideas-btn')) {
        $('#leftSendForm').append('<div id="ec-ideas-btn" class="fa-solid fa-lightbulb interactable" title="Варианты ответа" tabindex="0"></div>');
        $('#ec-ideas-btn').on('click', () => (document.getElementById('ec-ideas').childElementCount ? clearIdeas() : loadIdeas(true)));
    }
}

function clearIdeas() {
    $('#ec-ideas').empty().removeClass('ec-show');
}

function recentStory(n = 6) {
    return (ctx().chat ?? []).filter(m => !m.is_system && m.mes).slice(-n)
        .map(m => `${m.name}: ${String(m.mes).replace(/<[^>]+>/g, '').slice(0, 900)}`).join('\n\n');
}

async function loadIdeas(force = false) {
    const c = ctx();
    const id = lastMesId();
    const last = c.chat?.[id];
    if (!last || last.is_user || ideasBusy) return;
    if (!force && ideasFor === id) return;
    const ss = stageSettings();
    if (!hasHelper(ss)) { if (force) toast().info('Выберите служебную модель в «Сцена и арт»'); return; }
    ideasBusy = true;
    ideasFor = id;
    ensureIdeasBar();
    $('#ec-ideas').addClass('ec-show').html('<div class="ec-idea ec-loading"><i class="fa-solid fa-lightbulb fa-beat-fade"></i> Думаю над вариантами…</div>');
    try {
        const game = globalThis.ElephantGame?.isActive?.() ? `\nGame state: ${globalThis.ElephantGame.engine.stateSummary(globalThis.ElephantGame.currentState()).slice(0, 700)}\n` : '';
        const state = memoryState();
        const prompt = IDEAS_PROMPT
            .replaceAll('{{state}}', state ? `Story state:\n<state>\n${state.slice(0, 2000)}\n</state>\n\n` : '')
            .replaceAll('{{messages}}', recentStory())
            .replaceAll('{{game}}', game)
            .replaceAll('{{user}}', c.name1).replaceAll('{{char}}', c.name2);
        const out = await callHelper(ss, 'You write short, vivid player options for interactive fiction. Output only JSON.', prompt, 320, { json: true });
        if (lastMesId() !== id) return;
        const m = String(out).match(/\{[\s\S]*\}/);
        const options = m ? JSON.parse(m[0]).options : null;
        if (!Array.isArray(options) || !options.length) throw new Error('пустой ответ');
        renderIdeas(options.slice(0, 3));
    } catch (e) {
        log('ideas failed', e);
        $('#ec-ideas').html(`<div class="ec-idea ec-loading">Не получилось: ${escapeHtml(e.message || e)}</div>`);
        setTimeout(clearIdeas, 3000);
    } finally {
        ideasBusy = false;
    }
}

const TONE = { bold: ['🔥', 'Смело'], careful: ['🛡', 'Осторожно'], unexpected: ['🎲', 'Неожиданно'] };

function renderIdeas(options) {
    const $bar = $('#ec-ideas').empty().addClass('ec-show');
    for (const o of options) {
        const [icon, label] = TONE[o.tone] || ['✨', ''];
        const $b = $(`<button class="ec-idea" data-tone="${escapeHtml(o.tone)}"><small>${icon} ${label}</small><span>${escapeHtml(o.ru || o.en)}</span></button>`);
        // A scroll through the bar must never pick an idea: only a still tap sends, a still hold edits.
        let held = false;
        let moved = false;
        let t = null;
        let x0 = 0;
        let y0 = 0;
        const pos = (e) => (e.touches?.[0] ?? e.changedTouches?.[0] ?? e);
        $b.on('touchstart mousedown', (e) => {
            const p = pos(e.originalEvent ?? e);
            x0 = p.clientX; y0 = p.clientY;
            held = false; moved = false;
            clearTimeout(t);
            t = setTimeout(() => { if (!moved) { held = true; useIdea(o, false); haptic('tick'); } }, 550);
        })
            .on('touchmove mousemove', (e) => {
                const p = pos(e.originalEvent ?? e);
                if (Math.abs(p.clientX - x0) > 8 || Math.abs(p.clientY - y0) > 8) { moved = true; clearTimeout(t); }
            })
            .on('touchend mouseup mouseleave touchcancel', () => clearTimeout(t))
            .on('click', (e) => { if (held || moved) { e.preventDefault(); return; } useIdea(o, true); });
        $bar.append($b);
    }
}

function useIdea(o, send) {
    const $ta = $('#send_textarea');
    $ta.val(o.en).trigger('input');
    clearIdeas();
    if (send) $('#send_but').trigger('click');
    else $ta.trigger('focus');
}

// ------------------------------------------------------------------ settings & init

function settingsHtml() {
    const s = S();
    return `<div class="et-group" id="ec_settings">
        <h4 class="et-h">💬 Чат</h4>
        <label class="et-check"><input type="checkbox" id="ec_gestures" ${s.gestures ? 'checked' : ''}><span>Жесты: свайп последнего ответа — другой вариант, удержание сообщения — меню</span></label>
        <label class="et-field">Варианты ответа (💡 у поля ввода)
            <select id="ec_ideas" class="text_pole">
                <option value="off" ${s.ideas === 'off' ? 'selected' : ''}>Выключены</option>
                <option value="button" ${s.ideas === 'button' ? 'selected' : ''}>По кнопке 💡</option>
                <option value="auto" ${s.ideas === 'auto' ? 'selected' : ''}>Автоматически после каждого ответа (~$0.001 за раз)</option>
            </select>
        </label>
    </div>`;
}

export async function init() {
    S();
    const c = ctx();
    const ev = c.eventSource;
    const et = c.eventTypes ?? c.event_types;
    bindGestures();
    ensureSheet();
    if (S().ideas !== 'off') ensureIdeasBar();
    if (shell()) document.body.classList.add('ec-gesture-ui');

    ev.on(et.MESSAGE_RECEIVED, (_id, type) => {
        clearIdeas();
        if (type === 'impersonate') return;
        if (S().ideas === 'auto') setTimeout(() => loadIdeas(false), 400);
    });
    for (const e of [et.MESSAGE_SENT, et.CHAT_CHANGED, et.MESSAGE_SWIPED, et.MESSAGE_DELETED, et.GENERATION_STARTED]) if (e) ev.on(e, clearIdeas);

    document.addEventListener('et-settings-refresh', () => {
        const $body = $('#et-sheet-stage .et-sheet-body .et-settings, #elephant_stage_settings .et-settings').first();
        if ($body.length && !$body.find('#ec_settings').length) $body.find('.et-group').first().after(settingsHtml());
    });
    $(document).on('change', '#ec_gestures', function () { S().gestures = this.checked; c.saveSettingsDebounced(); });
    $(document).on('change', '#ec_ideas', function () {
        S().ideas = this.value;
        c.saveSettingsDebounced();
        if (this.value === 'off') { clearIdeas(); $('#ec-ideas-btn').remove(); } else ensureIdeasBar();
    });

    // Android back: our sheet first.
    const st = globalThis.ElephantStage;
    if (st && !st.__ecBack) {
        const original = st.handleBack;
        st.handleBack = () => closeActions() || original();
        st.__ecBack = true;
    }
    globalThis.ElephantChat = { openActions, loadIdeas };
}
