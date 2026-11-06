/*
 * Elephant Stage — the mobile face of Elephant Tavern.
 *
 *  • a mobile shell over SillyTavern: compact header, hub of sections, sheets,
 *    Android back-button handling;
 *  • a living stage: the scene (mood, weather, time, place) is read from the
 *    story and drives colours, backdrop, particles, screen shake and haptics;
 *  • automatic illustrations through NanoGPT: character portraits and POV
 *    shots from {{user}}'s eyes, attached to the messages.
 *
 * Only SillyTavern.getContext() and a couple of stable utils are used.
 */
import { MODULE, ctx, toast, log, listProfiles, helperProfileId, hasHelper, callHelper, loadHelperModels, memoryState, currentCharacter, haptic, inApp } from './helper.js';
import { Effects, AMBIENT_PRESETS } from './effects.js';
import { MOODS, heuristicScene, scenePrompt, parseSceneJson, ambientFor, describeScene } from './scene.js';
import { SIZES, loadModels, visualDna, buildPrompt, generateImage, attachToMessage } from './imagegen.js';

const $ = (...a) => globalThis.jQuery(...a);

const DEFAULTS = {
    shell: true,
    effects: true,
    intensity: 1,
    haptics: true,
    shake: true,
    sceneLLM: true,
    lockMood: '',
    helperModel: '',
    helperProfile: '',
    allowMainModel: false,
    keepAwake: false,
    backdrop: true,
    backdropDim: 0.55,
    images: {
        enabled: false,
        model: 'anima/text-to-image',
        auto: 'scene',      // off | scene | every
        every: 8,
        mode: 'alternate',  // pov | portrait | alternate
        size: 'auto',
        stylePrefix: 'masterpiece, best quality',
        negative: 'worst quality, low quality, score_1, score_2, score_3, artist name, blurry, jpeg artifacts, bad anatomy, bad hands, extra digits, watermark',
        steps: '',
        scale: '',
    },
    dna: {},
};

// ------------------------------------------------------------------ settings

export function S() {
    const es = ctx().extensionSettings;
    es[MODULE] ??= structuredClone(DEFAULTS);
    const s = es[MODULE];
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (s[k] === undefined) s[k] = structuredClone(v);
        else if (v && typeof v === 'object' && !Array.isArray(v)) {
            for (const [k2, v2] of Object.entries(v)) if (s[k][k2] === undefined) s[k][k2] = structuredClone(v2);
        }
    }
    // 0.5: Anima is the default image model — move untouched old defaults over.
    if (!s.images.animaMigrated) {
        if (!s.images.model) s.images.model = 'anima/text-to-image';
        if (s.images.stylePrefix === 'masterpiece, best quality, cinematic lighting, highly detailed') s.images.stylePrefix = DEFAULTS.images.stylePrefix;
        if (s.images.negative === 'lowres, bad anatomy, bad hands, extra fingers, text, watermark, signature, blurry') s.images.negative = DEFAULTS.images.negative;
        s.images.animaMigrated = true;
    }
    return s;
}

const save = () => ctx().saveSettingsDebounced();

function getPath(obj, path) { return path.split('.').reduce((o, k) => o?.[k], obj); }
function setPath(obj, path, value) {
    const keys = path.split('.');
    const last = keys.pop();
    const target = keys.reduce((o, k) => (o[k] ??= {}), obj);
    target[last] = value;
}

/** Per-chat stage memory. */
function chatData() {
    const meta = ctx().chatMetadata;
    if (!meta) return null;
    meta[MODULE] ??= { scene: null, lastImageAt: -1, imageCount: 0, sceneImage: '' };
    return meta[MODULE];
}

// ------------------------------------------------------------------ state

const effects = new Effects();
let scene = heuristicScene('');
let shellOn = false;
let imageBusy = null;
const playedEvents = new Map(); // mesId -> Set(events) already shown during streaming
let streamCursor = 0;
let lastStreamCheck = 0;

const mobileQuery = globalThis.matchMedia('(max-width: 1000px)');
const shouldShell = () => S().shell && (inApp() || mobileQuery.matches);

// ------------------------------------------------------------------ DOM: shell

function buildShell() {
    if (document.getElementById('et-header')) return;

    const backdrop = $(`
        <div id="et-backdrop" aria-hidden="true">
            <div class="et-bd-gradient"></div>
            <img class="et-bd-img et-bd-a" alt="">
            <img class="et-bd-img et-bd-b" alt="">
            <div class="et-bd-vignette"></div>
            <div class="et-bd-flash"></div>
        </div>`);
    $('body').prepend(backdrop);
    effects.mount(backdrop[0]);

    const header = $(`
        <header id="et-header">
            <button class="et-hb" data-et-act="hub" aria-label="Меню"><i class="fa-solid fa-grip"></i></button>
            <div class="et-who" data-et-act="char">
                <div class="et-ava-wrap"><img class="et-ava" alt=""><span class="et-ava-ring"></span></div>
                <div class="et-who-text">
                    <div class="et-name">Elephant Tavern</div>
                    <div class="et-sub"><span class="et-mood" data-et-act="scene"></span><span class="et-scene"></span></div>
                </div>
            </div>
            <button class="et-hb et-hb-cam" data-et-act="image" aria-label="Картинка сцены"><i class="fa-solid fa-camera-retro"></i></button>
            <button class="et-hb" data-et-act="chars" aria-label="Персонажи"><i class="fa-solid fa-address-book"></i></button>
        </header>`);
    $('body').append(header);

    $('body').append('<div id="et-scrim"></div>');
    $('body').append(buildHub());
    $('body').append(buildSceneSheet());
    $('body').append('<section class="et-sheet" id="et-sheet-stage"><div class="et-grip"></div><div class="et-sheet-body"></div></section>');
    $('body').append(buildAppSheet());

    $(document).on('click', '[data-et-act]', onAction);
    $('#et-scrim').on('click', closeSheets);
    enableSheetSwipe();
}

