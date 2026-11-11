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
import { MOOD_IDS, WEATHER as WEATHER_MAP } from '../stage/scene.js';

const $ = (...a) => globalThis.jQuery(...a);
const MODULE = 'elephant_power';
const PROMPT_KEY = 'elephant_power';
const DEFAULTS = { defaultLevel: 'effects', perChar: {} };

const MOODS = MOOD_IDS;
const WEATHER = Object.keys(WEATHER_MAP);
const TIMES = ['day', 'night', 'dusk', 'dawn'];
const FX = ['hit', 'slash', 'gunshot', 'blood', 'explosion', 'shatter', 'quake', 'shake', 'lightning', 'flashbang', 'fire', 'ice', 'water', 'smoke', 'magic', 'dark', 'holy', 'heal', 'poison', 'kiss', 'heartbeat', 'coins', 'confetti', 'stars'];
/** Screen states: how the whole screen looks for a few seconds (what the player's eyes and head go through). */
const SCREENS = ['dizzy', 'sway', 'tunnel', 'gray', 'negative', 'vhs', 'zoom', 'frost', 'burn', 'underwater', 'wounded', 'dream', 'spotlight'];
const HAPTICS = ['tick', 'hit', 'heartbeat', 'rumble'];
const PARTICLES = ['rain', 'storm', 'snow', 'blizzard', 'sandstorm', 'wind', 'fog', 'smoke', 'embers', 'ash', 'dust', 'petals', 'leaves', 'sparkles', 'motes', 'fireflies', 'lanterns', 'stars', 'bubbles', 'hearts', 'confetti', 'digital', 'bloodrain', 'none'];

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
screen=${SCREENS.join('|')} (one or two, comma-separated: what the reader's own eyes go through — a blow to the head, drink, fear, cold, heat, water, a wound, a dream, a single lit face) · hold=2-10 (seconds the screen state lasts)
title="short title card" (a new chapter, a place, a turning point) · shout="ONE OR TWO WORDS" (a word that slams onto the screen: a scream, an order, a sound) · glitch=1-3 (the screen distorts — for the uncanny, the supernatural, a lie unravelling) · dark=1-5 (seconds of blackout) · haptic=${HAPTICS.join('|')} (the phone itself reacts)
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
    if (out.screen) { const sc = out.screen.split(/[,\s]+/).map(x => x.trim().toLowerCase()).filter(x => SCREENS.includes(x)).slice(0, 2); if (sc.length) cmd.screen = sc; }
    if (cmd.screen) cmd.hold = Math.max(2, Math.min(10, Number(out.hold) || 4));
    if (out.shout) cmd.shout = out.shout.slice(0, 28);
    if (HAPTICS.includes(out.haptic)) cmd.haptic = out.haptic;
    if (cmd.fx && !cmd.fx.length) delete cmd.fx;
    if (out.title) cmd.title = out.title.slice(0, 60);
    if (out.whisper) cmd.whisper = out.whisper.slice(0, 160);
    if (out.glitch) cmd.glitch = Math.max(1, Math.min(3, Number(out.glitch) || 1));
    if (out.dark) cmd.dark = Math.max(1, Math.min(5, Number(out.dark) || 2));
    if (['auto', 'pov', 'scene', 'portrait'].includes(out.image)) cmd.image = out.image;
    return Object.keys(cmd).length ? cmd : null;
}

// ------------------------------------------------------------------ effects

let demoAt = -1;
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
    globalThis.ElephantStage?.sound?.play('title');
}

function glitch(level) {
    const b = document.body;
    b.classList.remove('ep-glitch-1', 'ep-glitch-2', 'ep-glitch-3'); void b.offsetWidth;
    b.classList.add(`ep-glitch-${level}`);
    globalThis.ElephantStage?.sound?.play('glitch');
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
    globalThis.ElephantStage?.sound?.play('whisper');
    el.classList.remove('ep-show'); void el.offsetWidth; el.classList.add('ep-show');
    haptic('heartbeat');
}

