/*
 * Elephant Game — game mode for Elephant Tavern.
 *
 * Turn pipeline (per chat, when game mode is on):
 *   1. Referee (cheap helper, before generation): does the player's action need a check?
 *   2. Engine (JS): shows the check card with real odds, rolls 2d6, applies consequences.
 *   3. Narrator (main model): gets a compact [GAME ENGINE] block at depth 0 — state + outcome.
 *   4. Extractor (cheap helper, after the reply): what changed — time, place, NPC trust,
 *      money, items, goals, clocks — plus the scene for Elephant Stage (one call, not two).
 *
 * State is snapshotted on every message (message.extra.elephant_game.state = state AFTER
 * that message), so swipes, edits and deletions roll the game back for free.
 */
import { ctx, callHelper, hasHelper, memoryState, haptic, log, toast, currentCharacter } from '../stage/helper.js';
import * as E from './engine.js';

const $ = (...a) => globalThis.jQuery(...a);
const MODULE = 'elephant_game';
const PROMPT_KEY = 'elephant_game';

const DEFAULTS = {
    checkCard: true,     // show the card and wait for the tap; off = roll automatically
    hideTracker: true,   // hide the preset's "[ 🕐 … ]" line — the HUD shows it
    juice: true,
};

function S() {
    const es = ctx().extensionSettings;
    es[MODULE] ??= structuredClone(DEFAULTS);
    for (const [k, v] of Object.entries(DEFAULTS)) if (es[MODULE][k] === undefined) es[MODULE][k] = v;
    return es[MODULE];
}
const stageSettings = () => ctx().extensionSettings?.elephant_stage ?? {};

function meta() {
    const m = ctx().chatMetadata;
    if (!m) return null;
    return m[MODULE] ?? null;
}

export function isActive() {
    return Boolean(meta()?.active);
}

// ------------------------------------------------------------------ state snapshots

/** State after message `index` (inclusive), walking back to the newest snapshot. */
function stateAt(index) {
    const chat = ctx().chat ?? [];
    for (let i = Math.min(index, chat.length - 1); i >= 0; i--) {
        const snap = chat[i]?.extra?.elephant_game?.state;
        if (snap) return E.clone(snap);
    }
    return E.clone(meta()?.initial ?? E.newState());
}

const currentState = () => stateAt((ctx().chat?.length ?? 0) - 1);

function writeSnapshot(index, patch) {
    const msg = ctx().chat?.[index];
    if (!msg) return;
    msg.extra ??= {};
    msg.extra.elephant_game = { ...(msg.extra.elephant_game || {}), ...patch };
    // keep the snapshot with the active swipe too
    if (Array.isArray(msg.swipe_info) && msg.swipe_info[msg.swipe_id ?? 0]) {
        const si = msg.swipe_info[msg.swipe_id ?? 0];
        si.extra ??= {};
        si.extra.elephant_game = msg.extra.elephant_game;
    }
}

// ------------------------------------------------------------------ narrator injection

function setNarratorBlock(text) {
    const c = ctx();
    c.setExtensionPrompt(PROMPT_KEY, text || '', 1 /* IN_CHAT */, 0, false, 0 /* SYSTEM */);
}

function clearNarratorBlock() { setNarratorBlock(''); }

// ------------------------------------------------------------------ referee & check card

function lastUserIndex(chat) {
    for (let i = chat.length - 1; i >= 0; i--) if (chat[i].is_user && !chat[i].is_system) return i;
    return -1;
}

function lastNarrationBefore(chat, index) {
    for (let i = index - 1; i >= 0; i--) if (!chat[i].is_user && !chat[i].is_system) return chat[i].mes;
    return '';
}