const SECTIONS = [
    { id: 'chars', icon: 'fa-address-book', label: 'Персонажи', drawer: '#rightNavHolder', then: '#rm_button_characters' },
    { id: 'api', icon: 'fa-plug', label: 'Подключение', drawer: '#sys-settings-button' },
    { id: 'preset', icon: 'fa-sliders', label: 'Пресет ИИ', drawer: '#ai-config-button' },
    { id: 'format', icon: 'fa-font', label: 'Формат', drawer: '#advanced-formatting-button' },
    { id: 'lore', icon: 'fa-book-atlas', label: 'Лорбуки', drawer: '#WI-SP-button' },
    { id: 'persona', icon: 'fa-face-smile', label: 'Персона', drawer: '#persona-management-button' },
    { id: 'memory', icon: 'fa-brain', label: 'Память', action: () => openMemory() },
    { id: 'stage', icon: 'fa-wand-magic-sparkles', label: 'Сцена и арт', action: () => openStageSettings() },
    { id: 'bg', icon: 'fa-panorama', label: 'Фоны', drawer: '#backgrounds-button' },
    { id: 'ext', icon: 'fa-cubes', label: 'Расширения', drawer: '#extensions-settings-button' },
    { id: 'ui', icon: 'fa-palette', label: 'Интерфейс', drawer: '#user-settings-button' },
    { id: 'app', icon: 'fa-mobile-screen-button', label: 'Приложение', action: () => openSheet('app'), appOnly: true },
];

function buildHub() {
    const tiles = SECTIONS.filter(s => !s.appOnly || inApp()).map(s => `
        <button class="et-tile" data-et-act="section" data-et-section="${s.id}">
            <i class="fa-solid ${s.icon}"></i><span>${s.label}</span>
        </button>`).join('');
    return `
        <section class="et-sheet" id="et-sheet-hub">
            <div class="et-grip"></div>
            <div class="et-sheet-body">
                <div class="et-hub-quick">
                    <button class="et-pill" data-et-act="newchat"><i class="fa-solid fa-plus"></i> Новый чат</button>
                    <button class="et-pill" data-et-act="chatlist"><i class="fa-solid fa-clock-rotate-left"></i> Чаты</button>
                    <button class="et-pill" data-et-act="options"><i class="fa-solid fa-ellipsis"></i> Ещё</button>
                </div>
                <div class="et-tiles">${tiles}</div>
            </div>
        </section>`;
}

function buildSceneSheet() {
    const moods = Object.entries(MOODS).map(([id, m]) =>
        `<button class="et-mood-btn" data-et-act="lockmood" data-mood="${id}" style="--m:${m.accent}">${m.icon}<span>${m.label}</span></button>`).join('');
    return `
        <section class="et-sheet" id="et-sheet-scene">
            <div class="et-grip"></div>
            <div class="et-sheet-body">
                <div class="et-scene-card">
                    <div class="et-scene-big"></div>
                    <div class="et-scene-meta"></div>
                </div>
                <div class="et-row">
                    <button class="et-btn" data-et-act="gen" data-mode="pov"><i class="fa-solid fa-eye"></i> POV-кадр</button>
                    <button class="et-btn" data-et-act="gen" data-mode="portrait"><i class="fa-solid fa-image-portrait"></i> Портрет</button>
                </div>
                <div class="et-row">
                    <button class="et-btn et-btn-ghost" data-et-act="rescene"><i class="fa-solid fa-rotate"></i> Перечитать сцену</button>
                </div>
                <h4 class="et-h">Настроение <small>— нажмите, чтобы закрепить</small></h4>
                <div class="et-moods">
                    <button class="et-mood-btn" data-et-act="lockmood" data-mood="" style="--m:#ffffff">🎭<span>Авто</span></button>
                    ${moods}
                </div>
            </div>
        </section>`;
}

function buildAppSheet() {
    if (!inApp()) return '';
    return `
        <section class="et-sheet" id="et-sheet-app">
            <div class="et-grip"></div>
            <div class="et-sheet-body">
                <h3 class="et-title">🐘 Elephant Tavern</h3>
                <div class="et-app-info"></div>
                <div class="et-list">
                    <button class="et-li" data-et-act="backup"><i class="fa-solid fa-box-archive"></i><span>Сохранить бэкап<small>Персонажи, чаты, настройки и ключи — одним zip</small></span></button>
                    <button class="et-li" data-et-act="restore"><i class="fa-solid fa-upload"></i><span>Восстановить из бэкапа<small>Подходит и zip папки data от SillyTavern с ПК</small></span></button>
                    <label class="et-li et-li-toggle"><i class="fa-solid fa-sun"></i><span>Не гасить экран<small>Пока приложение открыто</small></span><input type="checkbox" data-et-key="keepAwake"></label>
                    <button class="et-li" data-et-act="restart"><i class="fa-solid fa-power-off"></i><span>Перезапустить сервер</span></button>
                    <button class="et-li" data-et-act="log"><i class="fa-solid fa-terminal"></i><span>Лог сервера</span></button>
                </div>
                <pre class="et-log" hidden></pre>
            </div>
        </section>`;
}