/** A word that slams onto the screen. */
function shout(text) {
    const el = layer('ep-shout');
    el.innerHTML = `<span>${escapeHtml(text)}</span>`;
    el.classList.remove('ep-show'); void el.offsetWidth; el.classList.add('ep-show');
    globalThis.ElephantStage?.shake?.('hard');
    globalThis.ElephantStage?.sound?.play('shout');
    haptic('hit');
}

const screenTimers = {};
/** Puts the whole screen into a state for a few seconds. */
function screenState(name, seconds) {
    const b = document.body;
    const cls = `ep-screen-${name}`;
    const el = layer(`ep-ov-${name}`);
    el.className = 'ep-ov';
    clearTimeout(screenTimers[name]);
    b.classList.remove(cls); el.classList.remove('ep-show'); void el.offsetWidth;
    const ms = ['negative', 'zoom'].includes(name) ? 900 : seconds * 1000;
    el.style.setProperty('--ep-hold', `${ms}ms`);
    b.classList.add(cls); el.classList.add('ep-show');
    screenTimers[name] = setTimeout(() => { b.classList.remove(cls); el.classList.remove('ep-show'); }, ms);
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
            for (const f of cmd.fx) if (f === 'shake') { st.shake?.('hard'); st.sound?.play('quake'); }
            st.playEvents(cmd.fx.filter(f => f !== 'shake'));
        }
        if (cmd.screen) for (const sc of cmd.screen) screenState(sc, cmd.hold || 4);
        if (cmd.haptic) haptic(cmd.haptic);
        if (cmd.shout) shout(cmd.shout);
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
    const levels = (cur) => opt('off', 'Нет', cur) + opt('effects', 'Эффекты: настроение, погода, частицы, состояния экрана, титры, шёпот', cur) + opt('full', 'Полная: эффекты + сам рисует кадры', cur);
    return `<div class="et-group" id="ep_settings">
        <h4 class="et-h">⚡ Сила персонажа</h4>
        <p class="et-note">Персонаж может управлять приложением в сильные моменты: менять настроение и погоду, перекрашивать интерфейс, пускать частицы и вспышки (огонь, лёд, выстрел, взмах клинка…), туманить и качать экран, показывать титры и крик во весь экран, глитчить и гасить экран, шептать тебе поверх истории. Стоит ~450 токенов входа на ответ (кэшируется).</p>
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
    globalThis.ElephantCore = { ...(globalThis.ElephantCore || {}), sceneOverride, power: { perform, parseStage, levelFor, FX, SCREENS, PARTICLES } };

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
        const demos = [
            { mood: 'mystery', tint: '#7a5cff', particles: 'sparkles', title: 'Глава II', glitch: 2, whisper: 'Я знаю, что ты читаешь это.' },
            { mood: 'rage', fx: ['slash', 'blood'], shout: 'ХВАТИТ!', screen: ['wounded'], hold: 4 },
            { mood: 'abyss', particles: 'bubbles', screen: ['underwater'], hold: 6, title: 'Глубина' },
            { mood: 'frost', weather: 'blizzard', fx: ['ice'], screen: ['frost'], hold: 6 },
            { mood: 'neon', particles: 'digital', screen: ['vhs'], hold: 5, fx: ['gunshot'] },
            { mood: 'sacred', fx: ['holy', 'heal'], particles: 'motes', screen: ['dream'], hold: 5 },
            { mood: 'triumph', fx: ['confetti', 'coins'], title: 'Победа' },
            { mood: 'nightmare', particles: 'smoke', fx: ['dark'], screen: ['tunnel', 'dizzy'], hold: 6, whisper: 'Не оборачивайся.' },
        ];
        demoAt = (demoAt + 1) % demos.length;
        perform(demos[demoAt], (c.chat?.length ?? 1) - 1, 'effects');
    });
    updatePrompt();
}