/** Global generation interceptor (manifest.generate_interceptor). */
export async function beforeGenerate(_coreChat, _contextSize, abort, type) {
    if (!isActive()) { clearNarratorBlock(); return; }
    const c = ctx();
    const chat = c.chat;
    const ui = lastUserIndex(chat);
    try {
        if (['quiet', 'impersonate'].includes(type) || ui < 0) {
            setNarratorBlock(E.narratorBlock(currentStateForGeneration(type), { userName: c.name1 }));
            return;
        }
        const userMsg = chat[ui];
        const isLastUser = ui === chat.length - 1;
        const regen = type === 'swipe' || type === 'regenerate';
        const existing = userMsg.extra?.elephant_game;

        // Swipes and regenerations never reroll: the dice already fell.
        if ((regen || type === 'continue') && existing?.checked) {
            setNarratorBlock(E.narratorBlock(existing.state ?? stateAt(ui), { record: existing.record, events: existing.record?.events ?? [], userName: c.name1 }));
            return;
        }
        if (!isLastUser || existing?.checked) {
            setNarratorBlock(E.narratorBlock(currentStateForGeneration(type), { userName: c.name1 }));
            return;
        }

        const before = stateAt(ui - 1);
        const text = String(userMsg.mes || '').trim();
        let verdict = null;
        if (text.length >= 6 && !/^\(\(|^\[ooc|^ooc:/i.test(text) && worthRefereeing(text)) {
            setHudBusy(true);
            verdict = await referee(before, lastNarrationBefore(chat, ui), text);
            setHudBusy(false);
        }

        if (!verdict?.check) {
            writeSnapshot(ui, { checked: true, state: before });
            setNarratorBlock(E.narratorBlock(before, { userName: c.name1 }));
            return;
        }

        const choice = S().checkCard ? await showCheckCard(before, verdict) : { roll: true, push: false };
        if (choice.cancel) {
            writeSnapshot(ui, { checked: false });
            clearNarratorBlock();
            abort(true);
            toast().info('Ход отменён — можно переписать сообщение');
            return;
        }
        // The dice the card showed are the dice that count.
        const { state, record } = E.resolveCheck(before, verdict, { push: choice.push, dice: choice.dice });
        writeSnapshot(ui, { checked: true, state, record });
        await c.saveChat();
        afterCheck(record, state);
        setNarratorBlock(E.narratorBlock(state, { record, events: record.events, userName: c.name1 }));
        renderHud(state);
        if (record.events.some(e => e.kind === 'defeat')) {
            const go = await handleDefeat(ui, state);
            if (!go) { clearNarratorBlock(); abort(true); }
        }
    } catch (e) {
        setHudBusy(false);
        log('interceptor failed', e);
        setNarratorBlock(E.narratorBlock(currentState(), { userName: c.name1 }));
    }
}

function currentStateForGeneration(type) {
    const chat = ctx().chat;
    // For swipes the last (being replaced) reply must not count.
    if (type === 'swipe' || type === 'regenerate') return stateAt(chat.length - 2);
    return currentState();
}

async function referee(state, narration, action) {
    const c = ctx();
    const ss = stageSettings();
    if (!hasHelper(ss)) return heuristicReferee(action);
    try {
        const out = await callHelper(ss, 'You are a fair, strict tabletop RPG referee. Output only JSON.',
            E.refereePrompt({ state, lastNarration: narration, action, user: c.name1, char: c.name2 }), 220, { json: true });
        const v = E.parseJsonLine(out);
        if (v && typeof v.check === 'boolean') return v;
    } catch (e) {
        log('referee failed', e);
    }
    return heuristicReferee(action);
}

/** Fallback when no helper model is configured: obvious risky verbs only. */
function heuristicReferee(action) {
    const t = action.toLowerCase();
    const table = [
        ['might', /\b(punch|attack|strike|tackle|shove|break|force|wrestle|kick|stab|slash)\b|удар|атаку|выбива|ломаю/],
        ['finesse', /\b(sneak|steal|pickpocket|lockpick|pick the lock|climb|dodge|jump|hide|shoot)\b|краду|прячусь|вскрыва|карабка|уклоня/],
        ['charm', /\b(lie|bluff|persuade|convince|seduce|bribe|haggle)\b|вру|лгу|убежда|уговар|подкуп/],
        ['insight', /\b(search|investigate|read (his|her) face|is (he|she) lying)\b|обыскива|ищу улик/],
        ['resolve', /\b(resist|endure|hold my ground)\b|сопротивля|терплю/],
    ];
    for (const [skill, re] of table) {
        if (re.test(t)) return { check: true, skill, action_en: 'act', label_ru: 'Рискованное действие', position: 'risky', effect: 'standard', dc: 8, threat: '' };
    }
    return { check: false };
}

// Words that suggest an uncertain, consequential action (EN + RU). Without one of them (and
// without an *action* in asterisks) the referee call is skipped — plain talk costs nothing.
const RISKY = [
    'attack', 'strike', 'hit', 'punch', 'kick', 'stab', 'shoot', 'fight', 'parry', 'dodge', 'block', 'grab', 'tackle', 'wrestle', 'throw',
    'sneak', 'hide', 'steal', 'pickpocket', 'lockpick', 'pick the lock', 'climb', 'jump', 'leap', 'run', 'chase', 'escape', 'flee', 'swim',
    'lie', 'bluff', 'deceive', 'trick', 'persuade', 'convince', 'intimidate', 'threaten', 'seduce', 'bribe', 'negotiate', 'haggle', 'beg',
    'search', 'investigate', 'examine', 'track', 'listen', 'spot', 'notice', 'decipher', 'hack', 'repair', 'force', 'break', 'smash', 'pry',
    'resist', 'endure', 'cast', 'spell', 'heal', 'aim', 'try to', 'attempt', 'carefully', 'quietly', 'quickly',
    'атак', 'удар', 'бью', 'бить', 'пинаю', 'стреля', 'дерусь', 'уклоня', 'парир', 'хватаю', 'бросаю', 'крад', 'краду', 'прячусь', 'украд',
    'взлом', 'вскры', 'лезу', 'карабк', 'прыга', 'прыгну', 'бегу', 'убега', 'сбега', 'плыв', 'вру', 'лгу', 'обман', 'блеф', 'убежда', 'уговар',
    'угрожа', 'запуга', 'соблаз', 'подкуп', 'торгу', 'обыск', 'ищу', 'осматрива', 'изуча', 'прислушив', 'выслежива', 'чиню', 'ломаю', 'выбива',
    'сопротивл', 'терплю', 'колду', 'заклин', 'целюсь', 'пытаюсь', 'попробую', 'осторожно', 'тихо', 'быстро',
    'flirt', 'tempt', 'charm', 'refuse', 'see through', 'disguise', 'recognize', 'pretend', 'overpower', 'pin',
    'флирт', 'очаров', 'не поддаюсь', 'отказыва', 'вижу насквозь', 'маскир', 'узнаю', 'притворя', 'прижимаю', 'одолеть', 'вырыва',
];

function worthRefereeing(text) {
    const t = ` ${String(text || '').toLowerCase()} `;
    return /\*[^*]{3,}\*/.test(text) || RISKY.some(w => t.includes(w));
}

// ------------------------------------------------------------------ after the reply: extractor

async function onReply(mesId) {
    if (!isActive()) return;
    const c = ctx();
    const msg = c.chat?.[mesId];
    if (!msg || msg.is_user || msg.is_system) return;
    const ui = lastUserIndex(c.chat.slice(0, mesId + 1));
    const base = stateAt(mesId - 1);
    const tracker = E.parseTrackerLine(msg.mes);
    const ss = stageSettings();
    let report = null;
    if (hasHelper(ss)) {
        setHudBusy(true);
        try {
            const out = await callHelper(ss, 'You are a meticulous game-state tracker. Output only JSON.',
                E.extractorPrompt({ state: base, userText: ui >= 0 ? c.chat[ui].mes : '', reply: msg.mes, user: c.name1, char: c.name2, memoryState: memoryState() }), 420, { json: true });
            report = E.parseJsonLine(out);
        } catch (e) {
            log('extractor failed', e);
        } finally {
            setHudBusy(false);
        }
    }
    // A swipe may have arrived meanwhile; only write to the message we read.
    if (c.chat[mesId] !== msg) return;
    const { state, notes, events } = E.applyReport(base, report, { trackerLine: tracker });
    writeSnapshot(mesId, { state, notes, events });
    await c.saveChat();
    renderHud(state);
    showNotes(notes);
    for (const ev of events) {
        if (ev.kind === 'clock_full') banner(ev.clock.kind === 'threat' ? `⏳ ${ev.clock.name}` : `🏁 ${ev.clock.name}`, ev.clock.kind === 'threat' ? 'bad' : 'gold');
        if (ev.kind === 'defeat') handleDefeat(mesId, state, ui >= 0 ? ui : mesId);
    }
    if (notes.some(n => n.kind === 'goal_done')) banner('Цель выполнена', 'gold');
    if (notes.some(n => n.kind === 'level')) banner(`Уровень ${state.level}!`, 'gold');

    // One helper call feeds Elephant Stage too.
    if (report && globalThis.ElephantStage?.externalScene) {
        globalThis.ElephantStage.externalScene({
            mood: report.mood, intensity: report.intensity, weather: tracker?.weather || report.weather,
            time: report.time_of_day, indoor: report.indoor, location: state.location,
            events: report.events, changed: report.scene_changed,
        }, mesId);
    }
    hideTrackerLines();
}

// ------------------------------------------------------------------ defeat

async function handleDefeat(index, state, cutFrom = index) {
    const P = ctx().Popup;
    const allowDeath = E.DIFFICULTY[state.difficulty].death;
    const text = `Твой герой получил смертельную рану.<br><br><b>Выжить ценой</b> — остаёшься на грани, со шрамом навсегда.<br><b>Откатиться</b> — вернуть ход и сыграть иначе.${allowDeath ? '' : '<br><small>На сложности «Сюжет» смерть невозможна.</small>'}`;
    const res = await P.show.confirm('☠ Поражение', text, { okButton: 'Выжить ценой', cancelButton: 'Откатиться' });
    if (res) {
        const s = E.clone(state);
        s.harm = 3;
        s.scars = [...(s.scars || []), `Шрам (ход ${s.turn})`];
        writeSnapshot(index, { state: s });
        await ctx().saveChat();
        renderHud(s);
        return true;
    }
    await ctx().executeSlashCommandsWithOptions?.(`/cut ${cutFrom}-${ctx().chat.length - 1}`);
    renderHud(currentState());
    return false;
}

// ------------------------------------------------------------------ UI: HUD

function ensureHud() {
    if (document.getElementById('eg-hud')) return;
    const hud = $(`
        <div id="eg-hud" role="button" aria-label="Состояние игры">
            <div class="eg-hud-row">
                <span class="eg-time"></span><span class="eg-sep">·</span><span class="eg-loc"></span>
                <span class="eg-spacer"></span><span class="eg-weather"></span><span class="eg-money"></span>
            </div>
            <div class="eg-hud-row eg-hud-stats">
                <span class="eg-harm"></span><span class="eg-stress"></span>
                <span class="eg-clocks"></span><span class="eg-spacer"></span><span class="eg-busy"></span>
            </div>
        </div>`);
    $('#chat').before(hud);
    hud.on('click', () => openStateSheet('hero'));
}

const WEATHER_ICON = { clear: '☀️', rain: '🌧️', storm: '⛈️', snow: '❄️', fog: '🌫️', ash: '🌋' };

function clockSvg(c, size = 18) {
    const r = size / 2 - 2;
    const cx = size / 2;
    const segs = [];
    for (let i = 0; i < c.size; i++) {
        const a0 = (i / c.size) * Math.PI * 2 - Math.PI / 2;
        const a1 = ((i + 1) / c.size) * Math.PI * 2 - Math.PI / 2;
        const x0 = cx + r * Math.cos(a0), y0 = cx + r * Math.sin(a0);
        const x1 = cx + r * Math.cos(a1), y1 = cx + r * Math.sin(a1);
        segs.push(`<path d="M${cx},${cx} L${x0.toFixed(2)},${y0.toFixed(2)} A${r},${r} 0 0 1 ${x1.toFixed(2)},${y1.toFixed(2)} Z" class="${i < c.filled ? 'on' : ''}"/>`);
    }
    return `<svg class="eg-clock eg-clock-${c.kind}" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${segs.join('')}<circle cx="${cx}" cy="${cx}" r="${r}" class="rim"/></svg>`;
}

function pips(n, max, cls) {
    let out = '';
    for (let i = 0; i < max; i++) out += `<i class="${cls}${i < n ? ' on' : ''}"></i>`;
    return out;
}

function renderHud(state = currentState()) {
    const hud = document.getElementById('eg-hud');
    if (!isActive()) { hud?.remove(); document.body.classList.remove('eg-active'); return; }
    ensureHud();
    document.body.classList.add('eg-active');
    const $h = $('#eg-hud');
    $h.find('.eg-time').text(E.timeRu(state.time));
    $h.find('.eg-loc').text(state.location || '—');
    $h.find('.eg-weather').text(WEATHER_ICON[state.weather] || '');
    $h.find('.eg-money').text(`${state.currency} ${state.money}`);
    $h.find('.eg-harm').html(`<b class="eg-lbl">♥</b>${pips(3 - state.harm, 3, 'eg-pip eg-pip-hp')}`).attr('title', E.HARM[state.harm].ru);
    $h.find('.eg-stress').html(`<b class="eg-lbl">⚡</b>${pips(state.stress, E.STRESS_MAX, 'eg-pip eg-pip-st')}`);
    const clocks = state.clocks.filter(c => c.filled < c.size).sort((a, b) => (b.kind === 'threat') - (a.kind === 'threat') || b.filled / b.size - a.filled / a.size).slice(0, 2);
    $h.find('.eg-clocks').html(clocks.map(c => `<span class="eg-hud-clock">${clockSvg(c)}<span>${escapeHtml(c.name)}</span></span>`).join(''));
    $h.toggleClass('eg-lowhp', state.harm >= 2);
    $h.find('.eg-lvlup').remove();
    if (state.unspent > 0) $h.find('.eg-hud-stats .eg-spacer').after('<span class="eg-lvlup">⬆ навык</span>');
}

function setHudBusy(on) {
    $('#eg-hud .eg-busy').html(on ? '<i class="fa-solid fa-dice-d20 fa-spin"></i>' : '');
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// ------------------------------------------------------------------ UI: check card

function ensureSheets() {
    if (document.getElementById('eg-check')) return;
    $('body').append(`
        <div id="eg-scrim"></div>
        <section id="eg-check" class="eg-sheet" aria-live="polite"></section>
        <section id="eg-state" class="eg-sheet"><div class="eg-grip"></div><div class="eg-tabs"></div><div class="eg-sheet-body"></div></section>
        <section id="eg-setup" class="eg-sheet"><div class="eg-grip"></div><div class="eg-sheet-body"></div></section>
        <section id="eg-card" class="eg-sheet"><div class="eg-grip"></div><div class="eg-sheet-body"></div></section>
        <div id="eg-toasts"></div>
        <div id="eg-banner"></div>`);
    $('#eg-scrim').on('click', () => { if (!$('#eg-check').hasClass('eg-open')) closeEgSheets(); });
}

function openEgSheet(id) {
    ensureSheets();
    $('.eg-sheet').removeClass('eg-open');
    $(`#${id}`).addClass('eg-open');
    document.body.classList.add('eg-sheet-open');
}

function closeEgSheets() {
    const was = $('.eg-sheet.eg-open').length > 0;
    $('.eg-sheet').removeClass('eg-open');
    document.body.classList.remove('eg-sheet-open');
    return was;
}

function showCheckCard(state, v) {
    ensureSheets();
    return new Promise((resolve) => {
        const skill = E.SKILLS[v.skill] ? v.skill : 'insight';
        const pos = E.POSITIONS[v.position] ? v.position : 'risky';
        const dc = E.effectiveDc(state, v.dc, { ...v, skill });
        const bond = E.bondModifier(state, { ...v, skill });
        const baseMod = E.modifier(state, skill);
        const canPush = state.stress < E.STRESS_MAX;
        let push = false;
        const $card = $('#eg-check');

        const render = () => {
            const mod = baseMod + (push ? 1 : 0);
            const o = E.odds(mod, dc, pos);
            const pct = Math.round(o.atLeastSuccess * 100);
            const nearPct = Math.round(o.near * 100);
            $card.attr('data-pos', pos).html(`
                <div class="eg-grip"></div>
                <div class="eg-check-head">
                    <div class="eg-skill"><span class="eg-skill-ico">${E.SKILLS[skill].icon}</span><div><b>${E.SKILLS[skill].ru.toUpperCase()} ${mod >= 0 ? '+' : ''}${mod}</b><small>${escapeHtml(v.label_ru || 'Проверка')}</small></div></div>
                    <div class="eg-odds"><b>${pct}%</b><small>успех</small></div>
                </div>
                <div class="eg-badges">
                    <span class="eg-badge eg-pos-${pos}">${E.POSITIONS[pos].ru}</span>
                    <span class="eg-badge">Сложность ${dc}</span>
                    ${bond.why.map(w => `<span class="eg-badge eg-badge-bond">💞 ${escapeHtml(w)}</span>`).join('')}
                    <span class="eg-badge">+ ${nearPct}% успех ценой</span>
                    ${v.threat ? `<span class="eg-badge eg-badge-threat">⏳ ${escapeHtml(v.threat)}</span>` : ''}
                </div>
                <div class="eg-bar"><i style="width:${pct}%"></i><i class="eg-bar-near" style="width:${nearPct}%"></i></div>
                <div class="eg-dice"><div class="eg-die">?</div><div class="eg-die">?</div><div class="eg-roll-result"></div></div>
                <div class="eg-actions">
                    <button class="eg-btn eg-btn-roll"><i class="fa-solid fa-dice"></i> Бросить</button>
                    <button class="eg-btn eg-btn-push ${push ? 'eg-on' : ''}" ${canPush ? '' : 'disabled'}>⚡ Надавить <small>+1 · стресс</small></button>
                </div>
                <button class="eg-link eg-btn-cancel">Отменить ход</button>`);
        };
        render();
        openEgSheet('eg-check');
        if (S().juice) haptic('tick');

        $card.off('click').on('click', '.eg-btn-push', () => { push = !push; render(); haptic('tick'); })
            .on('click', '.eg-btn-cancel', () => { closeEgSheets(); resolve({ cancel: true }); })
            .on('click', '.eg-btn-roll', async () => {
                $card.find('.eg-actions, .eg-btn-cancel').css('visibility', 'hidden');
                const dice = E.rollDice();
                await animateDice($card, dice);
                const mod = baseMod + (push ? 1 : 0);
                const outcome = E.classify(dice[0], dice[1], mod, dc, pos);
                const o = E.OUTCOMES[outcome];
                $card.find('.eg-roll-result').attr('data-tone', o.tone).html(`<b>${o.ru}</b><small>${dice[0]} + ${dice[1]} ${mod >= 0 ? '+' : '−'} ${Math.abs(mod)} = ${dice[0] + dice[1] + mod} / ${dc}</small>`);
                $card.attr('data-tone', o.tone);
                juiceOutcome(outcome);
                setTimeout(() => { closeEgSheets(); resolve({ roll: true, push, dice }); }, 1500);
            });
    });
}

function animateDice($card, final) {
    const faces = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
    const $d = $card.find('.eg-die');
    $d.addClass('eg-rolling');
    return new Promise((res) => {
        let n = 0;
        const t = setInterval(() => {
            $d.each(function () { this.textContent = faces[Math.floor(Math.random() * 6)]; });
            if (++n >= 9) {
                clearInterval(t);
                $d.removeClass('eg-rolling');
                $d.eq(0).text(faces[final[0] - 1]);
                $d.eq(1).text(faces[final[1] - 1]);
                if (S().juice) haptic('hit');
                res();
            }
        }, 60);
    });
}

function juiceOutcome(outcome) {
    if (!S().juice) return;
    const st = globalThis.ElephantStage;
    switch (outcome) {
        case 'crit': st?.playEvents?.(['magic']); haptic('heartbeat'); break;
        case 'success': haptic('tick'); break;
        case 'fail': st?.playEvents?.(['hit']); break;
        case 'disaster': st?.playEvents?.(['explosion']); break;
        default:
    }
}

function afterCheck(record) {
    showNotes(record.notes);
}

// ------------------------------------------------------------------ UI: toasts & banner

function showNotes(notes = []) {
    const out = [];
    for (const n of notes) {
        switch (n.kind) {
            case 'rel': {
                const parts = [];
                if (n.trust) parts.push(`${n.trust > 0 ? '+' : ''}${n.trust} 🛡`);
                if (n.affection) parts.push(`${n.affection > 0 ? '+' : ''}${n.affection} 💞`);
                if (n.attraction) parts.push(`${n.attraction > 0 ? '+' : ''}${n.attraction} 💘`);
                out.push({ text: `${n.name}: ${parts.join(' ')}`, sub: n.why, tone: n.trust + n.attraction + (n.affection || 0) >= 0 ? 'good' : 'bad' });
                break;
            }
            case 'first': {
                const a = E.INTIMACY.find(x => x.id === n.act);
                out.push({ text: `${a?.icon || '💗'} Впервые: ${(a?.ru || n.act).toLowerCase()} с ${n.name}`, tone: 'gold' });
                break;
            }
            case 'orgasm': out.push({ text: `💦 ${n.name}: оргазм${n.n > 1 ? ` ×${n.n}` : ''}`, tone: 'gold' }); break;
            case 'lust': if (n.delta >= 20) out.push({ text: `🔥 ${n.name} возбуждается`, tone: 'info' }); break;
            case 'like': out.push({ text: `💗 ${n.name} любит: ${n.text}`, tone: 'info' }); break;
            case 'spot': out.push({ text: `✨ Чувствительное место ${n.name}: ${n.text}`, tone: 'info' }); break;
            case 'limit': out.push({ text: `🚫 ${n.name}: граница — ${n.text}`, tone: 'warn' }); break;
            case 'tier': out.push({ text: `${n.name} — ${E.TIERS.find(t => t.id === n.to)?.ru}`, tone: 'gold' }); break;
            case 'npc_new': out.push({ text: `Новое знакомство: ${n.name}`, tone: 'info' }); break;
            case 'clock': out.push({ text: `${n.name} ${n.to}/${n.size}`, tone: 'warn' }); break;
            case 'stress': out.push({ text: `Стресс ${n.delta > 0 ? '+' : ''}${n.delta}`, tone: n.delta > 0 ? 'bad' : 'good' }); break;
            case 'harm': out.push({ text: n.to > n.from ? `Рана: ${E.HARM[n.to].ru}` : `Легче: ${E.HARM[n.to].ru}`, tone: n.to > n.from ? 'bad' : 'good' }); break;
            case 'xp': out.push({ text: `+${n.delta} опыта`, tone: 'info' }); break;
            case 'money': out.push({ text: `${n.delta > 0 ? '+' : ''}${n.delta} ${currentState().currency}`, tone: n.delta > 0 ? 'good' : 'bad' }); break;
            case 'item': out.push({ text: `${n.delta > 0 ? '+' : '−'} ${n.name}`, tone: n.delta > 0 ? 'good' : 'bad' }); break;
            case 'goal_new': out.push({ text: `Новая цель: ${n.title}`, tone: 'info' }); break;
            case 'goal_failed': out.push({ text: `Цель провалена: ${n.title}`, tone: 'bad' }); break;
            default:
        }
    }
    ensureSheets();
    out.slice(0, 5).forEach((t, i) => setTimeout(() => {
        const el = $(`<div class="eg-toast" data-tone="${t.tone}"><b>${escapeHtml(t.text)}</b>${t.sub ? `<small>${escapeHtml(t.sub)}</small>` : ''}</div>`);
        $('#eg-toasts').append(el);
        setTimeout(() => el.addClass('eg-out'), 2600);
        setTimeout(() => el.remove(), 3100);
    }, i * 350));
}

function banner(text, tone = 'gold') {
    ensureSheets();
    const $b = $('#eg-banner');
    $b.attr('data-tone', tone).text(text).removeClass('eg-show');
    void $b[0].offsetWidth;
    $b.addClass('eg-show');
    if (S().juice) { haptic(tone === 'bad' ? 'rumble' : 'heartbeat'); if (tone === 'gold') globalThis.ElephantStage?.playEvents?.(['magic']); }
}

// ------------------------------------------------------------------ UI: state sheet

const TABS = [['hero', '🧍 Герой'], ['people', '🫂 Связи'], ['goals', '🎯 Цели'], ['log', '🎲 Броски']];

function openStateSheet(tab = 'hero') {
    ensureSheets();
    const s = currentState();
    $('#eg-state .eg-tabs').html(TABS.map(([id, label]) => `<button class="eg-tab ${id === tab ? 'eg-on' : ''}" data-tab="${id}">${label}</button>`).join(''))
        .off('click').on('click', '.eg-tab', function () { openStateSheet(this.dataset.tab); });
    const $b = $('#eg-state .eg-sheet-body');
    if (tab === 'hero') $b.html(heroHtml(s));
    if (tab === 'people') $b.html(peopleHtml(s));
    if (tab === 'goals') $b.html(goalsHtml(s));
    if (tab === 'log') $b.html(logHtml(s));
    $b.off('click').on('click', '[data-card]', function () { openCard(this.dataset.card); })
        .on('click', '[data-spend]', async function () {
        const idx = (ctx().chat?.length ?? 1) - 1;
        const next = E.spendPoint(currentState(), this.dataset.spend);
        writeSnapshot(idx, { state: next });
        await ctx().saveChat();
        renderHud(next);
        openStateSheet('hero');
        haptic('tick');
    }).on('click', '[data-act="setup"]', () => openSetup(true))
        .on('click', '[data-act="stop"]', async () => {
            const ok = await ctx().Popup.show.confirm('Выключить игровой режим?', 'Состояние сохранится, его можно включить снова.');
            if (!ok) return;
            meta().active = false;
            await ctx().saveMetadata();
            closeEgSheets();
            clearNarratorBlock();
            renderHud();
            globalThis.ElephantStage && document.body.classList.remove('eg-active');
        });
    openEgSheet('eg-state');
}

function heroHtml(s) {
    const skills = Object.entries(E.SKILLS).map(([k, sk]) => `
        <div class="eg-skill-row">
            <span>${sk.icon} ${sk.ru}<small class="eg-skill-hint">${E.TRAITS[k]?.hint || ''}</small></span>
            <span class="eg-dots">${pips(s.skills[k], 4, 'eg-dot')}</span>
            ${s.unspent > 0 && s.skills[k] < 4 ? `<button class="eg-plus" data-spend="${k}">+</button>` : ''}
        </div>`).join('');
    return `
        <div class="eg-hero-top">
            <div><b>Уровень ${s.level}</b><small>Опыт ${s.xp}/${E.XP_PER_LEVEL}${s.unspent ? ` · свободных очков: ${s.unspent}` : ''}</small></div>
            <div class="eg-xpbar"><i style="width:${Math.round(s.xp / E.XP_PER_LEVEL * 100)}%"></i></div>
        </div>
        <div class="eg-cards">
            <div class="eg-mini"><small>Здоровье</small><b>${E.HARM[s.harm].ru}</b><span>${pips(3 - s.harm, 3, 'eg-pip eg-pip-hp')}</span></div>
            <div class="eg-mini"><small>Стресс</small><b>${s.stress}/${E.STRESS_MAX}</b><span>${pips(s.stress, E.STRESS_MAX, 'eg-pip eg-pip-st')}</span></div>
            <div class="eg-mini"><small>Деньги</small><b>${s.currency} ${s.money}</b></div>
        </div>
        <h4 class="eg-h">Навыки</h4>${skills}
        <h4 class="eg-h">Вещи</h4>
        <div class="eg-items">${s.items.length ? s.items.map(i => `<span class="eg-item">${escapeHtml(i)}</span>`).join('') : '<span class="eg-muted">Пусто</span>'}</div>
        ${s.scars?.length ? `<h4 class="eg-h">Шрамы</h4><div class="eg-items">${s.scars.map(i => `<span class="eg-item eg-scar">${escapeHtml(i)}</span>`).join('')}</div>` : ''}
        <div class="eg-foot">
            <span class="eg-muted">Сложность: ${E.DIFFICULTY[s.difficulty].ru}</span>
            <button class="eg-link" data-act="setup">Настройки игры</button>
            <button class="eg-link eg-danger" data-act="stop">Выключить</button>
        </div>`;
}

function peopleHtml(s) {
    const list = Object.values(s.npcs).map(n => E.ensureNpc(E.clone(n))).sort((a, b) => (b.present - a.present) || (b.seen - a.seen));
    if (!list.length) return '<p class="eg-muted">Пока никого. Знакомства появятся по ходу истории.</p>';
    return list.map(n => `
        <button class="eg-npc eg-npc-btn" style="--c:#${n.color}" data-card="${escapeHtml(n.name)}">
            <div class="eg-npc-head"><b>${escapeHtml(n.name)}</b>${n.present ? '<span class="eg-here">рядом</span>' : ''}<span class="eg-status">${escapeHtml(E.loveStatus(n))}</span></div>
            <div class="eg-mini">
                <span title="Доверие">🛡 ${n.trust}</span><span title="Привязанность">💞 ${n.affection}</span><span title="Влечение">💘 ${n.attraction}</span>
                ${n.lust >= 20 ? `<span title="Возбуждение">🔥 ${n.lust}</span>` : ''}
                ${E.INTIMACY.filter(x => n.firsts[x.id]).map(x => `<span title="${x.ru}">${x.icon}</span>`).join('')}
            </div>
        </button>`).join('') + '<p class="eg-muted">Нажми на персонажа, чтобы открыть карточку.</p>';
}

// ------------------------------------------------------------------ UI: character card (eroge-style)

function findNpc(state, name) {
    const q = String(name || '').trim().toLowerCase();
    if (!q) return null;
    const all = Object.values(state.npcs || {});
    return state.npcs?.[q] ?? all.find(n => n.name.toLowerCase() === q)
        ?? all.find(n => q.includes(n.name.toLowerCase()) || n.name.toLowerCase().includes(q.split(/\s+/)[0]));
}

function bar(label, icon, value, { min = 0, max = 100, cls = '' } = {}) {
    const pct = Math.round((value - min) / (max - min) * 100);
    return `<div class="eg-cbar ${cls}"><div class="eg-cbar-top"><span>${icon} ${label}</span><b>${value}</b></div><div class="eg-cbar-track"><i style="width:${Math.max(0, Math.min(100, pct))}%"></i></div></div>`;
}

function cardHtml(state, name) {
    const raw = findNpc(state, name);
    const ch = currentCharacter();
    const isMain = ch && !ch.group && (!raw || raw.name.toLowerCase().includes(String(ch.name).toLowerCase().split(/\s+/)[0]) || String(ch.name).toLowerCase().includes((raw?.name || '').toLowerCase()));
    const n = raw ? E.ensureNpc(E.clone(raw)) : E.ensureNpc({ name: name || ch?.name || '?', color: 'c3a6ff' });
    const avatar = isMain && ch?.avatarUrl ? `<img class="eg-card-ava" src="${ch.avatarUrl}" alt="">` : `<div class="eg-card-ava eg-card-ini" style="--c:#${n.color}">${escapeHtml(n.name.slice(0, 1).toUpperCase())}</div>`;
    const tier = E.tierOf(n.trust);
    const fmt = (iso) => { try { return E.timeRu(iso).split(',').slice(0, 2).join(','); } catch { return ''; } };
    const chips = (list, cls, empty) => list.length ? list.map(t => `<span class="eg-chip ${cls}">${escapeHtml(t)}</span>`).join('') : `<span class="eg-muted">${empty}</span>`;
    return `
        <div class="eg-card-hero" style="--c:#${n.color}">
            ${avatar}
            <div class="eg-card-who">
                <h3>${escapeHtml(n.name)}</h3>
                <div class="eg-card-tags"><span class="eg-status eg-status-big">${escapeHtml(raw ? E.loveStatus(n) : 'Ещё не знакомы')}</span><span class="eg-tier eg-tier-${tier.id}">${tier.ru}</span>${n.present ? '<span class="eg-here">рядом</span>' : ''}</div>
            </div>
        </div>
        <h4 class="eg-h eg-h-love">💗 Отношения</h4>
        ${bar('Доверие', '🛡', n.trust, { min: -100, cls: 'eg-c-trust' })}
        ${bar('Привязанность', '💞', n.affection, { cls: 'eg-c-aff' })}
        ${bar('Влечение', '💘', n.attraction, { cls: 'eg-c-attr' })}
        <h4 class="eg-h eg-h-nsfw">🔞 Близость</h4>
        ${bar('Возбуждение', '🔥', n.lust, { cls: `eg-c-lust ${n.lust >= 70 ? 'eg-hot' : ''}` })}
        ${bar('Раскрепощённость', '🔓', n.openness, { cls: 'eg-c-open' })}
        <div class="eg-firsts">${E.INTIMACY.map(x => `<div class="eg-first ${n.firsts[x.id] ? 'eg-got' : ''}"><span>${n.firsts[x.id] ? x.icon : '🔒'}</span><b>${x.ru}</b><small>${n.firsts[x.id] ? fmt(n.firsts[x.id]) : 'ещё нет'}</small></div>`).join('')}</div>
        <div class="eg-orgasms">💦 Оргазмов с тобой: <b>${n.orgasms}</b></div>
        <h4 class="eg-h">💗 Нравится</h4><div class="eg-chips">${chips(n.likes, 'eg-chip-like', 'узнаешь по ходу истории')}</div>
        <h4 class="eg-h">✨ Чувствительные места</h4><div class="eg-chips">${chips(n.spots, 'eg-chip-spot', 'ещё не найдены')}</div>
        <h4 class="eg-h">🚫 Границы</h4><div class="eg-chips">${chips(n.limits, 'eg-chip-limit', 'пока не обозначены')}</div>
        <p class="eg-muted eg-card-note">Шкалы растут от сцен и меняют поведение персонажа: кто тебе доверяет и хочет тебя, ведёт себя смелее, а уговорить его проще. Возбуждение остывает, если его не поддерживать.</p>
        ${isMain ? '<button class="menu_button eg-card-edit" data-card-edit="1"><i class="fa-solid fa-pen"></i> Карточка персонажа</button>' : ''}`;
}

export function openCard(name) {
    ensureSheets();
    const c = ctx();
    const state = currentState();
    const who = name || c.name2;
    const $b = $('#eg-card .eg-sheet-body').html(cardHtml(state, who));
    $b.find('[data-card-edit]').on('click', () => {
        closeEgSheets();
        $('#rightNavHolder .drawer-content').hasClass('openDrawer') || $('#rightNavHolder .drawer-toggle').first().trigger('click');
        setTimeout(() => $('#rm_button_selected_ch').trigger('click'), 60);
    });
    openEgSheet('eg-card');
    haptic('tick');
}

function goalsHtml(s) {
    const active = s.goals.filter(g => g.status === 'active');
    const closed = s.goals.filter(g => g.status !== 'active').slice(-5).reverse();
    const clocks = s.clocks;
    return `
        <h4 class="eg-h">Цели</h4>
        ${active.length ? active.map(g => `<div class="eg-goal">◆ ${escapeHtml(g.title)}</div>`).join('') : '<p class="eg-muted">Цели появятся, когда герой за что-то возьмётся.</p>'}
        <h4 class="eg-h">Часы</h4>
        ${clocks.length ? clocks.map(c => `<div class="eg-clock-row">${clockSvg(c, 34)}<div><b>${escapeHtml(c.name)}</b><small>${c.kind === 'threat' ? 'угроза' : 'прогресс'} · ${c.filled}/${c.size}</small></div></div>`).join('') : '<p class="eg-muted">Нет тикающих часов.</p>'}
        ${closed.length ? `<h4 class="eg-h">Завершено</h4>${closed.map(g => `<div class="eg-goal eg-goal-${g.status}">${g.status === 'done' ? '✔' : '✖'} ${escapeHtml(g.title)}</div>`).join('')}` : ''}`;
}

function logHtml(s) {
    if (!s.log.length) return '<p class="eg-muted">Бросков ещё не было.</p>';
    return s.log.map(r => {
        const o = E.OUTCOMES[r.outcome];
        return `<div class="eg-log-row" data-tone="${o.tone}">
            <span class="eg-log-dice">${r.dice[0]}·${r.dice[1]}</span>
            <div><b>${escapeHtml(r.label_ru || r.action_en)}</b><small>${E.SKILLS[r.skill].ru} ${r.mod >= 0 ? '+' : ''}${r.mod} · ${r.total}/${r.dc}${r.push ? ' · надавил' : ''}</small></div>
            <span class="eg-log-out">${o.ru}</span>
        </div>`;
    }).join('');
}

// ------------------------------------------------------------------ UI: setup

function openSetup(editing = false) {
    ensureSheets();
    const m = meta();
    const base = editing ? currentState() : (m?.initial ?? E.newState());
    const draft = { skills: { ...base.skills }, difficulty: base.difficulty, money: base.money, currency: base.currency, time: base.time };
    const BUDGET = 9;
    const spent = () => Object.values(draft.skills).reduce((a, b) => a + b, 0);
    const lastTracker = (() => {
        const chat = ctx().chat ?? [];
        for (let i = chat.length - 1; i >= 0; i--) { const t = E.parseTrackerLine(chat[i].mes); if (t) return t; }
        return null;
    })();
    if (!editing && lastTracker?.time) draft.time = lastTracker.time;

    const render = () => {
        const left = BUDGET - spent();
        $('#eg-setup .eg-sheet-body').html(`
            <h3 class="eg-title">🎲 ${editing ? 'Настройки игры' : 'Игровой режим'}</h3>
            ${editing ? '' : '<p class="eg-muted">Твой герой с навыками, ранами и целями; персонажи с отношениями; угрозы, которые растут. Движок считает, модель рассказывает.</p>'}
            <h4 class="eg-h">Навыки ${editing ? '' : `<small>осталось очков: ${left}</small>`}</h4>
            <p class="eg-muted">Навыки — это ты в истории: мир и персонажи замечают их в каждом ответе, а кубики решают спорные моменты. 1 — обычный, 0 — слабое место, 3 — то, чем тебя запомнят.</p>
            ${Object.entries(E.SKILLS).map(([k, sk]) => `
                <div class="eg-skill-row">
                    <span>${sk.icon} ${sk.ru}<small class="eg-skill-hint">${E.TRAITS[k]?.hint || ''}</small></span>
                    ${editing ? `<span class="eg-dots">${pips(draft.skills[k], 4, 'eg-dot')}</span>` : `
                    <button class="eg-step" data-k="${k}" data-d="-1" ${draft.skills[k] <= 0 ? 'disabled' : ''}>−</button>
                    <span class="eg-dots">${pips(draft.skills[k], 3, 'eg-dot')}</span>
                    <button class="eg-step" data-k="${k}" data-d="1" ${draft.skills[k] >= 3 || left <= 0 ? 'disabled' : ''}>+</button>`}
                </div>`).join('')}
            <h4 class="eg-h">Сложность</h4>
            <div class="eg-seg">${Object.entries(E.DIFFICULTY).map(([k, d]) => `<button class="eg-seg-btn ${draft.difficulty === k ? 'eg-on' : ''}" data-diff="${k}">${d.ru}</button>`).join('')}</div>
            <p class="eg-muted eg-small">${{ story: 'Проверки легче на 2, смерти нет.', standard: 'Честные шансы. Смерть — только после предупреждения.', brutal: 'Проверки тяжелее, мир безжалостнее.' }[draft.difficulty]}</p>
            ${editing ? '' : `
            <h4 class="eg-h">Старт</h4>
            <label class="eg-field">Дата и время в мире <input type="datetime-local" class="text_pole" id="eg_time" value="${draft.time}"></label>
            ${lastTracker ? '<p class="eg-muted eg-small">Взято из строки трекера в чате.</p>' : ''}
            <div class="eg-inline">
                <label class="eg-field">Деньги <input type="number" class="text_pole" id="eg_money" value="${draft.money}"></label>
                <label class="eg-field">Валюта <input type="text" class="text_pole" id="eg_cur" value="${escapeHtml(draft.currency)}" maxlength="6"></label>
            </div>`}
            <h4 class="eg-h">Интерфейс</h4>
            <label class="eg-check-opt"><input type="checkbox" id="eg_card" ${S().checkCard ? 'checked' : ''}><span>Карточка проверки с шансами (иначе бросок автоматически)</span></label>
            <label class="eg-check-opt"><input type="checkbox" id="eg_tracker" ${S().hideTracker ? 'checked' : ''}><span>Прятать строку трекера [🕐 | 📍 | 🌤] — её показывает HUD</span></label>
            <label class="eg-check-opt"><input type="checkbox" id="eg_juice" ${S().juice ? 'checked' : ''}><span>Эффекты: вибрация, вспышки, баннеры</span></label>
            ${hasHelper(stageSettings()) ? '' : '<p class="eg-warn">Служебная модель не выбрана (Сцена и арт / Elephant Memory) — судья работает по ключевым словам, а отношения и цели не отслеживаются.</p>'}
            <button class="eg-btn eg-btn-roll eg-wide" id="eg_start">${editing ? 'Сохранить' : 'Начать игру'}</button>`);
    };
    render();
    openEgSheet('eg-setup');

    $('#eg-setup .eg-sheet-body').off('click').on('click', '.eg-step', function () {
        const k = this.dataset.k;
        draft.skills[k] = Math.max(0, Math.min(3, draft.skills[k] + Number(this.dataset.d)));
        render();
    }).on('click', '.eg-seg-btn', function () {
        draft.difficulty = this.dataset.diff;
        render();
    }).on('click', '#eg_start', async () => {
        const s = S();
        s.checkCard = $('#eg_card').prop('checked');
        s.hideTracker = $('#eg_tracker').prop('checked');
        s.juice = $('#eg_juice').prop('checked');
        ctx().saveSettingsDebounced();
        const c = ctx();
        if (editing) {
            const st = currentState();
            st.difficulty = draft.difficulty;
            writeSnapshot(c.chat.length - 1, { state: st });
            await c.saveChat();
        } else {
            draft.time = $('#eg_time').val() || draft.time;
            draft.money = Number($('#eg_money').val()) || 0;
            draft.currency = $('#eg_cur').val() || '🪙';
            const initial = E.newState(draft);
            if (lastTracker?.location) initial.location = lastTracker.location;
            if (lastTracker?.weather) initial.weather = lastTracker.weather;
            c.chatMetadata[MODULE] = { active: true, initial, started: Date.now() };
            // Start from now: older messages keep no snapshots.
            if (c.chat.length) writeSnapshot(c.chat.length - 1, { state: initial });
            await c.saveMetadata();
            await c.saveChat();
            banner('Игра началась', 'gold');
        }
        closeEgSheets();
        renderHud();
        hideTrackerLines();
    });
}

// ------------------------------------------------------------------ tracker line

function hideTrackerLines() {
    const on = isActive() && S().hideTracker;
    document.querySelectorAll('#chat .mes .mes_text').forEach((el) => {
        const first = el.firstElementChild;
        if (!first) return;
        const isTracker = /^\s*\[\s*🕐/u.test(first.textContent || '');
        first.classList.toggle('eg-tracker-hidden', on && isTracker);
    });
}

// ------------------------------------------------------------------ hub / commands / init

function addHubTile() {
    const $tiles = $('#et-sheet-hub .et-tiles');
    if (!$tiles.length || $tiles.find('[data-eg-tile]').length) return;
    const $t = $('<button class="et-tile" data-eg-tile><i class="fa-solid fa-dice-d20"></i><span>Игра</span></button>');
    $t.on('click', () => {
        globalThis.ElephantStage?.closeSheets?.(true);
        if (isActive()) openStateSheet('hero'); else openSetup(false);
    });
    $tiles.prepend($t);
}

function registerCommands() {
    const c = ctx();
    if (!c.SlashCommandParser || !c.SlashCommand) return;
    const add = (name, help, fn) => c.SlashCommandParser.addCommandObject(c.SlashCommand.fromProps({ name, helpString: help, callback: fn }));
    add('game', 'Elephant Game: открыть игровой режим (настройка или лист героя).', async () => { if (isActive()) openStateSheet('hero'); else openSetup(false); return ''; });
    add('game-roll', 'Elephant Game: проверка вручную. Пример: /game-roll finesse 8 pick the lock', async (_a, value) => {
        const [skill = 'insight', dc = '8', ...rest] = String(value || '').split(/\s+/);
        const st = currentState();
        const v = { check: true, skill, dc: Number(dc), action_en: rest.join(' ') || 'act', label_ru: rest.join(' ') || 'Проверка', position: 'risky' };
        const choice = await showCheckCard(st, v);
        if (choice.cancel) return '';
        const { state, record } = E.resolveCheck(st, v, { push: choice.push, dice: choice.dice });
        writeSnapshot(ctx().chat.length - 1, { state });
        await ctx().saveChat();
        renderHud(state);
        showNotes(record.notes);
        return E.OUTCOMES[record.outcome].en;
    });
}

function refresh() {
    renderHud();
    hideTrackerLines();
    if (!isActive()) clearNarratorBlock();
}

function patchBack() {
    const st = globalThis.ElephantStage;
    if (!st || st.__egBack) return;
    const original = st.handleBack;
    st.handleBack = () => {
        if ($('#eg-check').hasClass('eg-open')) return true; // the roll must be answered
        if (closeEgSheets()) return true;
        return original();
    };
    st.__egBack = true;
}

export async function init() {
    S();
    const c = ctx();
    const ev = c.eventSource;
    const et = c.eventTypes ?? c.event_types;
    ev.on(et.CHAT_CHANGED, () => setTimeout(refresh, 50));
    ev.on(et.MESSAGE_RECEIVED, (id, type) => { if (type !== 'impersonate' && type !== 'extension') onReply(Number(id)); });
    for (const e of [et.MESSAGE_SWIPED, et.MESSAGE_DELETED, et.MESSAGE_EDITED, et.MESSAGE_UPDATED]) if (e) ev.on(e, () => setTimeout(refresh, 30));
    for (const e of [et.CHARACTER_MESSAGE_RENDERED, et.USER_MESSAGE_RENDERED, et.MORE_MESSAGES_LOADED]) if (e) ev.on(e, () => setTimeout(hideTrackerLines, 0));
    registerCommands();
    ensureSheets();
    addHubTile();
    setTimeout(() => { addHubTile(); patchBack(); }, 1500);
    globalThis.ElephantGame = { isActive, ownsScene: isActive, currentState, openSetup, openStateSheet, openCard, engine: E };
    refresh();
    log('game mode ready');
}