// ------------------------------------------------------------------ sheets & drawers

function openSheet(name) {
    closeSheets(true);
    const el = document.getElementById(`et-sheet-${name}`);
    if (!el) return;
    if (name === 'scene') renderSceneSheet();
    if (name === 'app') renderAppSheet();
    if (name === 'hub') markHub();
    el.classList.add('et-open');
    document.body.classList.add('et-sheet-open');
    haptic('tick');
}

function closeSheets(silent) {
    const open = document.querySelectorAll('.et-sheet.et-open');
    open.forEach(el => el.classList.remove('et-open'));
    document.body.classList.remove('et-sheet-open');
    return open.length > 0 && !silent;
}

function enableSheetSwipe() {
    let startY = 0;
    let sheet = null;
    document.addEventListener('touchstart', (e) => {
        const grip = e.target.closest?.('.et-sheet .et-grip, .et-sheet-body');
        const s = e.target.closest?.('.et-sheet.et-open');
        if (!grip || !s) return;
        const body = s.querySelector('.et-sheet-body');
        if (!e.target.closest('.et-grip') && body.scrollTop > 0) return;
        sheet = s;
        startY = e.touches[0].clientY;
    }, { passive: true });
    document.addEventListener('touchmove', (e) => {
        if (!sheet) return;
        const dy = e.touches[0].clientY - startY;
        if (dy > 0) sheet.style.transform = `translateY(calc(-100% + ${dy}px))`;
    }, { passive: true });
    document.addEventListener('touchend', (e) => {
        if (!sheet) return;
        const dy = e.changedTouches[0].clientY - startY;
        sheet.style.transform = '';
        if (dy > 90) closeSheets();
        sheet = null;
    });
}

function openDrawer(selector, then) {
    const $d = $(selector);
    if (!$d.length) return;
    const $content = $d.find('.drawer-content').first();
    if (!$content.hasClass('openDrawer')) $d.find('.drawer-toggle').first().trigger('click');
    if (then) setTimeout(() => $(then).trigger('click'), 60);
}

function openMemory() {
    openDrawer('#extensions-settings-button');
    setTimeout(() => {
        const $em = $('#elephant_memory_settings');
        if (!$em.length) return toast().info('Elephant Memory не загружено');
        const $content = $em.find('.inline-drawer-content').first();
        if (!$content.is(':visible')) $em.find('.inline-drawer-toggle').first().trigger('click');
        // scrollIntoView would also scroll the fixed page itself; scroll the drawer only.
        const scroller = $em.closest('.drawer-content')[0];
        if (scroller) scroller.scrollTo({ top: $em[0].getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 8, behavior: 'smooth' });
    }, 250);
}

/** Android back button: close the top-most thing, return false to leave the app. */
function handleBack() {
    if (closeSheets()) return true;

    const dialog = document.querySelector('dialog.popup[open], dialog[open]');
    if (dialog) {
        const cancel = dialog.querySelector('.popup-button-cancel, .popup-button-close, [data-result="0"]');
        if (cancel) cancel.click();
        else dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return true;
    }
    const zoomed = $('.zoomed_avatar:visible');
    if (zoomed.length) { zoomed.find('.dragClose').trigger('click'); zoomed.remove(); return true; }
    if ($('#options').is(':visible')) { $('#options').hide(); return true; }
    if ($('#extensionsMenu').is(':visible')) { $('#extensionsMenu').fadeOut(150); return true; }

    const editing = $('#chat .mes_edit_cancel:visible').first();
    if (editing.length) { editing.trigger('click'); return true; }

    const open = $('.drawer-content.openDrawer').filter(':visible');
    if (open.length) {
        open.last().closest('.drawer').find('.drawer-toggle').first().trigger('click');
        return true;
    }
    if ($('#character_popup').is(':visible')) { $('#character_cross').trigger('click'); return true; }
    return false;
}

function markHub() {
    const offline = $('#send_form').hasClass('no-connection');
    $('.et-tile[data-et-section="api"]').toggleClass('et-attn', offline);
}

// ------------------------------------------------------------------ actions

