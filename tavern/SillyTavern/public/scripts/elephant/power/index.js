/*
 * Elephant Core — the character's power over the app.
 *
 * With powers on, the narrator learns that it can steer the app itself: one
 * invisible HTML comment in a reply —
 *   <!--stage mood=horror weather=storm fx=lightning tint=#7a0000 title="Глава II" glitch=2 dark=2 whisper="I see you." particles=ash image=pov-->
 * — changes the scene's mood and weather, recolours the whole interface,
 * swaps the particles, shows a title card, glitches or blacks out the screen,
 * lets the character whisper to the reader outside the story, or (full power)
 * illustrates the moment. Comments are invisible in the chat by nature.
 *
 * Levels per character: off · effects · full (effects + illustrations).
 */
import { ctx, currentCharacter, haptic, log, whenRevealed } from '../stage/helper.js';
import { MOOD_IDS } from '../stage/scene.js';

const $ = (...a) => globalThis.jQuery(...a);
const MODULE = 'elephant_power';
const PROMPT_KEY = 'elephant_power';
const DEFAULTS = { defaultLevel: 'effects', perChar: {} };

const MOODS = MOOD_IDS;
const WEATHER = ['clear', 'rain', 'storm', 'snow', 'fog', 'ash'];
const TIMES = ['day', 'night', 'dusk', 'dawn'];
const FX = ['hit', 'blood', 'explosion', 'lightning', 'kiss', 'magic', 'heartbeat', 'shake'];
const PARTICLES = ['rain', 'storm', 'snow', 'fog', 'embers', 'petals', 'sparkles', 'fireflies', 'stars', 'ash', 'dust', 'none'];

function S() {
    const es = ctx().extensionSettings;
    es[MODULE] ??= structuredClone(DEFAULTS);
    for (const [k, v] of Object.entries(DEFAULTS)) if (es[MODULE][k] === undefined) es[MODULE][k] = structuredClone(v);
    return es[MODULE];
}

export function levelFor(key) {
    const s = S();
    return s.perChar[key] ?? s.defaultLevel;
}

// ------------------------------------------------------------------ prompt

function powerPrompt(level, char) {
    return `[${char}'s power over the app]
This story runs inside an app that ${char} can secretly control to make strong moments land harder. At a genuinely strong moment (not every reply — roughly one in five at most), add ONE control comment on its own line anywhere in your reply. It is invisible to the reader; never mention it in the prose.
<!--stage key=value key="text with spaces" …-->
Keys (use only what the moment needs):
mood=${MOODS.join('|')} · weather=${WEATHER.join('|')} · time=${TIMES.join('|')}
fx=${FX.join(',')} (comma-separated, things that physically happen now)
tint=#rrggbb (recolours the whole interface for this scene) · particles=${PARTICLES.join('|')}
title="short title card" (a new chapter, a place, a turning point) · glitch=1-3 (the screen distorts — for the uncanny, the supernatural, a lie unravelling) · dark=1-5 (seconds of blackout)
whisper="one short line ${char} says straight to the reader, outside the story" (breaking the fourth wall — rare, eerie or intimate)${level === 'full' ? '\nimage=auto|pov|scene|portrait (illustrate this exact moment — at most once per scene; auto picks the frame)' : ''}`;
}

function updatePrompt() {
    const c = ctx();
    const ch = currentCharacter();
    const level = ch && !ch.group ? levelFor(ch.key) : 'off';
    c.setExtensionPrompt(PROMPT_KEY, level === 'off' ? '' : powerPrompt(level, c.name2), 0 /* IN_PROMPT */, 0, false, 0 /* SYSTEM */);
}

// ------------------------------------------------------------------ parsing

