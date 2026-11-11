/*
 * Elephant Core — Director: the character plots, the narrator writes.
 *
 * Before each reply a cheap helper-model call decides what {{char}} does on
 * their own initiative (goal, scheme, move, which ability to use). The plan is
 * injected as a private "intent" block at depth 0; the main model turns it into
 * prose. The character's toolbox (abilities + agenda) comes from the card
 * (data.extensions.elephant, written by the character forge), from the user's
 * own edit, or is generated once by the helper model and cached.
 *
 * Swipes and regenerations re-plan from the same starting point (the meta
 * snapshot is stored on the user's message), "continue" reuses the plan.
 */
import { ctx, callHelper, hasHelper, memoryState, currentCharacter, recentMessages, log, toast, personaText } from '../stage/helper.js';
import {
    MODES, DIRECTOR_SYSTEM, ARSENAL_SYSTEM, parsePlan, parseArsenal, emptyMeta,
    buildDirectorInput, applyPlan, intentBlock,
} from './logic.js';

const $ = (...a) => globalThis.jQuery(...a);
const MODULE = 'elephant_director';
const META_KEY = 'elephant_director';
const PROMPT_KEY = 'elephant_director';
const DEFAULTS = { enabled: false, mode: 'lively', arsenal: {} };
const TIMEOUT_MS = 30_000;

function S() {
    const es = ctx().extensionSettings;
    es[MODULE] ??= structuredClone(DEFAULTS);
    for (const [k, v] of Object.entries(DEFAULTS)) if (es[MODULE][k] === undefined) es[MODULE][k] = structuredClone(v);
    return es[MODULE];
}

/** Helper settings live in «Сцена и арт» (elephant_stage). */
const helperSettings = () => ctx().extensionSettings?.elephant_stage ?? {};

function meta() {
    const md = ctx().chatMetadata;
    if (!md) return null;
    md[META_KEY] ??= emptyMeta();
    return md[META_KEY];
}

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

function setIntent(text) {
    ctx().setExtensionPrompt(PROMPT_KEY, text || '', 1 /* IN_CHAT */, 0, false, 0 /* SYSTEM */);
}

function rawCharacter() {
    const c = ctx();
    return c.groupId ? null : c.characters?.[c.characterId] ?? null;
}

function withTimeout(promise, ms) {
    return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('director timeout')), ms))]);
}

// ------------------------------------------------------------------ toolbox

/** The character's toolbox: user's edit > card (forge) > cached auto. */
export function arsenalFor(ch = currentCharacter()) {
    if (!ch || ch.group) return null;
    const own = S().arsenal[ch.key];
    if (own?.edited) return own;
    const fromCard = rawCharacter()?.data?.extensions?.elephant;
    if (fromCard?.arsenal) return { abilities: String(fromCard.arsenal), agenda: String(fromCard.agenda || ''), source: 'card' };
    return own || null;
}

let arsenalBusy = null;
export async function ensureArsenal({ force = false } = {}) {
    const ch = currentCharacter();
    if (!ch || ch.group) return null;
    if (!force) {
        const have = arsenalFor(ch);
        if (have) return have;
    }
    if (arsenalBusy) return arsenalBusy;
    arsenalBusy = (async () => {
        const card = [`Name: ${ch.name}`, ch.description, ch.personality, ch.scenario].filter(Boolean).join('\n\n').slice(0, 6000);
        const out = await withTimeout(callHelper(helperSettings(), ARSENAL_SYSTEM, card, 700, { json: true }), TIMEOUT_MS);
        const parsed = parseArsenal(out);
        if (!parsed) throw new Error('arsenal: bad answer');
        S().arsenal[ch.key] = { ...parsed, source: 'auto' };
        ctx().saveSettingsDebounced();
        return S().arsenal[ch.key];
    })().finally(() => { arsenalBusy = null; });
    return arsenalBusy;
}

// ------------------------------------------------------------------ planning

function lastUserIndex(chat) {
    for (let i = chat.length - 1; i >= 0; i--) if (chat[i].is_user && !chat[i].is_system) return i;
    return -1;
}

function active() {
    const s = S();
    const ch = currentCharacter();
    const m = meta();
    return s.enabled && ch && !ch.group && m && !m.off && hasHelper(helperSettings());
}