async function onAction(e) {
    const el = e.currentTarget;
    const act = el.dataset.etAct;
    switch (act) {
        case 'hub': return document.getElementById('et-sheet-hub').classList.contains('et-open') ? closeSheets() : openSheet('hub');
        case 'scene': e.stopPropagation(); return openSheet('scene');
        case 'char':
            if (e.target.closest('.et-mood')) return;
            if (!ctx().characterId && !ctx().groupId) return openDrawer('#rightNavHolder', '#rm_button_characters');
            return openDrawer('#rightNavHolder', '#rm_button_selected_ch');
        case 'chars': return openDrawer('#rightNavHolder', '#rm_button_characters');
        case 'image': return quickImage();
        case 'section': {
            const sec = SECTIONS.find(s => s.id === el.dataset.etSection);
            closeSheets(true);
            if (sec?.action) return sec.action();
            if (sec?.drawer) return openDrawer(sec.drawer, sec.then);
            return;
        }
        case 'newchat': closeSheets(true); return $('#option_start_new_chat').trigger('click');
        case 'chatlist': closeSheets(true); return $('#option_select_chat').trigger('click');
        case 'options': closeSheets(true); return $('#options_button').trigger('click');
        case 'lockmood':
            S().lockMood = el.dataset.mood || '';
            save();
            applyScene(scene, { events: false });
            renderSceneSheet();
            return;
        case 'rescene': closeSheets(); return readScene(lastCharMessageId(), { force: true });
        case 'gen': closeSheets(); return generateFor(lastCharMessageId(), el.dataset.mode);
        case 'backup': return globalThis.ElephantApp?.exportBackup();
        case 'restore': {
            const ok = await ctx().Popup.show.confirm('Восстановить из бэкапа?', 'Текущие данные будут заменены содержимым архива. Сервер перезапустится.');
            if (ok) globalThis.ElephantApp?.importBackup();
            return;
        }
        case 'restart': return globalThis.ElephantApp?.restartServer();
        case 'log': {
            const pre = document.querySelector('#et-sheet-app .et-log');
            pre.hidden = !pre.hidden;
            if (!pre.hidden) { pre.textContent = globalThis.ElephantApp?.serverLog() || ''; pre.scrollTop = pre.scrollHeight; }
            return;
        }
        default:
    }
}

// ------------------------------------------------------------------ header

function updateHeader() {
    if (!shellOn) return;
    const ch = currentCharacter();
    const $h = $('#et-header');
    $h.find('.et-name').text(ch?.name || 'Elephant Tavern');
    const $ava = $h.find('.et-ava');
    if (ch?.avatarUrl) $ava.attr('src', ch.avatarUrl).show();
    else $ava.removeAttr('src').hide();
    $h.toggleClass('et-no-char', !ch);
    const moodId = S().lockMood || scene.mood;
    const m = MOODS[moodId] || MOODS.calm;
    $h.find('.et-mood').text(`${m.icon} ${m.label}${S().lockMood ? ' 🔒' : ''}`).toggle(Boolean(ch));
    $h.find('.et-scene').text(ch ? describeScene(scene) : '');
    $h.find('.et-hb-cam').toggleClass('et-busy', Boolean(imageBusy)).toggle(Boolean(ch));
}

function renderSceneSheet() {
    const moodId = S().lockMood || scene.mood;
    const m = MOODS[moodId] || MOODS.calm;
    $('#et-sheet-scene .et-scene-big').html(`<span>${m.icon}</span> ${m.label}`);
    const meta = [describeScene(scene) || 'место не определено', scene.source === 'llm' ? 'прочитано моделью' : 'по ключевым словам'];
    $('#et-sheet-scene .et-scene-meta').text(meta.join(' · '));
    $('#et-sheet-scene .et-mood-btn').each(function () {
        $(this).toggleClass('et-on', (this.dataset.mood || '') === (S().lockMood || ''));
    });
}

function renderAppSheet() {
    try {
        const info = JSON.parse(globalThis.ElephantApp.info());
        $('#et-sheet-app .et-app-info').html(
            `Приложение ${info.app} · SillyTavern ${info.sillyTavern} · Elephant Memory ${info.elephantMemory}<br>Android ${info.android} · сервер 127.0.0.1:${info.port}`);
    } catch { /* not in app */ }
    $('#et-sheet-app [data-et-key="keepAwake"]').prop('checked', S().keepAwake);
}

// ------------------------------------------------------------------ scene → visuals

function setVars(m) {
    const r = document.documentElement.style;
    r.setProperty('--et-accent', m.accent);
    r.setProperty('--et-accent-2', m.accent2);
    r.setProperty('--et-bg-a', m.bgA);
    r.setProperty('--et-bg-b', m.bgB);
    r.setProperty('--et-glow', String(m.glow));
}

let lastMood = null;

function applyScene(next, { events = true } = {}) {
    // A character with powers may have set this moment's scene itself (see elephant/power).
    const override = globalThis.ElephantCore?.sceneOverride;
    if (typeof override === 'function') next = override(next) || next;
    scene = next;
    const s = S();
    const moodId = s.lockMood || scene.mood;
    const m = MOODS[moodId] || MOODS.calm;
    setVars(m);
    if (scene.tint && /^#[0-9a-f]{3,8}$/i.test(scene.tint)) {
        document.documentElement.style.setProperty('--et-accent', scene.tint);
        document.documentElement.style.setProperty('--et-accent-2', scene.tint);
    }
    document.body.dataset.etMood = moodId;
    document.body.dataset.etTime = scene.time;
    document.body.dataset.etWeather = scene.weather;
    try { globalThis.ElephantApp?.setBarColor(m.bgA); } catch { /* */ }

    if (s.effects) {
        const layers = scene.particles ? (scene.particles === 'none' ? [] : [scene.particles]) : ambientFor({ ...scene, mood: moodId });
        effects.setAmbient(layers, s.intensity * (0.6 + (scene.intensity ?? 0.5) * 0.6));
    }
    if (moodId !== lastMood) {
        if (lastMood && s.haptics && m.haptic) haptic(m.haptic);
        lastMood = moodId;
    }
    if (events) playEvents(scene.events || []);
    updateHeader();
}