export function parseStage(text) {
    const m = String(text || '').match(/<!--\s*stage\b([\s\S]*?)-->/i);
    if (!m) return null;
    const out = {};
    const re = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
    let a;
    while ((a = re.exec(m[1]))) out[a[1].toLowerCase()] = (a[2] ?? a[3] ?? a[4] ?? '').trim();
    const cmd = {};
    if (MOODS.includes(out.mood)) cmd.mood = out.mood;
    if (WEATHER.includes(out.weather)) cmd.weather = out.weather;
    if (TIMES.includes(out.time)) cmd.time = out.time;
    if (PARTICLES.includes(out.particles)) cmd.particles = out.particles;
    if (/^#?[0-9a-f]{6}$/i.test(out.tint || '')) cmd.tint = out.tint.startsWith('#') ? out.tint : `#${out.tint}`;
    if (out.fx) cmd.fx = out.fx.split(/[,\s]+/).map(x => x.trim().toLowerCase()).filter(x => FX.includes(x)).slice(0, 3);
    if (out.title) cmd.title = out.title.slice(0, 60);
    if (out.whisper) cmd.whisper = out.whisper.slice(0, 160);
    if (out.glitch) cmd.glitch = Math.max(1, Math.min(3, Number(out.glitch) || 1));
    if (out.dark) cmd.dark = Math.max(1, Math.min(5, Number(out.dark) || 2));
    if (['auto', 'pov', 'scene', 'portrait'].includes(out.image)) cmd.image = out.image;
    return Object.keys(cmd).length ? cmd : null;
}

// ------------------------------------------------------------------ effects

let active = null; // { mesId, cmd } — the scene override for the newest reply

function sceneOverride(next) {
    if (!active || active.mesId !== (ctx().chat?.length ?? 0) - 1) return next;
    const c = active.cmd;
    return {
        ...next,
        ...(c.mood ? { mood: c.mood } : {}),
        ...(c.weather ? { weather: c.weather, indoor: next.indoor && !['rain', 'storm', 'snow'].includes(c.weather) ? next.indoor : false } : {}),
        ...(c.time ? { time: c.time } : {}),
        ...(c.particles ? { particles: c.particles } : {}),
        ...(c.tint ? { tint: c.tint } : {}),
    };
}

function layer(id) {
    let el = document.getElementById(id);
    if (!el) { el = document.createElement('div'); el.id = id; document.body.appendChild(el); }
    return el;
}

function titleCard(text) {
    const el = layer('ep-title');
    el.innerHTML = `<span>${escapeHtml(text)}</span>`;
    el.classList.remove('ep-show'); void el.offsetWidth; el.classList.add('ep-show');
}

function glitch(level) {
    const b = document.body;
    b.classList.remove('ep-glitch-1', 'ep-glitch-2', 'ep-glitch-3'); void b.offsetWidth;
    b.classList.add(`ep-glitch-${level}`);
    setTimeout(() => b.classList.remove(`ep-glitch-${level}`), 900 + level * 500);
    haptic(level >= 2 ? 'rumble' : 'tick');
}

function blackout(seconds) {
    const el = layer('ep-dark');
    el.style.setProperty('--ep-dark-ms', `${seconds * 1000}ms`);
    el.classList.remove('ep-show'); void el.offsetWidth; el.classList.add('ep-show');
}

function whisper(text, who) {
    const el = layer('ep-whisper');
    el.innerHTML = `<small>${escapeHtml(who)}</small><span>${escapeHtml(text)}</span>`;
    el.classList.remove('ep-show'); void el.offsetWidth; el.classList.add('ep-show');
    haptic('heartbeat');
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

/** Runs a parsed command for message mesId. */
export function perform(cmd, mesId, level = 'full') {
    const st = globalThis.ElephantStage;
    const c = ctx();
    active = { mesId, cmd };
    if (st && (cmd.mood || cmd.weather || cmd.time || cmd.particles || cmd.tint)) st.applyScene({ ...st.getScene(), events: [] }, { events: false });
    const delay = cmd.dark ? cmd.dark * 1000 : 0;
    if (cmd.dark) blackout(cmd.dark);
    setTimeout(() => {
        if (cmd.fx?.length && st) {
            for (const f of cmd.fx) if (f === 'shake') st.shake?.('hard');
            st.playEvents(cmd.fx.filter(f => f !== 'shake'));
        }
        if (cmd.glitch) glitch(cmd.glitch);
        if (cmd.title) titleCard(cmd.title);
        if (cmd.whisper) setTimeout(() => whisper(cmd.whisper, c.name2), cmd.title ? 2200 : 300);
        if (cmd.image && level === 'full' && st?.generateFor) st.generateFor(mesId, cmd.image);
    }, delay);
    log('power', cmd);
}

// ------------------------------------------------------------------ settings block

function settingsHtml() {
    const ch = currentCharacter();
    const s = S();
    const opt = (v, label, cur) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${label}</option>`;
    const levels = (cur) => opt('off', 'Нет', cur) + opt('effects', 'Эффекты: настроение, цвет, титры, глитч, шёпот', cur) + opt('full', 'Полная: эффекты + сам рисует кадры', cur);
    return `<div class="et-group" id="ep_settings">
        <h4 class="et-h">⚡ Сила персонажа</h4>
        <p class="et-note">Персонаж может управлять приложением в сильные моменты: менять настроение и погоду, перекрашивать интерфейс, показывать титры, глитчить и гасить экран, шептать тебе поверх истории. Стоит ~250 токенов входа на ответ (кэшируется).</p>
        ${ch && !ch.group ? `<label class="et-field">${escapeHtml(ch.name)}
            <select id="ep_level" class="text_pole">${opt('', `По умолчанию (${{ off: 'нет', effects: 'эффекты', full: 'полная' }[s.defaultLevel]})`, s.perChar[ch.key] ?? '')}${levels(s.perChar[ch.key] ?? '')}</select>
        </label>` : ''}
        <label class="et-field">Для всех по умолчанию
            <select id="ep_default" class="text_pole">${levels(s.defaultLevel)}</select>
        </label>
        <button class="menu_button" id="ep_demo"><i class="fa-solid fa-wand-magic-sparkles"></i> Показать пример</button>
    </div>`;
}

// ------------------------------------------------------------------ init

export async function init() {
    S();
    const c = ctx();
    const ev = c.eventSource;
    const et = c.eventTypes ?? c.event_types;
    globalThis.ElephantCore = { ...(globalThis.ElephantCore || {}), sceneOverride, power: { perform, parseStage, levelFor } };

    ev.on(et.CHAT_CHANGED, () => { active = null; updatePrompt(); });
    ev.on(et.MESSAGE_RECEIVED, (id, type) => {
        if (type === 'impersonate') return;
        const mesId = Number(id);
        const msg = c.chat?.[mesId];
        const ch = currentCharacter();
        if (!msg || msg.is_user || !ch || ch.group) return;
        const level = levelFor(ch.key);
        if (level === 'off') return;
        const cmd = parseStage(msg.mes);
        if (cmd) whenRevealed().then(() => setTimeout(() => perform(cmd, mesId, level), 120));
    });
    for (const e of [et.MESSAGE_SWIPED, et.MESSAGE_DELETED]) if (e) ev.on(e, () => { active = null; });

    document.addEventListener('et-settings-refresh', () => {
        const $body = $('#et-sheet-stage .et-sheet-body .et-settings, #elephant_stage_settings .et-settings').first();
        $body.find('#ep_settings').remove();
        $body.find('.et-group').eq(1).after(settingsHtml());
    });
    $(document).on('change', '#ep_level', function () {
        const ch = currentCharacter();
        if (!ch) return;
        if (this.value) S().perChar[ch.key] = this.value; else delete S().perChar[ch.key];
        c.saveSettingsDebounced();
        updatePrompt();
    });
    $(document).on('change', '#ep_default', function () { S().defaultLevel = this.value; c.saveSettingsDebounced(); updatePrompt(); });
    $(document).on('click', '#ep_demo', () => {
        globalThis.ElephantStage?.closeSheets?.();
        perform({ mood: 'mystery', tint: '#7a5cff', particles: 'sparkles', title: 'Глава II', glitch: 2, whisper: 'Я знаю, что ты читаешь это.' }, (c.chat?.length ?? 1) - 1, 'effects');
    });
    updatePrompt();
}