async function plan(ui) {
    const c = ctx();
    const ch = currentCharacter();
    const m = meta();
    const toolbox = await ensureArsenal().catch((e) => { log('arsenal failed', e); return null; });
    const input = buildDirectorInput({
        name: ch.name,
        userName: c.name1,
        card: [ch.description, ch.personality, ch.scenario, personaText() && `Who ${c.name1} (the player) really is — true even if ${ch.name} doesn't know it yet: ${personaText().slice(0, 900)}`].filter(Boolean).join('\n\n'),
        arsenal: toolbox?.abilities || '',
        agenda: toolbox?.agenda || '',
        memory: memoryState(),
        scene: recentMessages(6, ui),
        meta: m,
        mode: S().mode,
        turn: ui,
    });
    const system = DIRECTOR_SYSTEM.replaceAll('{{char}}', ch.name);
    const out = await withTimeout(callHelper(helperSettings(), system, input, 500, { json: true }), TIMEOUT_MS);
    return parsePlan(out);
}

/** Runs from ElephantCore.beforeGenerate, between memory and the game engine. */
export async function beforeGenerate(_chat, _contextSize, _abort, type) {
    try {
        if (!active() || ['quiet', 'impersonate'].includes(type)) { setIntent(''); return; }
        const c = ctx();
        const chat = c.chat;
        const ui = lastUserIndex(chat);
        if (ui < 0) { setIntent(''); return; }
        const userMsg = chat[ui];
        userMsg.extra ??= {};
        const rec = userMsg.extra.elephant_director;
        const name = c.name2;

        if (type === 'continue') {
            setIntent(rec?.plan ? intentBlock(rec.plan, name, c.name1) : '');
            return;
        }
        // Only plan for the reply right after the player's message.
        if (ui !== chat.length - 1 && !['swipe', 'regenerate'].includes(type)) { setIntent(''); return; }

        const m = meta();
        // A swipe re-plans from the state before this turn's plan.
        if (rec?.before) Object.assign(m, structuredClone(rec.before));
        const before = structuredClone(m);
        const p = await plan(ui);
        if (!p) { setIntent(''); return; }
        applyPlan(m, p, ui);
        userMsg.extra.elephant_director = { plan: p, before };
        setIntent(intentBlock(p, name, c.name1));
        c.saveMetadataDebounced?.();
        refreshSettings();
        log('director', p);
    } catch (e) {
        log('director failed', e);
        setIntent('');
    }
}

// ------------------------------------------------------------------ settings block

function lastPlan() {
    const chat = ctx().chat ?? [];
    const ui = lastUserIndex(chat);
    return ui >= 0 ? chat[ui].extra?.elephant_director?.plan : null;
}

function arsenalText(a) {
    if (!a) return '';
    return [a.abilities, a.agenda ? `Цели:\n${a.agenda}` : ''].filter(Boolean).join('\n\n');
}

function settingsHtml() {
    const s = S();
    const ch = currentCharacter();
    const m = ctx().chatMetadata ? meta() : null;
    const single = ch && !ch.group;
    const a = single ? arsenalFor(ch) : null;
    const p = lastPlan();
    const opt = (v, label) => `<option value="${v}" ${s.mode === v ? 'selected' : ''}>${label}</option>`;
    const src = { card: 'из карточки', auto: 'составлено автоматически' }[a?.source] ?? (a?.edited ? 'твоя правка' : '');
    return `<div class="et-group" id="ed_settings">
        <h4 class="et-h">🎬 Режиссёр</h4>
        <p class="et-note">Перед каждым ответом служебная модель решает, что персонаж сделает сам: цель, хитрость, применение способностей. Основная модель только пишет текст. +1 дешёвый вызов и несколько секунд на ответ. GLM 5.3 с нашим пресетом и так ведёт сюжет сам, поэтому режиссёр выключен по умолчанию: включи, если персонаж стал пассивным или модель слабее.</p>
        <label class="checkbox_label"><input type="checkbox" id="ed_enabled" ${s.enabled ? 'checked' : ''}> Включён</label>
        ${single && m ? `<label class="checkbox_label"><input type="checkbox" id="ed_chat_off" ${m.off ? 'checked' : ''}> Выключить в этом чате</label>` : ''}
        <label class="et-field">Инициатива
            <select id="ed_mode" class="text_pole">${Object.entries(MODES).map(([k, v]) => opt(k, `${v.label} — ${v.hint}`)).join('')}</select>
        </label>
        ${single ? `<label class="et-field">Способности и цели: ${escapeHtml(ch.name)}${src ? ` <small>(${src})</small>` : ''}
            <textarea id="ed_arsenal" class="text_pole" rows="7" placeholder="- Превращение: принимает облик любого существа; для обмана и проверки доверия&#10;&#10;Цели:&#10;- …">${escapeHtml(arsenalText(a))}</textarea>
        </label>
        <button class="menu_button" id="ed_regen"><i class="fa-solid fa-rotate"></i> Составить заново</button>` : '<p class="et-note">В групповых чатах режиссёр пока не работает.</p>'}
        ${p ? `<div class="et-note ed-last"><b>Последний ход:</b> ${escapeHtml(p.move)}${p.ace ? `<br><b>Способность:</b> ${escapeHtml(p.ace)}` : ''}${m?.scheme ? `<br><b>Замысел:</b> ${escapeHtml(m.scheme)}` : ''}</div>` : ''}
    </div>`;
}