function flash(color, ms = 260) {
    const el = document.querySelector('#et-backdrop .et-bd-flash');
    if (!el) return;
    el.style.background = color;
    el.classList.remove('et-go');
    void el.offsetWidth;
    el.style.setProperty('--et-flash-ms', `${ms}ms`);
    el.classList.add('et-go');
}

function shake(strength = 'normal') {
    if (!S().shake) return;
    const el = document.getElementById('sheld');
    if (!el) return;
    el.classList.remove('et-shake', 'et-shake-hard');
    void el.offsetWidth;
    el.classList.add(strength === 'hard' ? 'et-shake-hard' : 'et-shake');
}

function playEvents(list, mesId = null) {
    const s = S();
    if (!s.effects || !list.length) return;
    const played = mesId !== null ? (playedEvents.get(mesId) ?? new Set()) : new Set();
    for (const ev of list) {
        if (played.has(ev)) continue;
        played.add(ev);
        switch (ev) {
            case 'hit': shake(); flash('rgba(255,40,40,.28)'); effects.burst('sparks'); if (s.haptics) haptic('hit'); break;
            case 'blood': effects.burst('blood'); flash('rgba(140,0,0,.25)', 400); break;
            case 'explosion': shake('hard'); flash('rgba(255,240,210,.7)', 500); effects.burst('sparks'); if (s.haptics) haptic('rumble'); break;
            case 'lightning': flash('rgba(220,230,255,.75)', 180); setTimeout(() => flash('rgba(220,230,255,.5)', 140), 260); if (s.haptics) haptic('rumble'); break;
            case 'kiss': effects.burst('hearts'); if (s.haptics) haptic('heartbeat'); break;
            case 'magic': effects.burst('magic'); flash('rgba(170,130,255,.22)', 500); break;
            case 'heartbeat':
                document.body.classList.remove('et-pulse'); void document.body.offsetWidth; document.body.classList.add('et-pulse');
                if (s.haptics) haptic('heartbeat');
                break;
            default:
        }
    }
    if (mesId !== null) playedEvents.set(mesId, played);
}

function setBackdrop(url) {
    const s = S();
    const bd = document.getElementById('et-backdrop');
    if (!bd) return;
    const a = bd.querySelector('.et-bd-a');
    const b = bd.querySelector('.et-bd-b');
    const front = a.classList.contains('et-show') ? a : b;
    const back = front === a ? b : a;
    if (!url || !s.backdrop) {
        a.classList.remove('et-show'); b.classList.remove('et-show');
        bd.classList.remove('et-has-img');
        return;
    }
    back.onload = () => {
        back.classList.add('et-show');
        front.classList.remove('et-show');
        bd.classList.add('et-has-img');
    };
    back.src = url;
    document.documentElement.style.setProperty('--et-bd-dim', String(s.backdropDim));
}

// ------------------------------------------------------------------ scene reading

function lastCharMessageId() {
    const chat = ctx().chat ?? [];
    for (let i = chat.length - 1; i >= 0; i--) if (!chat[i].is_user && !chat[i].is_system) return i;
    return -1;
}

let sceneSeq = 0;

async function readScene(mesId, { force = false } = {}) {
    const c = ctx();
    const msg = c.chat?.[mesId];
    if (!msg || msg.is_user) return;
    const data = chatData();
    const before = scene;
    const quick = heuristicScene(msg.mes, before);
    applyScene(quick, { events: false });
    playEvents(quick.events, mesId);

    const s = S();
    let changed = false;
    // Elephant Game reads the scene in its own per-turn report and hands it over (externalScene).
    if (globalThis.ElephantGame?.ownsScene?.()) {
        if (data) { data.scene = scene; c.saveMetadataDebounced?.(); }
        return;
    }
    if (s.sceneLLM && hasHelper(s)) {
        const seq = ++sceneSeq;
        try {
            const out = await callHelper(s, 'You are a precise scene classifier. Output only JSON.',
                scenePrompt({ message: String(msg.mes).slice(0, 4000), state: memoryState().slice(0, 2500), previous: before, user: c.name1, char: c.name2 }), 160, { json: true });
            const parsed = parseSceneJson(out);
            if (parsed && seq === sceneSeq) {
                changed = parsed.changed || parsed.location !== before.location;
                applyScene(parsed, { events: false });
                playEvents(parsed.events, mesId);
            }
        } catch (e) {
            if (e.message !== 'no-helper') log('scene read failed', e);
        }
    } else {
        changed = quick.mood !== before.mood;
    }
    if (data) {
        data.scene = scene;
        c.saveMetadataDebounced?.();
    }
    if (!force) maybeAutoImage(mesId, changed || scene.mood !== before.mood);
}

