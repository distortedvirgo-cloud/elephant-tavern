/*
 * Elephant Core — what the story costs.
 *
 * NanoGPT tells us the account balance; every call of a turn (narrator, helper,
 * translation, images) comes out of it. So a turn's cost is the balance drop from
 * the start of one generation to the start of the next (or ~40 s after the reply,
 * when the helper calls have settled). The day's spend sums every drop seen today
 * (top-ups are ignored). Costs are shown under each reply, in the hub, and a daily
 * limit raises a warning once.
 */
import { ctx, toast, log } from '../stage/helper.js';

const $ = (...a) => globalThis.jQuery(...a);
const MODULE = 'elephant_cost';
const DEFAULTS = { show: true, dailyLimit: 1 };
const DAY_KEY = 'et-cost-day';
const SETTLE_MS = 40_000;

function S() {
    const es = ctx().extensionSettings;
    es[MODULE] ??= structuredClone(DEFAULTS);
    for (const [k, v] of Object.entries(DEFAULTS)) if (es[MODULE][k] === undefined) es[MODULE][k] = v;
    return es[MODULE];
}

const today = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD in local time

function dayData() {
    let d = null;
    try { d = JSON.parse(localStorage.getItem(DAY_KEY) || 'null'); } catch { /* */ }
    if (!d || d.date !== today()) d = { date: today(), spent: 0, last: d?.last ?? null, warned: false };
    return d;
}
function saveDay(d) { try { localStorage.setItem(DAY_KEY, JSON.stringify(d)); } catch { /* */ } }

export function fmt(usd) {
    if (!Number.isFinite(usd)) return '—';
    if (usd === 0) return '$0';
    if (usd < 0.01) return `$${usd.toFixed(4)}`;
    if (usd < 1) return `$${usd.toFixed(3)}`;
    return `$${usd.toFixed(2)}`;
}

let lastBalance = null;

/** Reads the balance and books every drop since the last read into today's spend. */
export async function readBalance() {
    try {
        const res = await fetch('/api/elephant/balance', { method: 'POST', headers: ctx().getRequestHeaders() });
        if (!res.ok) return null;
        const { usd } = await res.json();
        if (!Number.isFinite(usd)) return null;
        const d = dayData();
        if (Number.isFinite(d.last) && d.last > usd) d.spent += d.last - usd; // a rise is a top-up: not spending
        d.last = usd;
        saveDay(d);
        lastBalance = usd;
        checkLimit(d);
        return usd;
    } catch (e) {
        log('balance failed', e);
        return null;
    }
}

function checkLimit(d) {
    const limit = Number(S().dailyLimit);
    if (!(limit > 0) || d.warned || d.spent < limit) return;
    d.warned = true;
    saveDay(d);
    toast().warning(`За сегодня потрачено ${fmt(d.spent)} — больше лимита ${fmt(limit)}.`, 'Elephant Tavern', { timeOut: 15000 });
}

// ------------------------------------------------------------------ per-turn

/** The turn being measured: balance at its start and the message it belongs to. */
let turn = null;
let settleTimer = null;

async function closeTurn(balanceNow) {
    if (!turn || !Number.isFinite(turn.start) || !Number.isFinite(balanceNow)) return;
    const t = turn;
    const cost = Math.max(0, t.start - balanceNow);
    const c = ctx();
    if (c.getCurrentChatId?.() !== t.chatId) return;
    const msg = c.chat?.[t.mesId];
    if (!msg || msg.is_user) return;
    msg.extra ??= {};
    msg.extra.et_cost = Number(cost.toFixed(6));
    renderCost(t.mesId);
    c.saveChat?.();
}

async function onGenerationStarted(type, _opts, dryRun) {
    if (dryRun || type === 'quiet') return;
    clearTimeout(settleTimer);
    const b = await readBalance();
    // The previous turn ends where this one starts.
    if (turn && !turn.closed) { await closeTurn(b); turn.closed = true; }
    turn = { start: b, chatId: ctx().getCurrentChatId?.(), mesId: null, closed: false };
}