function refreshSettings() {
    const $body = $('#et-sheet-stage .et-sheet-body .et-settings, #elephant_stage_settings .et-settings').first();
    if (!$body.length) return;
    const focused = document.activeElement?.id === 'ed_arsenal';
    if (focused) return; // don't wipe what the user is typing
    $body.find('#ed_settings').remove();
    const $power = $body.find('#ep_settings');
    if ($power.length) $power.after(settingsHtml());
    else $body.find('.et-group').eq(1).after(settingsHtml());
}

function parseArsenalEdit(text) {
    const [abilities, agenda = ''] = String(text).split(/\n\s*Цели:\s*\n?/i);
    return { abilities: abilities.trim(), agenda: agenda.trim(), edited: true, source: 'edit' };
}

// ------------------------------------------------------------------ init

export async function init() {
    S();
    const c = ctx();
    const ev = c.eventSource;
    const et = c.eventTypes ?? c.event_types;
    globalThis.ElephantCore = { ...(globalThis.ElephantCore || {}), director: { ensureArsenal, arsenalFor, beforeGenerate } };

    ev.on(et.CHAT_CHANGED, () => {
        setIntent('');
        // Prepare the toolbox while the user reads, so the first reply isn't slower.
        if (active()) setTimeout(() => ensureArsenal().catch(() => {}), 1500);
    });
    document.addEventListener('et-settings-refresh', () => setTimeout(refreshSettings, 0));

    $(document).on('change', '#ed_enabled', function () { S().enabled = this.checked; c.saveSettingsDebounced(); if (!this.checked) setIntent(''); });
    $(document).on('change', '#ed_chat_off', function () { const m = meta(); if (m) { m.off = this.checked; c.saveMetadataDebounced?.(); } });
    $(document).on('change', '#ed_mode', function () { S().mode = this.value; c.saveSettingsDebounced(); });
    $(document).on('change', '#ed_arsenal', function () {
        const ch = currentCharacter();
        if (!ch || ch.group) return;
        const text = this.value.trim();
        if (text) S().arsenal[ch.key] = parseArsenalEdit(text);
        else delete S().arsenal[ch.key];
        c.saveSettingsDebounced();
    });
    $(document).on('click', '#ed_regen', async function () {
        const ch = currentCharacter();
        if (!ch || ch.group) return;
        if (!hasHelper(helperSettings())) return toast().warning('Нужна служебная модель (выше в «Сцена и арт»)');
        this.disabled = true;
        const label = this.innerHTML;
        this.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Составляю…';
        try {
            delete S().arsenal[ch.key];
            const a = await ensureArsenal({ force: true });
            a.edited = true; // asked for explicitly: wins over the card's own list
            c.saveSettingsDebounced();
            $('#ed_arsenal').val(arsenalText(a));
        } catch (e) {
            toast().error(String(e.message || e));
        } finally {
            this.disabled = false;
            this.innerHTML = label;
        }
    });
}