/** A scene read by someone else (Elephant Game's reporter) for message mesId. */
function externalScene(raw, mesId) {
    const before = scene;
    const parsed = parseSceneJson(JSON.stringify(raw));
    if (!parsed) return;
    const changed = parsed.changed || (parsed.location && parsed.location !== before.location);
    applyScene(parsed, { events: false });
    playEvents(parsed.events, mesId);
    const data = chatData();
    if (data) {
        data.scene = scene;
        ctx().saveMetadataDebounced?.();
    }
    maybeAutoImage(mesId, changed || scene.mood !== before.mood);
}

function onStreamToken(text) {
    if (!S().effects || typeof text !== 'string') return;
    const now = Date.now();
    if (now - lastStreamCheck < 900) return;
    lastStreamCheck = now;
    const fresh = text.slice(streamCursor);
    streamCursor = text.length;
    if (fresh.length < 12) return;
    const quick = heuristicScene(fresh, scene);
    const mesId = (ctx().chat?.length ?? 1) - 1;
    if (quick.events.length) playEvents(quick.events, mesId);
}

// ------------------------------------------------------------------ images

function pickMode() {
    const im = S().images;
    if (im.mode !== 'alternate') return im.mode;
    const data = chatData();
    return (data?.imageCount ?? 0) % 2 === 0 ? 'pov' : 'portrait';
}

function maybeAutoImage(mesId, sceneChanged) {
    const im = S().images;
    if (!im.enabled || !im.model || im.auto === 'off' || imageBusy) return;
    const data = chatData();
    if (!data) return;
    const since = mesId - (data.lastImageAt ?? -1);
    const every = Math.max(2, Number(im.every) || 8);
    const minGap = Math.max(2, Math.floor(every / 2));
    const due = im.auto === 'every' ? since >= every
        : (sceneChanged && since >= minGap) || since >= every * 2;
    if (due || data.lastImageAt < 0 && mesId >= 1 && im.auto === 'scene' && sceneChanged) generateFor(mesId, pickMode(), { auto: true });
}

function quickImage() {
    const id = lastCharMessageId();
    if (id < 0) return toast().info('Пока нечего рисовать — начните сцену');
    if (imageBusy) { imageBusy.abort(); return; }
    generateFor(id, pickMode());
}

async function generateFor(mesId, mode, { auto = false } = {}) {
    const s = S();
    const im = s.images;
    if (mesId < 0) return;
    if (!im.model) {
        if (!auto) { toast().info('Выберите модель картинок в «Сцена и арт»'); openStageSettings(); }
        return;
    }
    if (imageBusy) { if (!auto) toast().info('Картинка уже рисуется'); return; }

    const controller = new AbortController();
    imageBusy = controller;
    updateHeader();
    const $mes = $(`#chat .mes[mesid="${mesId}"]`);
    const $pending = $(`<div class="et-img-pending"><div class="et-shimmer"></div><span>${mode === 'pov' ? '🎥 Рисую сцену твоими глазами…' : '🖼️ Рисую портрет…'}</span><button class="et-x" title="Отмена">✕</button></div>`);
    $pending.find('.et-x').on('click', () => controller.abort());
    $mes.find('.mes_block').append($pending);
    const chatEl = document.getElementById('chat');
    if (chatEl && mesId === ctx().chat.length - 1 && chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 400) {
        chatEl.scrollTo({ top: chatEl.scrollHeight, behavior: 'smooth' });
    }

    const data = chatData();
    try {
        const prompt = await buildPrompt({ ...s, ...im, dna: s.dna, helperProfile: s.helperProfile, allowMainModel: s.allowMainModel }, mode, mesId);
        if (controller.signal.aborted) throw new DOMException('aborted', 'AbortError');
        const size = im.size === 'auto' ? (mode === 'pov' ? 'landscape' : 'portrait') : im.size;
        const result = await generateImage({ ...im, size }, prompt, mode, controller.signal);
        const url = await attachToMessage(mesId, result.base64, result.prompt, mode);
        if (data) {
            data.lastImageAt = mesId;
            data.imageCount = (data.imageCount ?? 0) + 1;
            if (url && mode === 'pov') data.sceneImage = url;
            ctx().saveMetadataDebounced?.();
        }
        if (url && mode === 'pov') setBackdrop(url);
        if (s.haptics) haptic('tick');
    } catch (e) {
        if (e.name === 'AbortError') toast().info('Генерация отменена');
        else if (e.message === 'no-helper') toast().warning('Нужна служебная модель для промптов: выберите профиль в «Сцена и арт» или в Elephant Memory');
        else { toast().error(e.message || String(e), 'Картинка'); log('image failed', e); }
        if (auto && data) data.lastImageAt = mesId; // do not retry on every message
    } finally {
        $pending.remove();
        imageBusy = null;
        updateHeader();
    }
}

// ------------------------------------------------------------------ settings sheet

async function openStageSettings() {
    const body = document.querySelector('#et-sheet-stage .et-sheet-body');
    if (!body.dataset.ready) {
        body.innerHTML = await fetch(new URL('./settings.html', import.meta.url)).then(r => r.text());
        body.dataset.ready = '1';
        bindSettings($(body));
    }
    refreshSettings($(body));
    if (shellOn) openSheet('stage');
    else {
        // Desktop: the same panel lives in the extensions drawer.
        openDrawer('#extensions-settings-button');
    }
}