function onReplyReady(mesId) {
    if (!turn || turn.closed) return;
    turn.mesId = mesId;
    clearTimeout(settleTimer);
    // A first figure soon, the final one after the helper calls (scene, game, memory) settle.
    setTimeout(async () => { if (turn?.mesId === mesId && !turn.closed) await closeTurn(await readBalance()); }, 6000);
    settleTimer = setTimeout(async () => {
        if (turn?.mesId !== mesId || turn.closed) return;
        await closeTurn(await readBalance());
        turn.closed = true;
    }, SETTLE_MS);
}

// ------------------------------------------------------------------ display

export function chatTotal() {
    return (ctx().chat ?? []).reduce((sum, m) => sum + (Number(m.extra?.et_cost) || 0), 0);
}

function renderCost(mesId) {
    if (!S().show) return;
    const msg = ctx().chat?.[mesId];
    const $mes = $(`#chat .mes[mesid="${mesId}"]`);
    if (!$mes.length) return;
    $mes.find('.et-cost').remove();
    const cost = Number(msg?.extra?.et_cost);
    if (!msg || msg.is_user || !Number.isFinite(cost)) return;
    $mes.find('.mes_block').first().append(`<div class="et-cost" title="Стоимость хода: рассказчик, служебная модель, перевод, картинки">${fmt(cost)}</div>`);
}

function renderAll() {
    $('#chat .et-cost').remove();
    (ctx().chat ?? []).forEach((m, i) => { if (m.extra?.et_cost !== undefined) renderCost(i); });
}

/** One line for the hub: today · this chat · balance. */
export function summaryHtml() {
    const d = dayData();
    return `💰 Сегодня <b>${fmt(d.spent)}</b> · чат <b>${fmt(chatTotal())}</b>${Number.isFinite(lastBalance) ? ` · баланс ${fmt(lastBalance)}` : ''}`;
}

function settingsHtml() {
    const s = S();
    return `<div class="et-group" id="ecost_settings">
        <h4 class="et-h">💰 Расходы</h4>
        <p class="et-note">Стоимость считается по балансу NanoGPT: всё, что потратил ход (рассказчик, служебная модель, перевод, картинки).</p>
        <label class="et-check"><input type="checkbox" id="ecost_show" ${s.show ? 'checked' : ''}><span>Показывать стоимость под ответами</span></label>
        <label class="et-field">Предупредить, если за день больше, $
            <input id="ecost_limit" class="text_pole" type="number" min="0" step="0.1" value="${s.dailyLimit}">
        </label>
        <div class="et-note">${summaryHtml()}</div>
    </div>`;
}

// ------------------------------------------------------------------ init

export async function init() {
    S();
    const c = ctx();
    const ev = c.eventSource;
    const et = c.eventTypes ?? c.event_types;
    globalThis.ElephantCore = { ...(globalThis.ElephantCore || {}), cost: { readBalance, summaryHtml, chatTotal, fmt } };

    ev.on(et.GENERATION_STARTED, onGenerationStarted);
    document.addEventListener('elephant-reply-ready', (e) => onReplyReady(Number(e.detail?.mesId)));
    for (const e of [et.CHAT_CHANGED, et.MORE_MESSAGES_LOADED]) if (e) ev.on(e, () => setTimeout(renderAll, 50));
    for (const e of [et.CHARACTER_MESSAGE_RENDERED, et.MESSAGE_UPDATED, et.MESSAGE_SWIPED]) if (e) ev.on(e, (id) => setTimeout(() => renderCost(Number(id)), 0));

    document.addEventListener('et-settings-refresh', () => {
        const $body = $('#et-sheet-stage .et-sheet-body .et-settings, #elephant_stage_settings .et-settings').first();
        $body.find('#ecost_settings').remove();
        $body.append(settingsHtml());
    });
    $(document).on('change', '#ecost_show', function () { S().show = this.checked; c.saveSettingsDebounced(); renderAll(); if (!this.checked) $('#chat .et-cost').remove(); });
    $(document).on('change', '#ecost_limit', function () {
        S().dailyLimit = Math.max(0, Number(this.value) || 0);
        c.saveSettingsDebounced();
        const d = dayData(); d.warned = false; saveDay(d); checkLimit(d);
    });
    setTimeout(readBalance, 4000);
}