function bindSettings($root) {
    $root.on('input change', '[data-et-key]', function () {
        const key = this.dataset.etKey;
        let v;
        if (this.type === 'checkbox') v = this.checked;
        else if (this.type === 'number' || this.type === 'range') v = Number(this.value);
        else v = this.value;
        setPath(S(), key, v);
        save();
        onSettingChanged(key);
        if (this.type === 'range') $root.find(`[data-et-out="${key}"]`).text(v);
    });
    $root.on('click', '[data-et-do]', async function () {
        const what = this.dataset.etDo;
        if (what === 'models') return fillModels($root, true);
        if (what === 'helper-models') return fillHelperModels($root, true);
        if (what === 'dna') {
            this.disabled = true;
            try {
                const dna = await visualDna(S(), { force: true });
                $root.find('#et_dna').val(dna);
                toast().success('Внешность обновлена');
            } catch (e) {
                toast().error(e.message === 'no-helper' ? 'Нужна служебная модель' : e.message);
            } finally { this.disabled = false; }
        }
        if (what === 'test') { closeSheets(); generateFor(lastCharMessageId(), pickMode()); }
    });
    $root.on('change', '#et_dna', function () {
        const ch = currentCharacter();
        if (!ch || ch.group) return;
        S().dna[ch.key] = this.value.trim();
        save();
    });
}

function refreshSettings($root) {
    const s = S();
    $root.find('[data-et-key]').each(function () {
        const v = getPath(s, this.dataset.etKey);
        if (this.type === 'checkbox') this.checked = Boolean(v);
        else this.value = v ?? '';
        if (this.type === 'range') $root.find(`[data-et-out="${this.dataset.etKey}"]`).text(v);
    });
    const $p = $root.find('#et_helper_profile').empty();
    $p.append(`<option value="">${ctx().extensionSettings?.elephant_memory?.helperProfile ? 'Как у Elephant Memory' : '— не выбран —'}</option>`);
    for (const p of listProfiles()) $p.append($('<option>').val(p.id).text(p.name));
    $p.val(s.helperProfile || '');
    $root.find('#et_profile_warn').toggle(!hasHelper(s));
    fillHelperModels($root, false);

    const ch = currentCharacter();
    $root.find('#et_dna_block').toggle(Boolean(ch && !ch.group));
    $root.find('#et_dna_name').text(ch?.name || '');
    $root.find('#et_dna').val(ch && !ch.group ? (s.dna[ch.key] || '') : '');
    fillModels($root, false);
    document.dispatchEvent(new CustomEvent('et-settings-refresh'));
}

async function fillModels($root, force) {
    const $m = $root.find('#et_image_model');
    if ($m.data('loaded') && !force) return;
    const current = S().images.model;
    $m.empty().append(`<option value="">${current ? current : '— загрузка… —'}</option>`);
    try {
        const models = await loadModels();
        $m.empty().append('<option value="">— выберите модель —</option>');
        for (const x of models) $m.append($('<option>').val(x.value).text(x.text));
        if (current && !models.some(x => x.value === current)) $m.append($('<option>').val(current).text(current));
        $m.val(current);
        $m.data('loaded', true);
    } catch (e) {
        $m.empty().append(`<option value="${current}">${current || '—'}</option>`);
        $root.find('#et_models_err').text(e.message).show();
    }
}

async function fillHelperModels($root, force) {
    const $m = $root.find('#et_helper_model');
    if (!$m.length || ($m.data('loaded') && !force)) return;
    const current = S().helperModel;
    try {
        const list = await loadHelperModels();
        const fmt = (v) => (v === null || v === undefined ? '?' : v < 1 ? v.toFixed(2) : v.toFixed(1));
        list.sort((a, b) => (a.input ?? 99) - (b.input ?? 99));
        $m.empty().append('<option value="">— не выбрана (профиль ниже) —</option>');
        for (const x of list) $m.append($('<option>').val(x.id).text(`${x.name}  ·  $${fmt(x.input)} / $${fmt(x.output)}`));
        if (current && !list.some(x => x.id === current)) $m.append($('<option>').val(current).text(current));
        $m.val(current || '');
        $m.data('loaded', true);
    } catch (e) {
        $m.empty().append(`<option value="${current || ''}">${current || '— список недоступен —'}</option>`);
    }
}

function onSettingChanged(key) {
    const s = S();
    if (key === 'effects' || key === 'intensity') {
        effects.setEnabled(s.effects);
        if (s.effects) { effects.layers = []; applyScene(scene, { events: false }); }
    }
    if (key === 'shell') toast().info('Перезагрузите страницу, чтобы применить');
    if (key === 'keepAwake') globalThis.ElephantApp?.keepScreenOn(s.keepAwake);
    if (key === 'backdrop' || key === 'backdropDim') setBackdrop(s.backdrop ? chatData()?.sceneImage : '');
    if (key === 'helperProfile' || key === 'helperModel') $('#et_profile_warn').toggle(!hasHelper(s));
}

// ------------------------------------------------------------------ chat lifecycle

function onChatChanged() {
    playedEvents.clear();
    document.body.classList.toggle('et-group-chat', Boolean(ctx().groupId));
    const data = chatData();
    const stored = data?.scene;
    applyScene(stored ? { ...stored, events: [] } : heuristicScene(''), { events: false });
    setBackdrop(data?.sceneImage || '');
    if (!stored) {
        const id = lastCharMessageId();
        if (id >= 0) {
            const quick = heuristicScene(ctx().chat[id].mes);
            applyScene({ ...quick, events: [] }, { events: false });
        }
    }
    updateHeader();
    // Pre-compute the character's visual reference while the user reads.
    const s = S();
    if (s.images.enabled && hasHelper(s)) visualDna(s).catch(() => {});
}

function addMessageButtons() {
    const $tpl = $('#message_template .extraMesButtons');
    if ($tpl.length && !$tpl.find('.et-gen-pov').length) {
        $tpl.prepend('<div title="POV-кадр (Elephant Stage)" class="mes_button et-gen-pov fa-solid fa-eye"></div>' +
            '<div title="Портрет персонажа (Elephant Stage)" class="mes_button et-gen-portrait fa-solid fa-image-portrait"></div>');
    }
    $(document).on('click', '.et-gen-pov, .et-gen-portrait', function () {
        const id = Number($(this).closest('.mes').attr('mesid'));
        if (Number.isInteger(id)) generateFor(id, this.classList.contains('et-gen-pov') ? 'pov' : 'portrait');
    });
}

function registerCommands() {
    const c = ctx();
    if (!c.SlashCommandParser || !c.SlashCommand) return;
    const add = (name, help, fn, args = []) => c.SlashCommandParser.addCommandObject(c.SlashCommand.fromProps({
        name, helpString: help, callback: fn, unnamedArgumentList: args,
    }));
    add('stage-pov', 'Elephant Stage: POV-кадр последней сцены.', async () => { await generateFor(lastCharMessageId(), 'pov'); return ''; });
    add('stage-portrait', 'Elephant Stage: портрет персонажа.', async () => { await generateFor(lastCharMessageId(), 'portrait'); return ''; });
    add('stage-mood', 'Elephant Stage: закрепить настроение (calm, cozy, joy, romance, tension, combat, mystery, horror, sad, epic) или "auto".', async (_a, value) => {
        const v = String(value || '').trim();
        S().lockMood = MOODS[v] ? v : '';
        save();
        applyScene(scene, { events: false });
        return S().lockMood || 'auto';
    });
    add('stage-fx', `Elephant Stage: показать эффект (${['hit', 'blood', 'explosion', 'lightning', 'kiss', 'magic', 'heartbeat'].join(', ')}).`, async (_a, value) => {
        playEvents([String(value || 'hit').trim()]);
        return '';
    });
}

// ------------------------------------------------------------------ init

export async function init() {
    S();
    const c = ctx();
    shellOn = shouldShell();
    document.body.classList.add('et-stage');
    if (shellOn) {
        document.body.classList.add('et-shell');
        buildShell();
    } else {
        // Desktop: effects still run behind the chat, settings sit in the extensions drawer.
        const backdrop = $('<div id="et-backdrop" aria-hidden="true"><div class="et-bd-gradient"></div><img class="et-bd-img et-bd-a" alt=""><img class="et-bd-img et-bd-b" alt=""><div class="et-bd-vignette"></div><div class="et-bd-flash"></div></div>');
        $('body').prepend(backdrop);
        effects.mount(backdrop[0]);
        const html = await fetch(new URL('./settings.html', import.meta.url)).then(r => r.text());
        const $panel = $(`<div id="elephant_stage_settings" class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b>🎭 Elephant Stage</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div><div class="inline-drawer-content et-desktop-settings">${html}</div></div>`);
        $('#extensions_settings2').append($panel);
        bindSettings($panel);
        refreshSettings($panel);
    }
    effects.setEnabled(S().effects);
    if (inApp() && S().keepAwake) globalThis.ElephantApp.keepScreenOn(true);

    addMessageButtons();
    registerCommands();

    const ev = c.eventSource;
    const et = c.eventTypes ?? c.event_types;
    ev.on(et.CHAT_CHANGED, () => onChatChanged());
    ev.on(et.MESSAGE_RECEIVED, (id, type) => {
        if (type === 'impersonate' || type === 'extension') return;
        streamCursor = 0;
        setTimeout(() => readScene(Number(id)), 50);
    });
    ev.on(et.MESSAGE_SWIPED, (id) => { streamCursor = 0; playedEvents.delete(Number(id)); });
    ev.on(et.GENERATION_STARTED, () => { streamCursor = 0; document.body.classList.add('et-generating'); });
    for (const e of [et.GENERATION_ENDED, et.GENERATION_STOPPED]) if (e) ev.on(e, () => document.body.classList.remove('et-generating'));
    if (et.STREAM_TOKEN_RECEIVED) ev.on(et.STREAM_TOKEN_RECEIVED, onStreamToken);
    for (const e of [et.CHARACTER_PAGE_LOADED, et.CHARACTER_EDITED, et.SETTINGS_UPDATED]) if (e) ev.on(e, () => updateHeader());

    globalThis.ElephantStage = { handleBack, openSheet, closeSheets, applyScene, externalScene, playEvents, generateFor, effects, shake, flash, getScene: () => scene, presets: AMBIENT_PRESETS, sizes: SIZES };
    window.addEventListener('et-insets', () => effects.resize());
    onChatChanged();
    log('loaded', shellOn ? '(mobile shell)' : '(desktop)');
}
