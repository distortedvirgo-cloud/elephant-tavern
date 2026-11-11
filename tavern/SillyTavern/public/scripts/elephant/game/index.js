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
import { ctx, callHelper, hasHelper, memoryState, haptic, log, toast, currentCharacter, whenRevealed, personaText } from '../stage/helper.js';
import * as E from './engine.js';
import * as X from './encounter.js';
import * as P from './prompts.js';
import { openPrompts } from './prompts-ui.js';

const $ = (...a) => globalThis.jQuery(...a);
const MODULE = 'elephant_game';
const PROMPT_KEY = 'elephant_game';

const DEFAULTS = {
    checkCard: true,     // show the card and wait for the tap; off = roll automatically
    hideTracker: true,   // hide the preset's "[ 🕐 … ]" line — the HUD shows it
    juice: true,
    encMin: false,       // encounter panel collapsed to one row
    autoStart: true,     // new chats start in game mode on their own
    prompts: {},         // the player's edited prompt texts, by id
    promptsAll: false,   // let the player edit the JSON formats too
};

function S() {
    const es = ctx().extensionSettings;
    es[MODULE] ??= structuredClone(DEFAULTS);
    for (const [k, v] of Object.entries(DEFAULTS)) if (es[MODULE][k] === undefined) es[MODULE][k] = structuredClone(v);
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
        if (snap) return E.ensureState(E.clone(snap));
    }
    return E.ensureState(E.clone(meta()?.initial ?? E.newState()));
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

/** Engine block + the encounter round (when one was just resolved). */
function fullBlock(state, opts = {}) {
    const name = ctx().name1;
    const enc = X.encounterBlock(state, name);
    return E.narratorBlock(state, { userName: name, ...opts }) + (enc ? `\n${enc}` : '');
}

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
            setNarratorBlock(fullBlock(currentStateForGeneration(type)));
            return;
        }
        const userMsg = chat[ui];
        const isLastUser = ui === chat.length - 1;
        const regen = type === 'swipe' || type === 'regenerate';
        const existing = userMsg.extra?.elephant_game;

        // Swipes and regenerations never reroll: the dice already fell.
        if ((regen || type === 'continue') && existing?.checked) {
            setNarratorBlock(fullBlock(existing.state ?? stateAt(ui), { record: existing.record, events: existing.record?.events ?? [] }));
            return;
        }
        if (!isLastUser || existing?.checked) {
            setNarratorBlock(fullBlock(currentStateForGeneration(type)));
            return;
        }

        const before = stateAt(ui - 1);
        const text = String(userMsg.mes || '').trim();
        if (before.enc?.status === 'active') {
            const res = await encounterTurn(before, text, lastNarrationBefore(chat, ui));
            if (res.round) journal(res.state, res.round.notes);
            writeSnapshot(ui, { checked: true, state: res.state, encRound: res.round });
            await c.saveChat();
            setNarratorBlock(fullBlock(res.state));
            renderHud(res.state);
            renderEnc(res.state, { resolved: res.round });
            if (res.round) showNotes(res.round.notes);
            if (res.state.enc?.defeat) {
                const go = await handleDefeat(ui, res.state);
                if (!go) { clearNarratorBlock(); abort(true); }
            }
            return;
        }
        let verdict = null;
        if (text.length >= 6 && !/^\(\(|^\[ooc|^ooc:/i.test(text) && worthRefereeing(text)) {
            setHudBusy(true);
            verdict = await referee(before, lastNarrationBefore(chat, ui), text);
            setHudBusy(false);
        }

        if (!verdict?.check) {
            writeSnapshot(ui, { checked: true, state: before });
            setNarratorBlock(fullBlock(before));
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
        const { state, record } = E.resolveCheck(before, verdict, { push: choice.push, dice: choice.dice, rerolled: choice.rerolled });
        journal(state, record.notes);
        writeSnapshot(ui, { checked: true, state, record });
        await c.saveChat();
        afterCheck(record, state);
        setNarratorBlock(fullBlock(state, { record, events: record.events }));
        renderHud(state);
        if (record.events.some(e => e.kind === 'defeat')) {
            const go = await handleDefeat(ui, state);
            if (!go) { clearNarratorBlock(); abort(true); }
        }
    } catch (e) {
        setHudBusy(false);
        log('interceptor failed', e);
        setNarratorBlock(fullBlock(currentState()));
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
            (E.setPersona(personaText()), E.refereePrompt({ state, lastNarration: narration, action, user: c.name1, char: c.name2 })), 260, { json: true });
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

/** Adds what just happened to the journal the player can read (Журнал → События). */
function journal(state, notes) {
    const lines = noteLines(notes, state);
    if (lines.length) state.journal = [...(state.journal || []), ...lines.map(l => ({ turn: state.turn, time: state.time, text: l.text, sub: l.sub || '', tone: l.tone }))].slice(-80);
    return state;
}

/** Old saves have no price scale: ask the helper once (twice at most) and keep it. */
let econBusy = false;
async function fetchEcon(st) {
    const m = meta();
    if (econBusy || !m || (m.econTried || 0) >= 2) return null;
    econBusy = true;
    m.econTried = (m.econTried || 0) + 1;
    try {
        const out = await callHelper(stageSettings(), 'You set up a story world. Output only JSON.',
            P.render('econ', { user: ctx().name1, setting: setting(), currency: st.currency, money: st.money, format: P.render('econ_format') }), 80, { json: true });
        const j = E.parseJsonLine(out);
        return j && Number(j.meal) > 0 && Number(j.day_wage) > 0 ? { meal: j.meal, day: j.day_wage } : null;
    } catch (e) { log('econ failed', e); return null; } finally { econBusy = false; }
}

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
            const econP = base.econ ? null : fetchEcon(base);
            const out = await callHelper(ss, 'You are a meticulous game-state tracker. Output only JSON.',
                (E.setPersona(personaText()), E.extractorPrompt)({ state: base, userText: ui >= 0 ? c.chat[ui].mes : '', reply: msg.mes, user: c.name1, char: c.name2, memoryState: memoryState() }), 700, { json: true });
            const econ = econP ? await econP : null;
            if (econ) E.setEcon(base, econ.meal, econ.day);
            report = E.parseJsonLine(out);
        } catch (e) {
            log('extractor failed', e);
        } finally {
            setHudBusy(false);
        }
    }
    // A swipe may have arrived meanwhile; only write to the message we read.
    if (c.chat[mesId] !== msg) return;
    const voices = globalThis.ElephantCore?.voices;
    if (report && base.enc?.kind === 'combat') report.harm = 0; // the round already dealt it
    if (report && base.enc) report.encounter = null;
    let { state, notes, events } = E.applyReport(base, report, { trackerLine: tracker, colors: voices ? (name) => voices.colorFor(name, { assign: false }) : null, userName: c.name1 });
    if (voices) for (const n of Object.values(state.npcs)) voices.adopt(n.name, n.color);
    // an encounter that ended in this reply is archived; an active one waits for its next cards
    let finished = null;
    if (state.enc && state.enc.status !== 'active') {
        finished = state.enc;
        state.lastEnc = { variant: finished.variant, partner: finished.partner, status: finished.status, result: finished.result, turn: state.turn };
        state.enc = null;
    }
    journal(state, notes);
    writeSnapshot(mesId, { state, notes, events });
    await c.saveChat();
    // Toasts, banners and the HUD change land with the (translated) text, not before it.
    await whenRevealed();
    renderHud(state);
    showNotes(notes);
    for (const ev of events) {
        if (ev.kind === 'clock_full') banner(ev.clock.kind === 'threat' ? `⏳ ${ev.clock.name}` : `🏁 ${ev.clock.name}`, ev.clock.kind === 'threat' ? 'bad' : 'gold');
        if (ev.kind === 'defeat') handleDefeat(mesId, state, ui >= 0 ? ui : mesId);
    }
    if (notes.some(n => n.kind === 'goal_done')) banner('Цель выполнена', 'gold');
    if (notes.some(n => n.kind === 'level')) banner(`Уровень ${state.level}! ${E.titleOf(state.level)}`, 'gold');
    else if (notes.some(n => n.kind === 'stage')) { const st = notes.filter(n => n.kind === 'stage').at(-1); banner(`${E.STAGES[st.stage].icon} ${E.STAGES[st.stage].ru}`, 'gold'); }

    if (finished) { renderEnc(null); showEncResult(finished); }
    else if (state.enc) nextEncCards(mesId, msg.mes);
    else {
        renderEnc(null);
        const sug = report?.encounter;
        if (sug?.kind === 'nsfw' && sug.by === 'char' && sug.forced) startEncounterFlow('nsfw', sug.partner, null, { forced: true });
        else if (sug?.kind) offerEncounter(sug, mesId);
    }
    if (!state.enc) maybeOfferQuest(mesId);
    maybeSchedule(mesId);

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

// ------------------------------------------------------------------ encounters (intimate scenes & fights)

let pendingRound = null; // { text, option, dice } — set by a card tap, consumed by beforeGenerate
let encSuggestion = null; // { kind, partner, mesId }

function setting() {
    const ch = currentCharacter();
    const st = currentState();
    return `${ch?.name || ''}: ${String(ch?.description || '').slice(0, 500)}${st.era ? ` · ${st.era}` : ''}${st.location ? ` · ${st.location}` : ''}`;
}

/** Resolves the round for this user message: a tapped card, or the player's own words classified. */
async function encounterTurn(before, text, narration) {
    if (pendingRound && pendingRound.text.trim() === text.trim()) {
        const p = pendingRound;
        pendingRound = null;
        const res = X.resolveRound(before, p.option, { dice: p.dice, focus: p.focus });
        showDeltas(res.round);
        return res;
    }
    pendingRound = null;
    let option = null;
    const ss = stageSettings();
    if (hasHelper(ss)) {
        setHudBusy(true);
        try {
            const out = await callHelper(ss, 'You classify moves in a mini-game. Output only JSON.', X.classifyPrompt({ state: before, action: text, narration, user: ctx().name1 }), 200, { json: true });
            option = E.parseJsonLine(out);
        } catch (e) { log('classify failed', e); }
        setHudBusy(false);
    }
    option ??= { ru: text.slice(0, 40), en: text, skill: before.enc.kind === 'nsfw' ? 'passion' : 'might', power: 2, kind: before.enc.kind === 'nsfw' ? 'act' : 'attack' };
    const res = X.resolveRound(before, option, { free: true });
    const o = E.OUTCOMES[res.round.outcome];
    toastEnc(`${E.SKILLS[res.round.option.skill]?.icon || '🎲'} ${res.round.option.ru}: ${o.ru} (${res.round.dice.join('·')})`, o.tone);
    showDeltas(res.round, 700);
    return res;
}

function showDeltas(rec, delay = 0) {
    const line = X.deltaLine(rec);
    if (!line) return;
    const bad = ['fail', 'disaster', 'near'].includes(rec.outcome);
    setTimeout(() => toastEnc(line, bad ? 'bad' : 'good'), delay);
}

function toastEnc(text, tone = 'info') {
    ensureSheets();
    const el = $(`<div class="eg-toast" data-tone="${tone}"><b>${escapeHtml(text)}</b></div>`);
    $('#eg-toasts').append(el);
    setTimeout(() => el.addClass('eg-out'), 2600);
    setTimeout(() => el.remove(), 3100);
}

/** After a reply during an encounter: the partner's next move and four fresh cards. */
async function nextEncCards(mesId, narration) {
    const ss = stageSettings();
    renderEnc(stateAt(mesId), { loading: true });
    if (!hasHelper(ss)) { renderEnc(stateAt(mesId)); return; }
    try {
        const st0 = stateAt(mesId);
        const out = await callHelper(ss, 'You design moves for a mini-game inside a story. Output only JSON.', X.nextPrompt({ state: st0, narration, user: ctx().name1 }), 700, { json: true });
        const j = E.parseJsonLine(out);
        if (ctx().chat?.[mesId]?.mes !== narration) return; // swiped meanwhile
        const st = stateAt(mesId);
        if (!st.enc) return;
        st.enc.intent = X.cleanIntent(j?.intent) ?? st.enc.intent;
        if (j?.pose_ru) st.enc.pose = String(j.pose_ru).slice(0, 60);
        st.enc.options = X.cleanOptions(j?.options, st.enc.kind);
        if (Array.isArray(j?.participants) && j.participants.length) {
            st.enc.participants = X.cleanParticipants(j.participants, st.enc.kind, st, st.enc.participants);
            if (!st.enc.participants.some(p => p.name === st.enc.target)) st.enc.target = X.defaultTarget(st.enc);
        }
        writeSnapshot(mesId, { state: st });
        await ctx().saveChat();
        renderEnc(st);
    } catch (e) {
        log('next cards failed', e);
        renderEnc(stateAt(mesId));
    }
}

/** A reply that ends as sex or a fight begins: a chip above the input offers the mini-game. */
function offerEncounter(sug, mesId) {
    if (!['nsfw', 'combat'].includes(sug.kind)) return;
    encSuggestion = { ...sug, mesId };
    ensureEncDom();
    const nsfw = sug.kind === 'nsfw';
    const proposed = nsfw && sug.by === 'char';
    $('#eg-enc-chip').html(proposed
        ? `<button class="eg-enc-chip" data-act="enc-start">💗 ${escapeHtml(sug.partner || 'Она')} предлагает… <small>согласиться — сцена по раундам</small></button><button class="eg-enc-chip-x eg-decline" data-act="enc-decline">Отказать</button>`
        : `<button class="eg-enc-chip" data-act="enc-start">${nsfw ? '💗' : '⚔️'} ${nsfw ? `Сцена близости${sug.partner ? ` с ${escapeHtml(sug.partner)}` : ''}` : `Бой${sug.partner ? `: ${escapeHtml(sug.partner)}` : ''}`} <small>играть по раундам</small></button><button class="eg-enc-chip-x" data-act="enc-dismiss">✕</button>`).addClass('eg-show');
    if (S().juice) haptic('tick');
}

function clearEncChip() { $('#eg-enc-chip').removeClass('eg-show').empty(); encSuggestion = null; }

/** Sets up an encounter: the helper picks the variation, her hidden tastes and the first cards. */
async function startEncounterFlow(kind, partner, variant = null, { forced = false } = {}) {
    const c = ctx();
    const ss = stageSettings();
    const chat = c.chat ?? [];
    const idx = chat.length - 1;
    if (idx < 0) return;
    clearEncChip();
    let st = currentState();
    if (st.enc?.status === 'active') { renderEnc(st); return; }
    const who = partner || (kind === 'nsfw' ? (Object.values(st.npcs).find(n => n.present)?.name || c.name2) : '');
    renderEnc({ enc: { kind, variant: variant || (kind === 'nsfw' ? 'duet' : 'fight'), partner: who, bars: {}, options: [], status: 'active', round: 0, title_ru: 'Готовлю сцену…' } }, { loading: true });
    let setup = {};
    if (hasHelper(ss)) {
        try {
            const ch = currentCharacter();
            const out = await callHelper(ss, 'You set up a mini-game inside a story. Output only JSON.', X.startPrompt({ state: st, kind, partner: who, narration: chat[idx]?.mes || '', card: `${ch?.description || ''}\n${ch?.personality || ''}`, user: c.name1, char: c.name2, forced }), 1400, { json: true });
            setup = E.parseJsonLine(out) || {};
        } catch (e) { log('encounter setup failed', e); }
    }
    st = currentState();
    const vs = kind === 'nsfw' ? X.NSFW_VARIANTS : X.COMBAT_VARIANTS;
    const next = X.startEncounter(st, {
        kind,
        variant: variant || (vs.includes(setup.variant) ? setup.variant : vs[0]),
        partner: setup.partner || who,
        power: setup.power, role: setup.role, prefs: setup.prefs, title_ru: setup.title_ru, forced, pose_ru: setup.pose_ru,
        intent: setup.intent, options: setup.options, participants: setup.participants,
    });
    writeSnapshot(idx, { state: next });
    await c.saveChat();
    renderHud(next);
    renderEnc(next);
    if (!next.enc.options.length) nextEncCards(idx, chat[idx]?.mes || '');
    const v = X.VARIANTS[next.enc.variant];
    banner(forced ? `${v.icon} Она не спрашивает` : `${v.icon} ${v.ru}`, forced ? 'bad' : 'gold');
}

async function endEncounter() {
    const ok = await ctx().Popup.show.confirm('Закончить сцену?', 'Мини-игра закроется, история пойдёт как обычно.');
    if (!ok) return;
    const idx = (ctx().chat?.length ?? 1) - 1;
    const st = currentState();
    st.enc = null;
    writeSnapshot(idx, { state: st });
    await ctx().saveChat();
    pendingRound = null;
    renderEnc(null);
}

function ensureEncDom() {
    if (document.getElementById('eg-enc')) return;
    $('#form_sheld').prepend('<div id="eg-enc-chip"></div><section id="eg-enc" aria-live="polite"></section>');
    $('#eg-enc-chip').on('click', '[data-act="enc-start"]', () => { const s0 = encSuggestion; if (s0) startEncounterFlow(s0.kind, s0.partner); })
        .on('click', '[data-act="enc-dismiss"]', clearEncChip)
        .on('click', '[data-act="enc-decline"]', () => {
            clearEncChip();
            const $ta = $('#send_textarea');
            if (!$ta.val()) $ta.val('*I gently stop her.* "Not tonight."').trigger('input').trigger('focus');
        });
    $('#eg-enc').on('click', '[data-act="enc-end"]', endEncounter)
        .on('click', '[data-act="enc-focus"]', () => { encFocus = !encFocus; renderEnc(currentState()); haptic('tick'); })
        .on('click', '[data-act="enc-min"]', () => { S().encMin = !S().encMin; ctx().saveSettingsDebounced(); renderEnc(currentState()); haptic('tick'); })
        .on('click', '[data-act="tgt-add"]', function () {
            const st = currentState();
            const name = (window.prompt('Кого добавить в сцену? (имя)') || '').trim();
            if (!st.enc || !name) return;
            const side = st.enc.kind === 'nsfw' ? 'partner' : (window.confirm('«ОК» — союзник, «Отмена» — враг') ? 'ally' : 'enemy');
            const next = X.addTarget(st, name, side);
            writeSnapshot((ctx().chat?.length ?? 1) - 1, { state: next });
            renderEnc(next);
        })
        .on('click', '[data-tgt]', function () {
            const st = currentState();
            if (!st.enc) return;
            const next = X.setTarget(st, this.dataset.tgt);
            writeSnapshot((ctx().chat?.length ?? 1) - 1, { state: next });
            renderEnc(next);
            haptic('tick');
        })
        .on('click', '[data-opt]', function () { playCard(Number(this.dataset.opt)); })
        .on('click', '[data-act="enc-variant"]', switchVariant);
}

async function switchVariant() {
    const st = currentState();
    if (!st.enc || st.enc.round > 0) return;
    const vs = st.enc.kind === 'nsfw' ? X.NSFW_VARIANTS : X.COMBAT_VARIANTS;
    const next = vs[(vs.indexOf(st.enc.variant) + 1) % vs.length];
    const idx = (ctx().chat?.length ?? 1) - 1;
    const fresh = X.startEncounter({ ...st, enc: null }, { kind: st.enc.kind, variant: next, partner: st.enc.partner, power: st.enc.power, role: st.enc.role, intent: st.enc.intent, options: st.enc.options });
    writeSnapshot(idx, { state: fresh });
    await ctx().saveChat();
    renderEnc(fresh);
    haptic('tick');
}

function encBar(key, value, enc) {
    const b = X.BARS[key];
    const min = b.min ?? 0;
    const max = b.max ?? 100;
    const pct = Math.round((value - min) / (max - min) * 100);
    const hot = (key === 'her' || key === 'you') && value >= 75;
    return `<div class="eg-ebar eg-eb-${key} ${hot ? 'eg-hot' : ''}"><span>${b.icon}</span><div class="eg-ebar-track">${key === 'control' ? '<b class="eg-mid"></b>' : ''}<i style="width:${Math.max(0, Math.min(100, pct))}%"></i></div><em>${b.ru}</em></div>`;
}

function renderEnc(st, { loading = false, resolved = null } = {}) {
    ensureEncDom();
    const $p = $('#eg-enc');
    const enc = st?.enc;
    document.body.classList.toggle('eg-in-enc', Boolean(enc));
    if (!enc || !isActive()) { $p.removeClass('eg-show').empty(); return; }
    clearEncChip();
    const v = X.VARIANTS[enc.variant];
    const B = { ...enc.bars };
    if (v.bars.includes('harm')) B.harm = 3 - (st.harm ?? 0);
    if (v.bars.includes('stress')) B.stress = E.energyOf(st);
    const energy = E.energyOf(st);
    if (!energy) encFocus = false;
    const bars = v.bars.filter(k => B[k] != null).map(k => encBar(k, B[k], enc)).join('');
    const P = enc.participants || [];
    const tgt = X.targetOf(enc);
    const min = Boolean(S().encMin);
    const chip = (p) => `<button class="eg-tgt${p.name === enc.target ? ' eg-on' : ''}${p.bar <= 0 && p.side !== 'partner' ? ' eg-down' : ''}" data-tgt="${escapeHtml(p.name)}">${p.side === 'ally' ? '🛡' : p.side === 'partner' ? '💗' : '👹'} ${escapeHtml(p.name)}${E.status.listOf(p).map(x => ` <em class="eg-cond">${E.status.STATUSES[x.id].icon}${x.left}</em>`).join('')} <i class="eg-tgt-bar"><b style="width:${Math.max(0, Math.min(100, p.side === 'ally' ? p.bar : p.bar))}%"></b></i></button>`;
    const targets = enc.status === 'active' ? `<div class="eg-tgts"><span>🎯</span>${P.map(chip).join('')}<button class="eg-tgt eg-tgt-add" data-act="tgt-add" aria-label="Добавить цель">+</button></div>` : '';
    const topBars = (v.bars.filter(k => B[k] != null).slice(0, 2)).map(k => { const b = X.BARS[k]; const mn = b.min ?? 0, mx = b.max ?? 100; return `<i class="eg-thin eg-eb-${k}" title="${b.ru}"><b style="width:${Math.max(0, Math.min(100, Math.round((B[k] - mn) / (mx - mn) * 100)))}%"></b></i>`; }).join('');
    const waiting = loading || (!enc.options?.length && enc.status === 'active');
    const cards = waiting
        ? `<div class="eg-enc-wait"><i class="fa-solid fa-dice fa-spin"></i> ${resolved ? 'Раунд разыгран — ждём ответ…' : enc.round ? 'Готовлю следующий ход…' : 'Готовлю сцену…'}</div>`
        : enc.options.map((o, i) => {
            const set = X.optionSetup(st, o, { focus: encFocus });
            const pct = Math.round(set.odds.atLeastSuccess * 100);
            const fx = X.previewOption(st, o);
            return `<button class="eg-ecard eg-ek-${o.kind}${o.say ? ' eg-say' : ''}${set.edge ? ' eg-edge' : ''}" data-opt="${i}">
                <b class="eg-elabel">${o.say ? '💬 ' : ''}${escapeHtml(o.ru)}</b>
                ${o.detail_ru ? `<span class="eg-edetail">${escapeHtml(o.detail_ru)}</span>` : o.risk_ru ? `<span class="eg-erisk">${escapeHtml(o.risk_ru)}</span>` : ''}
                ${fx.length ? `<span class="eg-efx">${fx.map(x => `<i>${escapeHtml(x)}</i>`).join('')}</span>` : ''}
                <small>${E.SKILLS[o.skill]?.icon || ''} <b class="eg-pct" data-p="${pct >= 70 ? 'hi' : pct >= 45 ? 'mid' : 'lo'}">${pct}%</b>${set.locked ? ' · 🔒 рано' : ''}${set.blocked ? ` · ⛓ ${escapeHtml(set.blocked)}` : ''}${set.open ? ' · 🎯 беззащитен' : ''}${o.inflict ? ` · ${E.status.STATUSES[o.inflict].icon}` : ''}${o.limit ? ' · ⚠️' : ''} <span class="eg-pow">${'•'.repeat(o.power)}</span></small>
            </button>`;
        }).join('');
    if (min) {
        $p.toggleClass('eg-min', true).html(`<button class="eg-enc-mini" data-act="enc-min" aria-label="Развернуть"><span>${v.icon}</span><b>${escapeHtml(enc.title_ru || v.ru)}</b><small>${enc.round ? `р.${enc.round + (resolved ? 0 : 1)}` : ''}${enc.pose ? ` · ${escapeHtml(enc.pose)}` : ''}</small><span class="eg-thins">${topBars}</span><em>▴</em></button>`).addClass('eg-show');
        return;
    }
    $p.removeClass('eg-min');
    $p.html(`
        <div class="eg-enc-head">
            <button class="eg-enc-title" data-act="enc-min"><span>${v.icon}</span><b>${escapeHtml(enc.title_ru || v.ru)}</b><small>${enc.round ? `раунд ${enc.round + (resolved ? 0 : 1)}` : ''}</small></button>
            <button class="eg-enc-fold" data-act="enc-min" aria-label="Свернуть">▾</button>
            ${!enc.round && !loading ? `<button class="eg-link eg-small" data-act="enc-variant" title="${escapeHtml(v.hint)}">${v.ru} ↻</button>` : ''}
            <button class="eg-enc-x" data-act="enc-end" aria-label="Закончить">✕</button>
        </div>
        <div class="eg-ebars">${bars}</div>
        ${enc.pose ? `<div class="eg-pose">${enc.kind === 'nsfw' ? '🌀' : '📍'} ${escapeHtml(enc.pose)}</div>` : ''}
        ${enc.forced ? `<div class="eg-forced">⚠️ ${escapeHtml(enc.partner)} не спрашивает${enc.escape ? ' · ты почти вырвался' : ' · вырваться: 2 удачных рывка'}</div>` : ''}
        ${enc.intent && !loading ? `<div class="eg-intent">${enc.kind === 'nsfw' ? '💭' : '⚠️'} <b>${escapeHtml(enc.intent.who || enc.partner)}:</b> ${escapeHtml(enc.intent.ru)}</div>` : ''}
        ${E.status.listOf(st).length ? `<div class="eg-forced">${E.status.chips(st).map(c => `${c.icon} ${c.ru} (${c.left})`).join(' · ')} — ${escapeHtml((E.status.chips(st).find(c => E.status.STATUSES[c.id].block) || E.status.chips(st)[0]).cure)}</div>` : ''}
        ${enc.edge && !waiting ? `<div class="eg-edge-line">⚡ Преимущество: следующий ${enc.kind === 'nsfw' ? 'шаг' : 'удар'} легче и в полтора раза сильнее</div>` : ''}
        ${waiting ? '' : targets}
        <div class="eg-ecards">${cards}</div>
        ${waiting ? '' : `<div class="eg-enc-tools"><button class="eg-focus${encFocus ? ' eg-on' : ''}" data-act="enc-focus" ${energy ? '' : 'disabled'}>⚡ Собраться <small>+2 к броску · −1 сила (${energy})</small></button></div><div class="eg-enc-foot">или напиши своё действие — кубик бросится сам</div>`}`).addClass('eg-show');
}

/** A tapped card: roll right in the panel, then send the move as the player's message. */
let encFocus = false; // "Собраться" is armed for the next card
async function playCard(i) {
    const st = currentState();
    const o = st.enc?.options?.[i];
    if (!o || $('#eg-enc').hasClass('eg-rolling')) return;
    const set = X.optionSetup(st, o, { focus: encFocus });
    const dice = E.rollDice(Math.random, set.adv ? 3 : 2);
    const outcome = E.classifyDice(dice, set.mod, set.dc, 'risky', { lucky: set.lucky });
    const tone = E.OUTCOMES[outcome].tone;
    const faces = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
    const $p = $('#eg-enc').addClass('eg-rolling');
    globalThis.ElephantStage?.sound?.play('dice');
    $p.find('.eg-ecards').html(`<div class="eg-enc-roll"><span class="eg-mini-dice">${dice.map(() => '<i>⚀</i>').join('')}</span><b>${escapeHtml(o.ru)}</b><em></em>${o.detail_ru ? `<small class="eg-detail">${escapeHtml(o.detail_ru)}</small>` : ''}</div>`);
    if (S().juice) haptic('tick');
    await new Promise((res) => {
        let n = 0;
        const t = setInterval(() => {
            $p.find('.eg-mini-dice i').each(function () { this.textContent = faces[Math.floor(Math.random() * 6)]; });
            if (++n >= 8) { clearInterval(t); res(); }
        }, 60);
    });
    $p.find('.eg-mini-dice i').each(function (k) { this.textContent = faces[dice[k] - 1]; });
    $p.find('.eg-enc-roll em').attr('data-tone', tone).text(E.OUTCOMES[outcome].ru);
    juiceOutcome(outcome);
    await new Promise(r => setTimeout(r, 700));
    $p.removeClass('eg-rolling');
    const sendText = X.aimText(st.enc, o.en);
    pendingRound = { text: sendText, option: o, dice, focus: set.focus };
    encFocus = false;
    const $ta = $('#send_textarea');
    $ta.val(sendText).trigger('input');
    $('#send_but').trigger('click');
}

function showEncResult(enc) {
    ensureSheets();
    const v = X.VARIANTS[enc.variant];
    const r = enc.result || {};
    const head = {
        won: enc.kind === 'nsfw' ? (enc.variant === 'duel' ? 'Победа!' : enc.variant === 'her_lead' ? 'Она довольна' : 'Блаженство') : enc.variant === 'chase' ? (enc.role === 'chaser' ? 'Догнал!' : 'Оторвался!') : 'Победа!',
        early: 'Слишком рано…', lost: enc.kind === 'nsfw' ? (enc.variant === 'your_lead' ? 'Она остановила сцену' : 'Она победила') : 'Поражение', draw: 'Вместе!', fled: enc.kind === 'nsfw' ? 'Ты вырвался' : 'Удалось уйти', ended: 'Сцена окончена',
    }[enc.status] || 'Конец';
    const stars = enc.kind === 'nsfw' ? `<div class="eg-stars">${[0, 1, 2].map(i => `<span class="${i < r.stars ? 'on' : ''}">★</span>`).join('')}</div>` : '';
    const found = enc.found?.length ? `<div class="eg-chips">${enc.found.map(f => `<span class="eg-chip ${f.kind === 'dislike' ? 'eg-chip-limit' : f.kind === 'spot' ? 'eg-chip-spot' : 'eg-chip-like'}">${f.kind === 'spot' ? '✨' : f.kind === 'like' ? '💗' : '👎'} ${escapeHtml(X.TAGS[f.tag])}</span>`).join('')}</div>` : '';
    const rel = r.rel && Object.keys(r.rel).length ? `<p class="eg-muted">${Object.entries(r.rel).filter(([, x]) => x).map(([k, x]) => `${{ affection: '💞', attraction: '💘', trust: '🛡' }[k]} ${x > 0 ? '+' : ''}${x}`).join(' · ')}</p>` : '';
    $('#eg-card .eg-sheet-body').html(`
        <div class="eg-result" data-status="${enc.status}">
            <div class="eg-result-ico">${v.icon}</div>
            <h3>${head}</h3>
            <p class="eg-muted">${escapeHtml(enc.title_ru || v.ru)} · ${enc.round} ${enc.round === 1 ? 'раунд' : enc.round < 5 ? 'раунда' : 'раундов'}</p>
            ${stars}
            ${enc.kind === 'nsfw' ? `<div class="eg-bigstats eg-bigstats-3"><div><b>${enc.herPeaks}</b><small>💦 её оргазмов</small></div><div><b>${enc.together ? '✓' : '—'}</b><small>вместе</small></div><div><b>+${r.xp || 0}</b><small>опыта</small></div></div>` : `<div class="eg-bigstats eg-bigstats-3"><div><b>+${r.xp || 0}</b><small>опыта</small></div></div>`}
            ${found ? `<h4 class="eg-h">Открыто о ней</h4>${found}` : ''}
            ${rel}
        </div>`);
    openEgSheet('eg-card');
    if (S().juice) banner(head, ['won', 'draw', 'fled'].includes(enc.status) ? 'gold' : 'bad');
}

// ------------------------------------------------------------------ the world offers side quests

let questBusy = false;
async function maybeOfferQuest(mesId) {
    const st = stateAt(mesId);
    const open = (st.offers || []).filter(o => o.status === 'offered' || o.status === 'taken').length;
    if (questBusy || open >= 2 || st.turn < 4 || st.turn - (st.lastOfferTurn ?? 0) < 12) return;
    const ss = stageSettings();
    if (!hasHelper(ss)) return;
    questBusy = true;
    try {
        const out = await callHelper(ss, 'You invent side quests for an interactive story. Output only JSON.', E.questPrompt({ state: st, setting: setting(), user: ctx().name1 }), 300, { json: true });
        const q = E.parseJsonLine(out);
        const last = (ctx().chat?.length ?? 1) - 1;
        const now = stateAt(last);
        const offer = E.addOffer(now, q);
        if (!offer) return;
        writeSnapshot(last, { state: now });
        await ctx().saveChat();
        toastEnc(`📜 Мир предлагает задание: ${offer.title}`, 'gold');
    } catch (e) { log('quest offer failed', e); } finally { questBusy = false; }
}

// ------------------------------------------------------------------ daily routines

let schedBusy = false;
async function maybeSchedule(mesId) {
    if (schedBusy) return;
    const st = stateAt(mesId);
    const npc = Object.values(st.npcs).find(n => !n.schedule && !n.schedTried && (n.present || n.stage >= 1));
    const ss = stageSettings();
    if (!npc || !hasHelper(ss)) return;
    schedBusy = true;
    try {
        const ch = currentCharacter();
        const isMain = ch && npc.name.toLowerCase().includes(String(ch.name).toLowerCase().split(/\s+/)[0]);
        const out = await callHelper(ss, 'You write character routines. Output only JSON.', E.schedulePrompt({ npc, card: isMain ? `${ch.description || ''}` : '', era: st.era, setting: setting() }), 500, { json: true });
        const j = E.parseJsonLine(out);
        const last = (ctx().chat?.length ?? 1) - 1;
        const now = stateAt(last);
        const target = E.resolveNpc(now, npc.name);
        if (!target) return;
        target.schedTried = true;
        const sched = E.cleanSchedule(j?.schedule);
        if (sched.length) target.schedule = sched;
        writeSnapshot(last, { state: now });
        await ctx().saveChat();
    } catch (e) { log('schedule failed', e); } finally { schedBusy = false; }
}

// ------------------------------------------------------------------ shop

async function loadShop(force = false) {
    const st = currentState();
    if (!force && st.shop && st.shop.location === st.location && st.turn - st.shop.turn < 30) return st.shop;
    const ss = stageSettings();
    if (!hasHelper(ss)) return null;
    const out = await callHelper(ss, 'You stock a shop in a story world. Output only JSON.', P.render('shop', {
        user: ctx().name1, setting: setting(), time: E.timeEn(st.time), location: st.location || '?', currency: st.currency, money: st.money,
        scale: E.scaleLine(st), format: P.render('shop_format'),
    }), 800, { json: true });
    const j = E.parseJsonLine(out);
    if (!j) return null;
    const shop = { location: st.location, turn: st.turn, available: Boolean(j.available), place: String(j.place_ru || '').slice(0, 50), note: String(j.note_ru || '').slice(0, 120), items: (Array.isArray(j.items) ? j.items : []).slice(0, 8).map(x => ({ name_ru: String(x.name_ru || '').slice(0, 40), desc_ru: String(x.desc_ru || '').slice(0, 80), price: Math.max(0, Math.round(Number(x.price) || 0)), skill: E.SKILLS[x.skill] ? x.skill : '', bonus: Math.max(0, Math.min(2, Math.round(Number(x.bonus) || 0))), consumable: Boolean(x.consumable), effect: E.ITEM_EFFECTS[x.effect] ? x.effect : '', qty: Math.max(1, Math.round(Number(x.qty) || 1)) })).filter(x => x.name_ru && x.price > 0) };
    const idx = (ctx().chat?.length ?? 1) - 1;
    const now = currentState();
    now.shop = shop;
    writeSnapshot(idx, { state: now });
    await ctx().saveChat();
    return shop;
}

async function buy(i) {
    const st = currentState();
    const it = st.shop?.items?.[i];
    if (!it) return;
    if (st.money < it.price) { toastEnc('Не хватает денег', 'bad'); return; }
    const notes = [];
    E.moneyOp(st, { amount: -it.price, kind: 'purchase', who: st.shop.place, why_ru: it.name_ru }, notes);
    E.addItem(st, it, notes);
    journal(st, notes);
    st.pending = [...(st.pending || []), `${ctx().name1} bought ${it.name_ru}${it.qty > 1 ? ` ×${it.qty}` : ''} for ${it.price} ${st.currency} (already counted)`];
    const idx = (ctx().chat?.length ?? 1) - 1;
    writeSnapshot(idx, { state: st });
    await ctx().saveChat();
    renderHud(st);
    toastEnc(`🛒 ${it.name_ru} — ${it.price} ${st.currency}`, 'good');
    haptic('tick');
    openStateSheet('items');
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
    $h.find('.eg-stress').html(`<b class="eg-lbl">⚡</b>${pips(E.energyOf(state), E.STRESS_MAX, 'eg-pip eg-pip-st')}`);
    const clocks = state.clocks.filter(c => c.filled < c.size).sort((a, b) => (b.kind === 'threat') - (a.kind === 'threat') || b.filled / b.size - a.filled / a.size).slice(0, 2);
    $h.find('.eg-clocks').html(clocks.map(c => `<span class="eg-hud-clock">${clockSvg(c)}<span>${escapeHtml(c.name)}</span></span>`).join(''));
    $h.toggleClass('eg-lowhp', state.harm >= 2);
    $h.find('.eg-lvlup').remove();
    if (state.unspent > 0 || E.perkPicks(state) > 0) $h.find('.eg-hud-stats .eg-spacer').after(`<span class="eg-lvlup">⬆ ${E.perkPicks(state) > 0 ? 'перк' : 'навык'}</span>`);
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
        <section id="eg-prompts" class="eg-sheet eg-sheet-tall"><div class="eg-grip"></div><div class="eg-sheet-body"></div></section>
        <div id="eg-toasts"></div>
        <div id="eg-banner"></div>`);
    $('#eg-scrim').on('click', () => { if (!$('#eg-check').hasClass('eg-open')) closeEgSheets(); });
}

function openPromptsSheet() {
    openPrompts({ S, ctx, callHelper, hasHelper, stageSettings, log, openSheet: openEgSheet, toast: toastEnc, back: () => (isActive() ? openStateSheet('hero') : closeEgSheets()) });
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
        const setup = E.rollSetup(state, v);
        const { skill, dc, adv, lucky } = setup;
        const pos = setup.position;
        const bond = E.bondModifier(state, { ...v, skill });
        const cond = E.conditionModifier(state, { ...v, skill });
        const baseMod = setup.mod;
        const canPush = state.stress < E.STRESS_MAX;
        let push = false;
        let rerollLeft = setup.reroll;
        const $card = $('#eg-check');
        const nDice = adv ? 3 : 2;

        const render = () => {
            const mod = baseMod + (push ? 2 : 0);
            const o = E.odds(mod, dc, pos, { adv, lucky });
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
                    ${v.intimacy_push ? '<span class="eg-badge eg-badge-bond">💗 дальше, чем она готова</span>' : ''}
                    ${adv ? '<span class="eg-badge eg-badge-perk">✨ талант: 3 кубика</span>' : ''}
                    ${(() => { const g = E.gearFor(state, skill); return g ? `<span class="eg-badge eg-badge-perk">🎒 ${escapeHtml(g.name)} +${g.bonus}</span>` : ''; })()}
                    ${bond.why.map(w => `<span class="eg-badge eg-badge-bond">💞 ${escapeHtml(w)}</span>`).join('')}${cond.why.map(w => `<span class="eg-badge eg-badge-cond">⛓ ${escapeHtml(w)}</span>`).join('')}${cond.frees ? '<span class="eg-badge eg-badge-cond">🔓 успех освободит</span>' : ''}
                    <span class="eg-badge">+ ${nearPct}% успех ценой</span>
                    ${v.threat ? `<span class="eg-badge eg-badge-threat">⏳ ${escapeHtml(v.threat)}</span>` : ''}
                </div>
                <div class="eg-bar"><i style="width:${pct}%"></i><i class="eg-bar-near" style="width:${nearPct}%"></i></div>
                <div class="eg-dice">${'<div class="eg-die">?</div>'.repeat(nDice)}<div class="eg-roll-result"></div></div>
                <div class="eg-actions">
                    <button class="eg-btn eg-btn-roll"><i class="fa-solid fa-dice"></i> Бросить</button>
                    <button class="eg-btn eg-btn-push ${push ? 'eg-on' : ''}" ${canPush ? '' : 'disabled'}>⚡ Собраться <small>+2 · −1 сила</small></button>
                </div>
                <button class="eg-link eg-btn-cancel">Отменить ход</button>`);
        };
        render();
        openEgSheet('eg-check');
        if (S().juice) haptic('tick');

        let rerolled = false;
        const roll = async () => {
            $card.find('.eg-actions, .eg-btn-cancel, .eg-after').css('visibility', 'hidden');
            const dice = E.rollDice(Math.random, nDice);
            await animateDice($card, dice);
            const mod = baseMod + (push ? 2 : 0);
            const outcome = E.classifyDice(dice, mod, dc, pos, { lucky });
            const o = E.OUTCOMES[outcome];
            const [a, b] = E.bestTwo(dice);
            $card.find('.eg-die').each(function (i) { this.classList.toggle('eg-die-drop', adv && i === dice.indexOf(Math.min(...dice))); });
            $card.find('.eg-roll-result').attr('data-tone', o.tone).html(`<b>${o.ru}</b><small>${a} + ${b} ${mod >= 0 ? '+' : '−'} ${Math.abs(mod)} = ${a + b + mod} / ${dc}</small>`);
            $card.attr('data-tone', o.tone);
            juiceOutcome(outcome);
            const finish = () => { closeEgSheets(); resolve({ roll: true, push, dice, rerolled }); };
            if (rerollLeft && (outcome === 'fail' || outcome === 'disaster')) {
                $card.find('.eg-after').remove();
                $card.append(`<div class="eg-actions eg-after"><button class="eg-btn eg-btn-reroll">🔁 Второй шанс</button><button class="eg-btn eg-btn-accept">Принять</button></div>`);
                $card.find('.eg-btn-reroll').one('click', () => { rerollLeft = false; rerolled = true; $card.find('.eg-after').remove(); roll(); });
                $card.find('.eg-btn-accept').one('click', finish);
                return;
            }
            setTimeout(finish, 1500);
        };
        $card.off('click').on('click', '.eg-btn-push', () => { push = !push; render(); haptic('tick'); })
            .on('click', '.eg-btn-cancel', () => { closeEgSheets(); resolve({ cancel: true }); })
            .on('click', '.eg-btn-roll', roll);
    });
}

function animateDice($card, final) {
    const faces = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
    const $d = $card.find('.eg-die');
    $d.addClass('eg-rolling');
    globalThis.ElephantStage?.sound?.play('dice');
    return new Promise((res) => {
        let n = 0;
        const t = setInterval(() => {
            $d.each(function () { this.textContent = faces[Math.floor(Math.random() * 6)]; });
            if (++n >= 9) {
                clearInterval(t);
                $d.removeClass('eg-rolling');
                $d.each(function (i) { this.textContent = faces[(final[i] ?? 1) - 1]; });
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

function noteLines(notes = [], state = null) {
    const out = [];
    const cur = (state || currentState()).currency;
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
                const a = E.ACTS.find(x => x.id === n.act);
                out.push({ text: `${a?.icon || '💗'} Впервые: ${(a?.ru || n.act).toLowerCase()} с ${n.name}`, tone: 'gold' });
                break;
            }
            case 'stage': out.push({ text: `${E.STAGES[n.stage].icon} ${n.name}: новая ступень — ${E.STAGES[n.stage].ru.toLowerCase()}`, tone: 'gold' }); break;
            case 'virgin': out.push({ text: `🌸 ${n.name}: первый раз в жизни`, tone: 'gold' }); break;
            case 'push_ok': out.push({ text: `💗 ${n.name} поддаётся`, tone: 'good' }); break;
            case 'push_fail': out.push({ text: `✋ ${n.name} останавливает тебя`, tone: 'bad' }); break;
            case 'perk_pick': out.push({ text: '✨ Можно выбрать перк', tone: 'gold' }); break;
            case 'knows': out.push({ text: `👀 ${n.name} теперь знает про тебя и ${n.about}`, tone: 'warn' }); break;
            case 'jealous': out.push({ text: `💢 ${n.name} ревнует к ${n.about}`, sub: 'это скажется на следующих сценах', tone: 'bad' }); break;
            case 'moment': out.push({ text: `📔 ${n.name}: ${n.text}`, tone: 'info' }); break;
            case 'dislike': out.push({ text: `👎 ${n.name} не нравится: ${n.text}`, tone: 'warn' }); break;
            case 'enc_peak': out.push({ text: `💦 ${n.name}: пик${n.n > 1 ? ` ×${n.n}` : ''}!`, tone: 'gold' }); break;
            case 'enc_you_peak': out.push({ text: '🔥 Ты не сдержался', tone: 'warn' }); break;
            case 'status': { const d = E.status.STATUSES[n.id]; out.push({ text: `${d?.icon || '✨'} ${n.name || 'Ты'}: ${n.name ? d?.noun : d?.ru}`, sub: d ? `${d.cure} · ${n.left || d.left} ход.` : '', tone: 'bad' }); break; }
            case 'status_end': { const d = E.status.STATUSES[n.id]; out.push({ text: n.name ? `🔓 ${n.name}: ${d?.noun} прошло` : `🔓 Ты больше не ${d?.ru}`, tone: 'good' }); break; }
            case 'helpless': { const d = E.status.STATUSES[n.id]; out.push({ text: `${d?.icon || '⛓'} ${n.name} не может действовать`, sub: d?.noun || '', tone: 'good' }); break; }
            case 'molest': out.push({ text: `🫳 Враг распускает руки: ${n.name}`, tone: 'warn' }); break;
            case 'ally_hit': out.push({ text: `💢 ${n.name}: доверие −5`, tone: 'bad' }); break;
            case 'enc_limit': out.push({ text: `🚫 ${n.name}: это — нет`, tone: 'bad' }); break;
            case 'enc_escape': out.push({ text: n.n >= 2 ? '🏃 Ты вырвался!' : '💪 Почти вырвался', tone: 'warn' }); break;
            case 'orgasm': out.push({ text: `💦 ${n.name}: оргазм${n.n > 1 ? ` ×${n.n}` : ''}`, tone: 'gold' }); break;
            case 'lust': if (n.delta >= 20) out.push({ text: `🔥 ${n.name} возбуждается`, tone: 'info' }); break;
            case 'like': out.push({ text: `💗 ${n.name} любит: ${n.text}`, tone: 'info' }); break;
            case 'spot': out.push({ text: `✨ Чувствительное место ${n.name}: ${n.text}`, tone: 'info' }); break;
            case 'limit': out.push({ text: `🚫 ${n.name}: граница — ${n.text}`, tone: 'warn' }); break;
            case 'tier': out.push({ text: `${n.name} — ${E.TIERS.find(t => t.id === n.to)?.ru}`, tone: 'gold' }); break;
            case 'npc_new': out.push({ text: `Новое знакомство: ${n.name}`, tone: 'info' }); break;
            case 'clock': out.push({ text: `${n.name} ${n.to}/${n.size}`, tone: 'warn' }); break;
            case 'stress': out.push({ text: `⚡ Силы ${n.delta > 0 ? '−' : '+'}${Math.abs(n.delta)}`, sub: n.why || '', tone: n.delta > 0 ? 'warn' : 'good' }); break;
            case 'spent': out.push({ text: '😮‍💨 Силы кончились: −1 ко всем броскам, пока не отдохнёшь', tone: 'bad' }); break;
            case 'recovered': out.push({ text: '💪 Силы вернулись', tone: 'good' }); break;
            case 'edge': out.push({ text: '⚡ Преимущество!', sub: 'следующий ход легче и сильнее', tone: 'gold' }); break;
            case 'harm': out.push({ text: n.to > n.from ? `Рана: ${E.HARM[n.to].ru}` : `Легче: ${E.HARM[n.to].ru}`, tone: n.to > n.from ? 'bad' : 'good' }); break;
            case 'xp': out.push({ text: `+${n.delta} опыта${n.why ? ` · ${n.why}` : ''}`, tone: 'info' }); break;
            case 'money': { const k = E.MONEY_KINDS[n.op]; out.push({ text: `${k ? k.icon + ' ' : ''}${n.delta > 0 ? '+' : '−'}${Math.abs(n.delta)} ${cur}${k ? ` · ${k.ru}` : ''}`, sub: [n.why, n.who].filter(Boolean).join(' · '), tone: n.delta > 0 ? 'good' : 'bad' }); break; }
            case 'other': out.push({ text: `👀 ${n.name}: близость с другим`, sub: n.who, tone: 'warn' }); break;
            case 'gift': out.push({ text: `🎁 ${n.name}: подарок принят`, sub: `${n.item} · +${n.affection} 💞`, tone: 'good' }); break;
            case 'item': out.push({ text: `🎒 ${n.delta > 0 ? 'Получено' : 'Ушло'}: ${n.name}${Math.abs(n.delta) > 1 ? ` ×${Math.abs(n.delta)}` : ''}`, tone: n.delta > 0 ? 'good' : 'warn' }); break;
            case 'goal_new': out.push({ text: `${n.quest ? '📜 Задание взято' : 'Новая цель'}: ${n.title}`, tone: n.quest ? 'gold' : 'info' }); break;
            case 'goal_failed': out.push({ text: `Цель провалена: ${n.title}`, tone: 'bad' }); break;
            default:
        }
    }
    return out;
}

function showNotes(notes = []) {
    const out = noteLines(notes);
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

const TABS = [['hero', '🧍', 'Герой'], ['people', '🫂', 'Связи'], ['items', '🎒', 'Вещи'], ['goals', '🎯', 'Цели'], ['log', '📖', 'Журнал']];

function openStateSheet(tab = 'hero') {
    ensureSheets();
    const s = currentState();
    const dots = { hero: s.unspent > 0 || E.perkPicks(s) > 0, goals: (s.offers || []).some(o => o.status === 'offered') };
    $('#eg-state .eg-tabs').html(TABS.map(([id, icon, label]) => `<button class="eg-tab ${id === tab ? 'eg-on' : ''}" data-tab="${id}"><i>${icon}</i><span>${label}</span>${dots[id] ? '<u></u>' : ''}</button>`).join(''))
        .off('click').on('click', '.eg-tab', function () { openStateSheet(this.dataset.tab); });
    const $b = $('#eg-state .eg-sheet-body');
    if (tab === 'hero') $b.html(heroHtml(s));
    if (tab === 'people') $b.html(peopleHtml(s));
    if (tab === 'goals') $b.html(goalsHtml(s));
    if (tab === 'items') $b.html(itemsHtml(s));
    if (tab === 'log') $b.html(journalHtml(s));
    $b.scrollTop(0);
    // one place for every "change the state from a menu" action
    const act = async (fn, back) => {
        const st = currentState();
        const notes = fn(st);
        if (!notes) { toastEnc('Сейчас не получится', 'warn'); return; }
        journal(st, notes);
        writeSnapshot((ctx().chat?.length ?? 1) - 1, { state: st });
        await ctx().saveChat();
        renderHud(st);
        showNotes(notes);
        haptic('tick');
        openStateSheet(back);
    };
    const me = ctx().name1;
    $b.off('click').on('click', '[data-card]', function () { openCard(this.dataset.card); })
        .on('click', '[data-hint]', function () { const k = this.dataset.hint; $b.find('.eg2-hint').each(function () { this.hidden = this.dataset.for !== k || !this.hidden; }); $b.find('.eg2-stat').removeClass('eg-on'); if (!$b.find(`.eg2-hint[data-for="${k}"]`).prop('hidden')) $(this).addClass('eg-on'); })
        .on('click', '[data-jtab]', function () { journalTab = this.dataset.jtab; openStateSheet('log'); })
        .on('click', '[data-use]', function () { const name = currentState().items[Number(this.dataset.use)]; act(st => E.consumeItem(st, name, me), 'items'); })
        .on('click', '[data-gift]', function () { const el = $b.find(`[data-gift-for="${this.dataset.gift}"]`)[0]; if (el) el.hidden = !el.hidden; })
        .on('click', '[data-gift-to]', function () { const name = currentState().items[Number(this.dataset.i)]; const to = this.dataset.giftTo; act(st => E.giftItem(st, name, to, me), 'items'); })
        .on('click', '[data-sell]', function () { const cur = currentState(); const name = cur.items[Number(this.dataset.sell)]; act(st => E.sellItem(st, name, cur.shop?.place || '', me), 'items'); })
        .on('click', '[data-offer-yes]', function () { const id = this.dataset.offerYes; act(st => E.acceptOffer(st, id, me), 'goals'); })
        .on('click', '[data-offer-no]', function () { const id = this.dataset.offerNo; act(st => (E.declineOffer(st, id) ? [] : null), 'goals'); })
        .on('click', '[data-act="prompts"]', () => openPromptsSheet())
        .on('click', '[data-buy]', function () { buy(Number(this.dataset.buy)); })
        .on('click', '[data-act="shop"], [data-act="shop-refresh"]', async function () {
            const force = this.dataset.act === 'shop-refresh';
            $(this).prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> Смотрю, что тут есть…');
            try { await loadShop(force); } catch (e) { log('shop failed', e); toastEnc('Не получилось загрузить магазин', 'bad'); }
            openStateSheet('items');
        })
        .on('click', '[data-enc]', function () { closeEgSheets(); startEncounterFlow(this.dataset.enc); })
        .on('click', '[data-perk]', async function () {
            const id = this.dataset.perk;
            const P = E.PERKS[id];
            const ok = await ctx().Popup.show.confirm(`${P.icon} ${P.ru}`, `${P.text}<br><br>Выбор навсегда.`, { okButton: 'Взять', cancelButton: 'Назад' });
            if (!ok) return;
            const idx = (ctx().chat?.length ?? 1) - 1;
            const next = E.choosePerk(currentState(), id);
            writeSnapshot(idx, { state: next });
            await ctx().saveChat();
            renderHud(next);
            openStateSheet('hero');
            haptic('heartbeat');
        })
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

// ------------------------------------------------------------------ UI: character card (eroge-style)

function findNpc(state, name) {
    return E.resolveNpc(state, name);
}

function bar(label, icon, value, { min = 0, max = 100, cls = '' } = {}) {
    const pct = Math.round((value - min) / (max - min) * 100);
    return `<div class="eg-cbar ${cls}"><div class="eg-cbar-top"><span>${icon} ${label}</span><b>${value}</b></div><div class="eg-cbar-track"><i style="width:${Math.max(0, Math.min(100, pct))}%"></i></div></div>`;
}

function agoRu(fromIso, toIso) {
    const d = (Date.parse(toIso + ':00Z') - Date.parse(fromIso + ':00Z')) / 60000;
    if (!Number.isFinite(d) || d < 60) return 'только что';
    if (d < 60 * 24) return `${Math.round(d / 60)} ч назад`;
    const days = Math.round(d / 1440);
    return days === 1 ? 'вчера' : `${days} дн. назад`;
}

function ladderHtml(n, state) {
    const r = E.readiness(n, E.readyOpts(state));
    const steps = E.STAGES.slice(1).map((st, i) => {
        const idx = i + 1;
        const cls = idx <= r.reached ? 'eg-st-done' : idx <= r.ready ? 'eg-st-open' : 'eg-st-lock';
        return `<div class="eg-st ${cls}" title="${st.ru}"><span>${idx <= r.ready ? st.icon : '🔒'}</span><small>${st.short || st.ru}</small></div>`;
    }).join('');
    let hint = '';
    if (r.next == null) hint = '<b>Всё открыто.</b> Между вами больше нет запретов.';
    else {
        const now = r.ready > r.reached ? `Готова на: <b>${E.STAGES[r.ready].ru.toLowerCase()}</b>.` : `Сейчас — не дальше: <b>${E.STAGES[r.ready].ru.toLowerCase()}</b>.`;
        const why = r.sceneLimited
            ? 'Для одного вечера уже достаточно — следующий шаг в другой сцене (или рискни броском).'
            : `Для «${E.STAGES[r.next].ru.toLowerCase()}» нужно: ${r.missing.map(m => `${E.reqRu(m.key)} <b>${m.have}/${m.need}</b>`).join(', ')}.`;
        hint = `${now} ${why}`;
    }
    const pace = n.pace === 'fast' ? '<span class="eg-chip eg-chip-like">⚡ быстрая</span>' : n.pace === 'slow' ? '<span class="eg-chip">🐢 не торопится</span>' : '';
    return `<div class="eg-ladder">${steps}</div><p class="eg-ladder-hint">${hint} ${pace}</p>`;
}

let cardScope = 'you'; // you | all | others

function cardHtml(state, name) {
    const raw = findNpc(state, name);
    const ch = currentCharacter();
    const isMain = ch && !ch.group && (!raw || E.sameName(raw.name, ch.name) || raw.name.toLowerCase().includes(String(ch.name).toLowerCase().split(/\s+/)[0]));
    const n = raw ? E.ensureNpc(E.clone(raw)) : E.ensureNpc({ name: name || ch?.name || '?', color: 'c3a6ff' });
    const avatar = isMain && ch?.avatarUrl ? `<img class="eg-card-ava" src="${ch.avatarUrl}" alt="">` : `<div class="eg-card-ava eg-card-ini" style="--c:#${n.color}">${escapeHtml(n.name.slice(0, 1).toUpperCase())}</div>`;
    const tier = E.tierOf(n.trust);
    const fmt = (iso) => { try { return E.timeRu(iso).split(',').slice(1, 2).join('').split('·')[0].trim(); } catch { return ''; } };
    const chips = (list, cls) => list.map(t => `<span class="eg-chip ${cls}">${escapeHtml(t)}</span>`).join('');
    const T = E.intimacyTotals(n);
    const scope = cardScope;
    const counts = scope === 'you' ? T.you : scope === 'others' ? T.others : T.all;
    const tiles = E.ACTS.map(a => {
        const c = counts[a.id] || 0;
        const f = scope === 'you' ? n.firsts[a.id] : null;
        return `<div class="eg-act ${c ? 'eg-got' : ''}"><span>${c ? a.icon : '·'}</span><b>${c ? `×${c}` : '—'}</b><em>${a.ru}</em>${scope === 'you' ? `<small>${f ? `с ${fmt(f.time)}` : 'ещё не было'}</small>` : ''}</div>`;
    }).join('');
    const firsts = Object.entries(n.firsts).filter(([id]) => E.ACTS.some(a => a.id === id))
        .sort((x, y) => String(x[1].time).localeCompare(String(y[1].time)))
        .map(([id, f]) => { const a = E.ACTS.find(x => x.id === id); return `<div class="eg-tl-row"><span>${a.icon}</span><div><b>${a.ru}</b><small>${fmt(f.time)}${f.place ? ` · ${escapeHtml(f.place)}` : ''}</small></div></div>`; }).join('');
    const lastAct = n.last ? E.ACTS.find(a => a.id === n.last.act) : null;
    const lastOther = n.other.last ? E.ACTS.find(a => a.id === n.other.last.act) : null;
    const big = (v, label) => `<div><b>${v}</b><small>${label}</small></div>`;
    const stats = scope === 'you'
        ? big(n.times, 'раз вместе') + big(n.orgasms, '💦 её оргазмов') + big(n.userOrgasms, 'твоих') + big(`${n.protected}<i>/</i>${n.unprotected}`, '🛡 с защитой / без')
        : scope === 'others'
            ? big(n.other.partners.length + Math.max(0, n.other.past || 0), 'партнёров') + big(T.pastKnown ? n.other.past : '?', 'до истории') + big(n.other.partners.length, 'в истории') + big(Object.values(T.others).reduce((a, b) => a + b, 0), 'актов в истории')
            : big(T.partners, 'партнёров всего') + big(Object.values(T.all).reduce((a, b) => a + b, 0), 'актов всего') + big(n.orgasms + n.other.orgasms, '💦 оргазмов') + big(n.times, 'раз с тобой');
    const scopeNote = { you: 'Только то, что было между вами. Один раз — это одна встреча, сколько бы ответов она ни длилась.', others: 'Её жизнь без тебя: прошлое по карточке и то, что произошло в истории с другими.', all: 'Всё вместе: с тобой и с другими.' }[scope];
    const act = E.activityAt(n, state.time);
    const knows = Object.entries(n.knows || {}).filter(([key, st]) => st >= 2 && state.npcs?.[key]);
    const tastes = [
        n.likes.length ? `<div class="eg3-row"><small>💗 Нравится</small><div class="eg-chips">${chips(n.likes, 'eg-chip-like')}</div></div>` : '',
        n.spots.length ? `<div class="eg3-row"><small>✨ Чувствительные места</small><div class="eg-chips">${chips(n.spots, 'eg-chip-spot')}</div></div>` : '',
        n.dislikes.length ? `<div class="eg3-row"><small>👎 Не любит</small><div class="eg-chips">${chips(n.dislikes, 'eg-chip-limit')}</div></div>` : '',
        n.limits.length ? `<div class="eg3-row"><small>🚫 Границы</small><div class="eg-chips">${chips(n.limits, 'eg-chip-limit')}</div></div>` : '',
        n.positions.length ? `<div class="eg3-row"><small>🌀 Позы</small><div class="eg-chips">${chips(n.positions, '')}</div></div>` : '',
        n.places.length ? `<div class="eg3-row"><small>📍 Места</small><div class="eg-chips">${chips(n.places, '')}</div></div>` : '',
    ].join('');
    const others = Object.values(state.npcs || {}).filter(x => x.name !== n.name);
    return `
        <div class="eg-card-hero eg3-top" style="--c:#${n.color}">
            ${avatar}
            <div class="eg-card-who">
                <h3>${escapeHtml(n.name)}</h3>
                <div class="eg-card-tags"><span class="eg-status eg-status-big">${escapeHtml(raw ? E.loveStatus(n) : 'Ещё не знакомы')}</span><span class="eg-tier eg-tier-${tier.id}">${tier.ru}</span>${n.present ? '<span class="eg-here">рядом</span>' : ''}${n.feel && state.turn - n.feel.turn <= 6 ? `<span class="eg-feel">${escapeHtml(n.feel.ru)}</span>` : ''}${E.isJealous(n, state) ? `<span class="eg-jealous">💢 ревнует к ${escapeHtml(n.jealous.of)}</span>` : ''}</div>
                <div class="eg3-sub">${[n.experience ? E.EXPERIENCE[n.experience] : '', n.pace === 'fast' ? '⚡ быстрая' : n.pace === 'slow' ? '🐢 не торопится' : '', n.aliases.length ? `она же: ${n.aliases.map(escapeHtml).join(', ')}` : ''].filter(Boolean).join(' · ')}</div>
            </div>
        </div>
        ${act ? `<div class="eg-now">🕐 Сейчас по распорядку: <b>${escapeHtml(act.doing_ru || act.doing_en)}</b>${act.where_ru ? ` · ${escapeHtml(act.where_ru)}` : ''} <small>до ${act.to}</small></div>` : ''}
        ${knows.length ? `<div class="eg-knows">💔 Знает про тебя и: ${knows.map(([key, st]) => `<b>${escapeHtml(state.npcs[key].name)}</b> (${E.STAGES[st].ru.toLowerCase()})`).join(', ')}</div>` : ''}
        <h4 class="eg-h eg-h-love">💗 Отношения</h4>
        <div class="eg2-sec eg3-pad">
            ${bar('Доверие', '🛡', n.trust, { min: -100, cls: 'eg-c-trust' })}
            ${bar('Привязанность', '💞', n.affection, { cls: 'eg-c-aff' })}
            ${bar('Влечение', '💘', n.attraction, { cls: 'eg-c-attr' })}
        </div>
        <h4 class="eg-h eg-h-love">🪜 Ступени близости</h4>
        <div class="eg2-sec eg3-pad">${ladderHtml(n, state)}</div>
        <h4 class="eg-h eg-h-nsfw">🔞 Близость</h4>
        <div class="eg2-sec eg3-pad">
            ${bar('Возбуждение сейчас', '🔥', n.lust, { cls: `eg-c-lust ${n.lust >= 70 ? 'eg-hot' : ''}` })}
            ${bar('Раскрепощённость', '🔓', n.openness, { cls: 'eg-c-open' })}
        </div>
        <div class="eg-seg eg3-scope">${[['you', 'С тобой'], ['all', 'Всего'], ['others', 'С другими']].map(([k, ru]) => `<button class="eg-seg-btn ${scope === k ? 'eg-on' : ''}" data-scope="${k}">${ru}</button>`).join('')}</div>
        <div class="eg-bigstats">${stats}</div>
        <p class="eg-muted eg-small eg3-note">${scopeNote}</p>
        <div class="eg-acts">${tiles}</div>
        ${scope !== 'others' && lastAct ? `<div class="eg-last">⏱ Последний раз с тобой: <b>${lastAct.ru.toLowerCase()}</b>, ${agoRu(n.last.time, state.time)}</div>` : ''}
        ${scope !== 'you' && lastOther ? `<div class="eg-last">⏱ Последний раз с другими: <b>${lastOther.ru.toLowerCase()}</b> — ${escapeHtml(n.other.last.who)}, ${agoRu(n.other.last.time, state.time)}</div>` : ''}
        ${scope !== 'you' && n.other.partners.length ? `<div class="eg3-row"><small>Кто в истории</small><div class="eg-chips">${chips(n.other.partners, '')}</div></div>` : ''}
        ${scope === 'you' && firsts ? `<h4 class="eg-h">📖 Первые разы</h4><div class="eg2-sec eg3-pad"><div class="eg-tl">${firsts}</div></div>` : ''}
        ${scope === 'you' && n.scenes ? `<p class="eg-muted eg-small">Сцен-мини-игр: ${n.scenes} · лучшая оценка: ${'★'.repeat(n.bestStars || 0)}${'☆'.repeat(3 - (n.bestStars || 0))}</p>` : ''}
        <h4 class="eg-h">💡 Что ты о ней знаешь</h4>
        ${tastes ? `<div class="eg2-sec eg2-sec-list eg3-pad">${tastes}</div>` : '<p class="eg-muted eg-small">Пока ничего: вкусы, чувствительные места и границы открываются по ходу истории.</p>'}
        ${n.meets?.length ? `<h4 class="eg-h">🗓 Встречи <small class="eg-muted">${n.meetCount || n.meets.length}</small></h4><div class="eg2-sec eg3-pad"><div class="eg-tl">${n.meets.slice(-8).reverse().map(m => `<div class="eg-tl-row"><span>📍</span><div><b>${escapeHtml(m.place || 'где-то')}</b><small>${fmt(m.time)} · ${agoRu(m.time, state.time)}</small></div></div>`).join('')}</div></div>` : ''}
        ${n.diary?.length ? `<h4 class="eg-h">📔 Дневник отношений</h4><div class="eg2-sec eg3-pad"><div class="eg-tl">${n.diary.slice().reverse().map(d => `<div class="eg-tl-row"><span>•</span><div><b>${escapeHtml(d.ru)}</b><small>${fmt(d.time)}</small></div></div>`).join('')}</div></div>` : ''}
        ${Array.isArray(n.schedule) && n.schedule.length ? `<h4 class="eg-h">🗓 Распорядок</h4><div class="eg2-sec eg3-pad"><div class="eg-sched">${n.schedule.map(e => `<div><span>${e.from}–${e.to}</span><b>${escapeHtml(e.doing_ru || e.doing_en)}</b><small>${escapeHtml(e.where_ru)}${e.days !== 'all' ? ` · ${e.days === 'weekdays' ? 'будни' : 'выходные'}` : ''}</small></div>`).join('')}</div></div>` : ''}
        ${raw && others.length ? `<details class="eg2-fmt eg3-merge"><summary>Это дубль другого персонажа?</summary><div class="eg3-merge-body"><small class="eg-muted">Выбери, с кем объединить запись: отношения, счётчики и дневник сложатся в одну карточку.</small><div class="eg-chips">${others.map(o => `<button class="eg-chip" data-merge="${escapeHtml(o.name)}">${escapeHtml(o.name)}</button>`).join('')}</div></div></details>` : ''}
        ${raw ? `<details class="eg2-fmt eg3-merge eg-fix"><summary>✏️ Исправить счётчики</summary><div class="eg3-merge-body">
            <small class="eg-muted">Если учёт ошибся — поправь числа вручную. Сохраняется в текущее сообщение.</small>
            <div class="eg-fix-grid"><span></span><b>с тобой</b><b>с другими</b>
                ${E.ACTS.map(a => `<span>${a.icon} ${a.ru}</span><input type="number" min="0" max="999" data-fix="you.${a.id}" value="${n.counts[a.id] || 0}"><input type="number" min="0" max="999" data-fix="oth.${a.id}" value="${n.other.counts[a.id] || 0}">`).join('')}
                <span>💦 её оргазмы</span><input type="number" min="0" max="999" data-fix="orgasms" value="${n.orgasms}"><input type="number" min="0" max="999" data-fix="oth.orgasms" value="${n.other.orgasms || 0}">
                <span>Раз вместе</span><input type="number" min="0" max="999" data-fix="times" value="${n.times}"><span></span>
                <span>Твои оргазмы</span><input type="number" min="0" max="999" data-fix="userOrgasms" value="${n.userOrgasms}"><span></span>
                <span>🛡 с защитой / без</span><input type="number" min="0" max="999" data-fix="protected" value="${n.protected}"><input type="number" min="0" max="999" data-fix="unprotected" value="${n.unprotected}">
                <span>Партнёров до истории</span><input type="number" min="-1" max="999" data-fix="past" value="${n.other.past ?? -1}"><span class="eg-muted eg-small">−1 = неизвестно</span>
            </div>
            <div class="eg-fix-row"><button class="menu_button" data-fix-save="1"><i class="fa-solid fa-check"></i> Сохранить</button><button class="menu_button" data-fix-jealous="1">${E.isJealous(n, state) ? '🕊 Снять ревность' : ''}</button></div>
        </div></details>` : ''}
        ${isMain ? '<button class="menu_button eg-card-edit" data-card-edit="1"><i class="fa-solid fa-pen"></i> Карточка персонажа</button>' : ''}`;
}

export function openCard(name) {
    ensureSheets();
    const c = ctx();
    const who = name || c.name2;
    const $b = $('#eg-card .eg-sheet-body');
    const paintCard = (keepScroll = false) => {
        const top = $b.scrollTop();
        $b.html(`<div class="eg2-head eg3-head"><button class="eg2-x" data-card-back aria-label="Назад"><i class="fa-solid fa-arrow-left"></i></button><span class="eg-muted">Карточка персонажа</span></div>` + cardHtml(currentState(), who));
        $b.scrollTop(keepScroll ? top : 0);
    };
    paintCard();
    $b.off('click').on('click', '[data-scope]', function () { cardScope = this.dataset.scope; paintCard(true); haptic('tick'); })
        .on('click', '[data-card-back]', () => (isActive() ? openStateSheet('people') : closeEgSheets()))
        .on('click', '[data-merge]', async function () {
            const other = this.dataset.merge;
            const cur = findNpc(currentState(), who);
            if (!cur) return;
            const ok = await c.Popup.show.confirm('Объединить персонажей?', `«${escapeHtml(other)}» и «${escapeHtml(cur.name)}» станут одной записью с именем «${escapeHtml(cur.name)}». Отменить нельзя.`, { okButton: 'Объединить', cancelButton: 'Назад' });
            if (!ok) return;
            const st = currentState();
            if (!E.mergeNpcs(st, cur.name, other)) { toastEnc('Не получилось объединить', 'bad'); return; }
            writeSnapshot((ctx().chat?.length ?? 1) - 1, { state: st });
            await ctx().saveChat();
            toastEnc('Записи объединены', 'good');
            paintCard();
        })
        .on('click', '[data-fix-save]', async () => {
            const st = currentState();
            const npc = findNpc(st, who);
            if (!npc) return;
            E.ensureNpc(npc);
            const num = (v, lo = 0) => Math.max(lo, Math.min(999, Math.round(Number(v) || 0)));
            $b.find('[data-fix]').each(function () {
                const k = this.dataset.fix;
                if (k.startsWith('you.')) { const a = k.slice(4); const v = num(this.value); if (v) npc.counts[a] = v; else delete npc.counts[a]; }
                else if (k === 'oth.orgasms') npc.other.orgasms = num(this.value);
                else if (k.startsWith('oth.')) { const a = k.slice(4); const v = num(this.value); if (v) npc.other.counts[a] = v; else delete npc.other.counts[a]; }
                else if (k === 'past') { const v = num(this.value, -1); npc.other.past = v < 0 ? null : v; }
                else npc[k] = num(this.value);
            });
            // the ladder follows what really happened
            const top = Math.max(0, ...E.ACTS.filter(a => npc.counts[a.id]).map(a => a.stage));
            if (top > npc.stage) npc.stage = top;
            writeSnapshot((ctx().chat?.length ?? 1) - 1, { state: st });
            await ctx().saveChat();
            toastEnc('Счётчики исправлены', 'good');
            paintCard(true);
        })
        .on('click', '[data-fix-jealous]', async () => {
            const st = currentState();
            const npc = findNpc(st, who);
            if (!npc?.jealous) return;
            npc.jealous = null;
            writeSnapshot((ctx().chat?.length ?? 1) - 1, { state: st });
            await ctx().saveChat();
            paintCard(true);
        })
        .on('click', '[data-card-edit]', () => {
            closeEgSheets();
            $('#rightNavHolder .drawer-content').hasClass('openDrawer') || $('#rightNavHolder .drawer-toggle').first().trigger('click');
            setTimeout(() => $('#rm_button_selected_ch').trigger('click'), 60);
        });
    openEgSheet('eg-card');
    haptic('tick');
}

// ------------------------------------------------------------------ UI: tabs of the state sheet

function heroHtml(s) {
    const need = E.xpNeed(s.level);
    const top = s.level >= E.MAX_LEVEL;
    const pct = top ? 100 : Math.round(s.xp / need * 100);
    const skills = Object.entries(E.SKILLS).map(([k, sk]) => {
        const v = s.skills[k] ?? 1;
        const gear = E.gearFor(s, k);
        return `
        <div class="eg-skill-row">
            <i class="eg2-ico">${sk.icon}</i>
            <span>${sk.ru} <em class="eg-rank eg-rank-${v}">${E.RANKS[v]}</em>${E.hasAdvantage(s, k) ? ' <em class="eg-rank eg-rank-adv">✨ талант</em>' : ''}${gear ? ` <em class="eg-rank eg-rank-4" title="${escapeHtml(gear.name)}">+${gear.bonus} вещь</em>` : ''}<small class="eg-skill-hint">${E.TRAITS[k]?.hint || ''}</small></span>
            <span class="eg-dots">${pips(v, E.SKILL_MAX, 'eg-dot')}</span>
            ${s.unspent > 0 && v < E.SKILL_MAX ? `<button class="eg-plus" data-spend="${k}" aria-label="Повысить">+</button>` : ''}
        </div>`;
    }).join('');
    const picks = E.perkPicks(s);
    const owned = (s.perks || []).map(id => E.PERKS[id]).filter(Boolean);
    const nextPerk = (Math.floor(s.level / E.PERK_EVERY) + 1) * E.PERK_EVERY;
    const perksHtml = `
        <h4 class="eg-h">Перки ${picks ? `<small class="eg-gold">можно выбрать: ${picks}</small>` : `<small>следующий на ${Math.min(nextPerk, E.MAX_LEVEL)} уровне</small>`}</h4>
        ${owned.length ? `<div class="eg-perks">${owned.map(p => `<div class="eg-perk eg-perk-own"><b>${p.icon} ${p.ru}</b><small>${p.text}</small></div>`).join('')}</div>` : (picks ? '<p class="eg-muted eg-small">На старте — два перка на выбор, дальше по одному каждые 3 уровня.</p>' : '<p class="eg-muted eg-small">Перк даётся каждые 3 уровня.</p>')}
        ${picks ? `<div class="eg-perks">${Object.entries(E.PERKS).filter(([id]) => !E.hasPerk(s, id)).map(([id, p]) => `<button class="eg-perk" data-perk="${id}"><b>${p.icon} ${p.ru}</b><small>${p.text}</small></button>`).join('')}</div>` : ''}`;
    const hints = {
        hp: 'Раны дают штраф ко всем броскам: чем тяжелее, тем больше. Проходят от отдыха, лечения и вещей с пометкой 🩹. Смертельная рана — поражение.',
        st: `Запас, который ты тратишь сам: «Собраться» даёт +2 к броску за 1 силу — и в обычных проверках, и в боях и сценах. Ещё силы уходят от катастроф и тяжёлых сцен. Возвращаются от сна, отдыха, еды, приятных сцен, побед и вещей с пометкой 🍵. На нуле герой выдохся: −1 ко всем броскам, пока не вернётся хотя бы половина.`,
        mn: `Деньги меняются только по событию: тебе заплатили, наградили, ты нашёл, добыл, продал, купил или потерял. Каждое движение с причиной — в Журнале.${s.econ ? ` Цены в этом мире: обед ≈ ${s.econ.meal} ${escapeHtml(s.currency)}, день работы ≈ ${s.econ.day} ${escapeHtml(s.currency)}.` : ''}`,
    };
    return `
        <div class="eg2-hero">
            <div class="eg2-ring" style="--p:${pct}"><b>${s.level}</b><small>ур.</small></div>
            <div class="eg2-hero-main">
                <b>${E.titleOf(s.level)}</b>
                <small>${top ? 'Максимальный уровень' : `Опыт ${s.xp} из ${need}`}</small>
                ${s.unspent ? `<span class="eg2-pill eg2-pill-gold">⬆ свободных очков: ${s.unspent}</span>` : ''}
            </div>
        </div>
        <div class="eg2-stats">
            <button class="eg2-stat" data-hint="hp"><small>Здоровье</small><b>${E.HARM[s.harm].ru}</b><span>${pips(3 - s.harm, 3, 'eg-pip eg-pip-hp')}</span></button>
            <button class="eg2-stat" data-hint="st"><small>Силы</small><b>${s.spent ? 'Выдохся' : `${E.energyOf(s)} из ${E.STRESS_MAX}`}</b><span>${pips(E.energyOf(s), E.STRESS_MAX, 'eg-pip eg-pip-st')}</span></button>
            <button class="eg2-stat" data-hint="mn"><small>Деньги</small><b>${escapeHtml(s.currency)} ${s.money}</b><span class="eg-muted">${s.ledger?.length ? `${s.ledger.at(-1).amount > 0 ? '+' : '−'}${Math.abs(s.ledger.at(-1).amount)} недавно` : 'что это?'}</span></button>
        </div>
        ${E.status.listOf(s).length ? `<div class="eg2-pills">${E.status.chips(s).map(c => `<span class="eg2-pill eg2-pill-bad">${c.icon} ${c.ru} · ${c.left} ход. · ${escapeHtml(c.cure)}</span>`).join('')}</div>` : ''}
        ${Object.entries(hints).map(([k, t]) => `<p class="eg2-hint" data-for="${k}" hidden>${t}</p>`).join('')}
        <div class="eg-enc-start">${s.enc ? '<span class="eg-muted">Идёт сцена — панель над полем ввода</span>' : '<button class="eg-btn eg-btn-soft" data-enc="nsfw">💗 Сцена близости</button><button class="eg-btn eg-btn-soft" data-enc="combat">⚔️ Бой</button>'}</div>
        <h4 class="eg-h">Навыки <small>от 0 до ${E.SKILL_MAX}, очко за уровень</small></h4>
        <div class="eg2-sec">${skills}</div>
        ${perksHtml}
        ${s.scars?.length ? `<h4 class="eg-h">Шрамы</h4><div class="eg-items">${s.scars.map(i => `<span class="eg-item eg-scar">${escapeHtml(i)}</span>`).join('')}</div>` : ''}
        <p class="eg-muted eg-small">Опыт дают провалы (учишься на ошибках), рискованные успехи, цели, задания, новые знакомства и «первые разы».</p>
        <div class="eg2-foot">
            <button class="eg2-fbtn" data-act="setup"><i class="fa-solid fa-sliders"></i><span>Настройки<small>${E.DIFFICULTY[s.difficulty].ru}${s.eroge ? ' · эроге' : ''}</small></span></button>
            <button class="eg2-fbtn" data-act="prompts"><i class="fa-solid fa-file-pen"></i><span>Промпты<small>${Object.keys(P.PROMPTS).filter(P.isChanged).length ? `изменено: ${Object.keys(P.PROMPTS).filter(P.isChanged).length}` : 'читать и менять'}</small></span></button>
        </div>
        <button class="eg-link eg-danger eg2-stop" data-act="stop">Выключить игру в этом чате</button>`;
}

function peopleHtml(s) {
    const list = Object.values(s.npcs).map(n => E.ensureNpc(E.clone(n))).sort((a, b) => (b.present - a.present) || (b.seen - a.seen));
    if (!list.length) return '<div class="eg2-empty"><i>🫂</i><b>Пока никого</b><small>Знакомства появятся по ходу истории: игра сама заведёт карточку на каждого, кого ты встретишь.</small></div>';
    const mini = (icon, v, min = 0) => `<span class="eg2-mbar"><em>${icon}</em><i><u style="width:${Math.max(0, Math.min(100, Math.round((v - min) / (100 - min) * 100)))}%"></u></i><b>${v}</b></span>`;
    return list.map(n => {
        const last = n.diary?.at?.(-1);
        return `
        <button class="eg2-npc" style="--c:#${n.color}" data-card="${escapeHtml(n.name)}">
            <span class="eg2-ava">${escapeHtml(n.name.slice(0, 1).toUpperCase())}</span>
            <span class="eg2-npc-main">
                <span class="eg2-npc-head"><b>${escapeHtml(n.name)}</b>${n.present ? '<span class="eg-here">рядом</span>' : ''}</span>
                <span class="eg2-npc-sub">${E.STAGES[n.stage].icon} ${escapeHtml(E.loveStatus(n))} · ${E.tierOf(n.trust).ru.toLowerCase()}${n.lust >= 40 ? ' · 🔥 возбуждена' : ''}</span>
                <span class="eg2-mbars">${mini('🛡', n.trust)}${mini('💞', n.affection)}${mini('💘', n.attraction)}</span>
                ${last ? `<small class="eg2-npc-last">📔 ${escapeHtml(last.ru)}</small>` : ''}
            </span>
            <i class="fa-solid fa-chevron-right"></i>
        </button>`;
    }).join('') + '<p class="eg-muted eg-small">🛡 доверие · 💞 привязанность · 💘 влечение. Нажми на персонажа, чтобы открыть карточку.</p>';
}

function itemsHtml(s) {
    const shop = s.shop && s.shop.location === s.location ? s.shop : null;
    const present = Object.values(s.npcs).filter(n => n.present);
    const inv = s.items.length ? s.items.map((name, i) => {
        const g = s.gear?.[name] || {};
        const fx = E.ITEM_EFFECTS[g.effect];
        const usable = fx && (g.effect === 'heal' ? s.harm > 0 : s.stress > 0);
        const sell = shop?.available ? E.sellPrice(s, name) : 0;
        return `
        <div class="eg2-item">
            <i class="eg2-ico">${fx ? fx.icon : g.skill ? E.SKILLS[g.skill].icon : '📦'}</i>
            <div class="eg2-item-main">
                <b>${escapeHtml(name)}${g.consumable && g.qty > 1 ? ` <em>×${g.qty}</em>` : ''}</b>
                <small>${[g.skill && g.bonus ? `+${g.bonus} ${E.SKILLS[g.skill].ru.toLowerCase()}` : '', fx ? fx.ru : '', g.desc ? escapeHtml(g.desc) : '', g.value ? `стоит ≈ ${g.value} ${escapeHtml(s.currency)}` : ''].filter(Boolean).join(' · ') || 'обычная вещь'}</small>
                <div class="eg2-item-acts">
                    ${fx ? `<button class="eg2-act" data-use="${i}" ${usable ? '' : 'disabled'}>${fx.icon} Использовать</button>` : ''}
                    ${present.length ? `<button class="eg2-act" data-gift="${i}">🎁 Подарить</button>` : ''}
                    ${sell ? `<button class="eg2-act" data-sell="${i}">⚖ Продать · ${sell} ${escapeHtml(s.currency)}</button>` : ''}
                </div>
                ${present.length ? `<div class="eg2-gift-pick" data-gift-for="${i}" hidden><small class="eg-muted">Кому?</small>${present.map(n => `<button class="eg-chip eg-chip-like" data-gift-to="${escapeHtml(n.name)}" data-i="${i}">${escapeHtml(n.name)}</button>`).join('')}</div>` : ''}
            </div>
        </div>`;
    }).join('') : '<div class="eg2-empty"><i>🎒</i><b>Сумка пуста</b><small>Вещи приходят из истории (нашёл, получил, отнял) и из магазина.</small></div>';
    const shopHtml = !shop ? '<button class="eg-btn eg-btn-soft eg-wide" data-act="shop">🛒 Что можно купить здесь?</button>'
        : !shop.available ? `<div class="eg2-sec"><p class="eg-muted">Здесь торговли нет. ${escapeHtml(shop.note)}</p><button class="eg-link" data-act="shop-refresh">↻ Проверить снова</button></div>`
            : `<h4 class="eg-h">🛒 ${escapeHtml(shop.place || 'Магазин')} <small>у тебя ${escapeHtml(s.currency)} ${s.money}</small></h4>
            <div class="eg2-sec eg2-sec-list">${shop.items.map((it, i) => `
                <div class="eg-shop-row"><div><b>${escapeHtml(it.name_ru)}${it.qty > 1 ? ` ×${it.qty}` : ''}</b>${it.skill && it.bonus ? ` <span class="eg-rank eg-rank-4">${E.SKILLS[it.skill].icon} +${it.bonus}</span>` : ''}${E.ITEM_EFFECTS[it.effect] ? ` <span class="eg-rank eg-rank-2">${E.ITEM_EFFECTS[it.effect].icon} ${E.ITEM_EFFECTS[it.effect].ru}</span>` : ''}<small>${escapeHtml(it.desc_ru)}</small></div><button class="eg-buy" data-buy="${i}" ${s.money < it.price ? 'disabled' : ''}>${it.price} ${escapeHtml(s.currency)}</button></div>`).join('')}</div>
            <p class="eg-muted eg-small">Продать свою вещь можно здесь же, за половину цены. <button class="eg-link" data-act="shop-refresh">↻ Обновить товары</button></p>`;
    return `<h4 class="eg-h">🎒 Сумка <small>лучшая вещь даёт бонус к броскам навыка</small></h4>${inv}${shopHtml}`;
}

function goalsHtml(s) {
    const active = s.goals.filter(g => g.status === 'active');
    const closed = s.goals.filter(g => g.status !== 'active').slice(-5).reverse();
    const clocks = s.clocks;
    const offers = (s.offers || []).filter(o => o.status === 'offered');
    const reward = (o) => `${o.reward_money ? `<span class="eg2-pill eg2-pill-gold">${o.reward_money} ${escapeHtml(s.currency)}</span>` : ''}<span class="eg2-pill">+${o.reward_xp} опыта</span>${o.reward_ru ? `<span class="eg2-pill">${escapeHtml(o.reward_ru)}</span>` : ''}`;
    return `
        ${offers.length ? `<h4 class="eg-h">📜 Мир предлагает</h4>${offers.map(o => `
            <div class="eg2-sec eg2-offer">
                <b>${escapeHtml(o.title)}</b>
                ${o.giver ? `<small class="eg-muted">от: ${escapeHtml(o.giver)}</small>` : ''}
                <div class="eg2-pills">${reward(o)}</div>
                <div class="eg2-actions"><button class="eg-btn" data-offer-yes="${o.id}">Взяться</button><button class="eg-btn eg-btn-ghost" data-offer-no="${o.id}">Не интересно</button></div>
            </div>`).join('')}<p class="eg-muted eg-small">Рассказчик вплетёт задание в историю. Взяться можно кнопкой или прямо в сцене.</p>` : ''}
        <h4 class="eg-h">🎯 Цели</h4>
        ${active.length ? `<div class="eg2-sec eg2-sec-list">${active.map(g => { const o = g.offer && (s.offers || []).find(x => x.id === g.offer); return `<div class="eg2-goal"><i>◆</i><div><b>${escapeHtml(g.title)}</b>${o ? `<div class="eg2-pills">${reward(o)}</div>` : '<small class="eg-muted">своя цель · +4 опыта</small>'}</div></div>`; }).join('')}</div>` : '<div class="eg2-empty"><i>🎯</i><b>Целей пока нет</b><small>Цель появляется, когда ты в истории ясно берёшься за дело: «найду её брата», «выиграю турнир».</small></div>'}
        <h4 class="eg-h">⏳ Часы <small>что надвигается и что продвигается</small></h4>
        ${clocks.length ? `<div class="eg2-sec eg2-sec-list">${clocks.map(c => `<div class="eg-clock-row">${clockSvg(c, 38)}<div><b>${escapeHtml(c.name)}</b><small>${c.kind === 'threat' ? 'угроза: когда заполнится — случится' : 'прогресс: когда заполнится — достигнуто'} · ${c.filled} из ${c.size}</small></div></div>`).join('')}</div>` : '<p class="eg-muted eg-small">Сейчас ничего не тикает. Часы появляются от рискованных бросков (угроза растёт при провале) и от долгих дел.</p>'}
        ${closed.length ? `<h4 class="eg-h">Завершено</h4><div class="eg2-sec eg2-sec-list">${closed.map(g => `<div class="eg2-goal eg-goal-${g.status}"><i>${g.status === 'done' ? '✔' : '✖'}</i><div><b>${escapeHtml(g.title)}</b></div></div>`).join('')}</div>` : ''}`;
}

let journalTab = 'events';
function journalHtml(s) {
    const when = (iso) => { try { return E.timeRu(iso); } catch { return ''; } };
    const seg = `<div class="eg-seg eg2-jseg">${[['events', 'События'], ['money', 'Деньги'], ['rolls', 'Броски']].map(([k, ru]) => `<button class="eg-seg-btn ${journalTab === k ? 'eg-on' : ''}" data-jtab="${k}">${ru}</button>`).join('')}</div>`;
    let body = '';
    if (journalTab === 'money') {
        const L = (s.ledger || []).slice().reverse();
        const inc = L.filter(x => x.amount > 0).reduce((a, x) => a + x.amount, 0);
        const out = L.filter(x => x.amount < 0).reduce((a, x) => a - x.amount, 0);
        body = `<div class="eg2-stats eg2-stats-2"><div class="eg2-stat"><small>Сейчас</small><b>${escapeHtml(s.currency)} ${s.money}</b></div><div class="eg2-stat"><small>Пришло</small><b class="eg2-plus">+${inc}</b></div><div class="eg2-stat"><small>Ушло</small><b class="eg2-minus">−${out}</b></div></div>`
            + (L.length ? `<div class="eg2-sec eg2-sec-list">${L.map(x => { const k = E.MONEY_KINDS[x.kind]; return `<div class="eg2-led"><i class="eg2-ico">${k?.icon || '💰'}</i><div><b>${escapeHtml(x.why)}</b><small>${k?.ru || ''}${x.who ? ` · ${escapeHtml(x.who)}` : ''} · ${when(x.time)}</small></div><em class="${x.amount > 0 ? 'eg2-plus' : 'eg2-minus'}">${x.amount > 0 ? '+' : '−'}${Math.abs(x.amount)}</em></div>`; }).join('')}</div>`
                : '<div class="eg2-empty"><i>💰</i><b>Движений пока нет</b><small>Сюда попадает каждая сумма с причиной: кто заплатил, за что, где потратил.</small></div>');
    } else if (journalTab === 'rolls') {
        body = s.log.length ? `<div class="eg2-sec eg2-sec-list">${s.log.map(r => {
            const o = E.OUTCOMES[r.outcome];
            return `<div class="eg-log-row" data-tone="${o.tone}">
                <span class="eg-log-dice">${r.dice[0]}·${r.dice[1]}</span>
                <div><b>${escapeHtml(r.label_ru || r.action_en)}</b><small>${E.SKILLS[r.skill].ru} ${r.mod >= 0 ? '+' : ''}${r.mod} · ${r.total} против ${r.dc}${r.push ? ' · надавил' : ''}</small></div>
                <span class="eg-log-out">${o.ru}</span>
            </div>`;
        }).join('')}</div>` : '<div class="eg2-empty"><i>🎲</i><b>Бросков ещё не было</b><small>Кубики падают, когда исход действия не очевиден: драка, взлом, обман, соблазнение.</small></div>';
    } else {
        const J = (s.journal || []).slice().reverse();
        body = J.length ? `<div class="eg2-sec eg2-sec-list">${J.map(x => `<div class="eg2-jrow" data-tone="${x.tone}"><i></i><div><b>${escapeHtml(x.text)}</b><small>${x.sub ? `${escapeHtml(x.sub)} · ` : ''}${when(x.time)}</small></div></div>`).join('')}</div>`
            : '<div class="eg2-empty"><i>📖</i><b>Журнал пуст</b><small>Здесь копится всё, что игра посчитала: опыт, отношения, вещи, раны, цели — с причинами.</small></div>';
    }
    return seg + body;
}

// ------------------------------------------------------------------ UI: setup

/**
 * Where and when this story starts, read from the card: the helper picks a date, a year (or the
 * world's own era), a time of day, a place, a currency and pocket money. Cached per chat.
 */
async function guessStart() {
    const m = ctx().chatMetadata;
    if (m?.elephant_game_guess) return m.elephant_game_guess;
    const ss = stageSettings();
    if (!hasHelper(ss)) return null;
    const ch = currentCharacter();
    const chat = ctx().chat ?? [];
    const opening = chat.filter(x => !x.is_system).slice(0, 3).map(x => `${x.is_user ? 'User' : 'Char'}: ${String(x.mes || '').slice(0, 900)}`).join('\n');
    const today = new Date().toISOString().slice(0, 10);
    const prompt = P.render('world', {
        user: ctx().name1, char: ch?.name || '', description: String(ch?.description || '').slice(0, 2500), scenario: String(ch?.scenario || '').slice(0, 1200),
        opening: opening.slice(0, 2500), today, format: P.render('world_format'),
    });
    try {
        const out = await callHelper(ss, 'You set up a story world. Output only JSON.', prompt, 260, { json: true });
        const g = E.parseJsonLine(out);
        if (!g || !/^\d{3,4}-\d{2}-\d{2}$/.test(String(g.date || ''))) return null;
        const y = String(g.date).split('-');
        const date = `${y[0].padStart(4, '0')}-${y[1]}-${y[2]}`;
        const time = /^\d{1,2}:\d{2}$/.test(String(g.time || '')) ? String(g.time).padStart(5, '0') : '19:00';
        const res = { time: `${date}T${time}`, era: String(g.era || '').slice(0, 40), location: String(g.location_ru || '').slice(0, 40), currency: String(g.currency || '').slice(0, 8), money: Math.max(0, Math.round(Number(g.money) || 0)), meal: Math.max(0, Math.round(Number(g.meal) || 0)), day: Math.max(0, Math.round(Number(g.day_wage) || 0)), why: String(g.why_ru || '').slice(0, 140) };
        if (m) { m.elephant_game_guess = res; ctx().saveMetadataDebounced?.(); }
        return res;
    } catch (e) {
        log('start guess failed', e);
        return null;
    }
}

function openSetup(editing = false) {
    ensureSheets();
    const m = meta();
    const base = E.ensureState(E.clone(editing ? currentState() : (m?.initial ?? E.newState())));
    const draft = { skills: { ...base.skills }, difficulty: base.difficulty, pace: base.pace, eroge: Boolean(base.eroge), money: base.money, currency: base.currency, time: base.time, era: base.era, location: base.location };
    const BUDGET = Object.keys(E.SKILLS).length + 3;
    const spent = () => Object.values(draft.skills).reduce((a, b) => a + b, 0);
    let guessing = false;
    let guessWhy = '';
    const lastTracker = (() => {
        const chat = ctx().chat ?? [];
        for (let i = chat.length - 1; i >= 0; i--) { const t = E.parseTrackerLine(chat[i].mes); if (t) return t; }
        return null;
    })();
    if (!editing && lastTracker?.time) draft.time = lastTracker.time;
    if (!editing && lastTracker?.location) draft.location = lastTracker.location;

    const readInputs = () => {
        if ($('#eg_eroge').length) draft.eroge = $('#eg_eroge').prop('checked');
        if (editing || !$('#eg_time').length) return;
        draft.time = $('#eg_time').val() || draft.time;
        draft.money = Number($('#eg_money').val()) || 0;
        draft.currency = $('#eg_cur').val() || '🪙';
        draft.era = $('#eg_era').val() || '';
        draft.location = $('#eg_loc').val() || '';
    };

    const render = () => {
        const left = BUDGET - spent();
        $('#eg-setup .eg-sheet-body').html(`
            <h3 class="eg-title">🎲 ${editing ? 'Настройки игры' : 'Игровой режим'}</h3>
            ${editing ? '' : '<p class="eg-muted">Твой герой с навыками, ранами и целями; персонажи с отношениями и ступенями близости; угрозы, которые растут. Движок считает, модель рассказывает.</p>'}
            ${editing ? '' : `<h4 class="eg-h">Навыки <small>осталось очков: ${left}</small></h4>
            <p class="eg-muted eg-small">Навыки — это ты в истории: мир замечает их в каждом ответе, а кубики решают спорные моменты. На старте до 3, дальше до 6: очко за уровень.</p>
            <div class="eg2-sec">${Object.entries(E.SKILLS).map(([k, sk]) => `
                <div class="eg-skill-row">
                    <i class="eg2-ico">${sk.icon}</i>
                    <span>${sk.ru} <em class="eg-rank eg-rank-${draft.skills[k]}">${E.RANKS[draft.skills[k]]}</em><small class="eg-skill-hint">${E.TRAITS[k]?.hint || ''}</small></span>
                    <button class="eg-step" data-k="${k}" data-d="-1" ${draft.skills[k] <= 0 ? 'disabled' : ''}>−</button>
                    <span class="eg-dots">${pips(draft.skills[k], E.START_MAX, 'eg-dot')}</span>
                    <button class="eg-step" data-k="${k}" data-d="1" ${draft.skills[k] >= E.START_MAX || left <= 0 ? 'disabled' : ''}>+</button>
                </div>`).join('')}</div>`}
            <h4 class="eg-h">Сложность</h4>
            <div class="eg-seg">${Object.entries(E.DIFFICULTY).map(([k, d]) => `<button class="eg-seg-btn ${draft.difficulty === k ? 'eg-on' : ''}" data-diff="${k}">${d.ru}</button>`).join('')}</div>
            <p class="eg-muted eg-small">${{ story: 'Проверки легче на 2, смерти нет.', standard: 'Честные шансы. Смерть — только после предупреждения.', brutal: 'Проверки тяжелее, мир безжалостнее.' }[draft.difficulty]}</p>
            <h4 class="eg-h">Темп близости</h4>
            <div class="eg-seg">${Object.entries(E.PACES).map(([k, d]) => `<button class="eg-seg-btn ${draft.pace === k ? 'eg-on' : ''}" data-pace="${k}">${d.ru}</button>`).join('')}</div>
            <p class="eg-muted eg-small">${{ fast: 'Ступени открываются легко, за вечер можно пройти три.', medium: 'Сначала поцелуи и ласки, потом серьёзнее — по паре ступеней за сцену.', slow: 'Каждая ступень — отдельная сцена, чувства нужны сильнее.' }[draft.pace]} Карточка важнее: суккуб торопится, скромница — нет.</p>
            ${editing ? '' : `
            <h4 class="eg-h">Старт ${guessing ? '<small><i class="fa-solid fa-spinner fa-spin"></i> подбираю по персонажу…</small>' : '<button class="eg-link eg-small" data-act="reguess">↻ подобрать заново</button>'}</h4>
            <label class="eg-field">Дата и время в мире <input type="datetime-local" class="text_pole" id="eg_time" value="${draft.time}"></label>
            <div class="eg-inline">
                <label class="eg-field">Эпоха / летоисчисление <input type="text" class="text_pole" id="eg_era" value="${escapeHtml(draft.era)}" placeholder="необязательно" maxlength="40"></label>
                <label class="eg-field">Место <input type="text" class="text_pole" id="eg_loc" value="${escapeHtml(draft.location)}" maxlength="40"></label>
            </div>
            ${guessWhy ? `<p class="eg-muted eg-small">${escapeHtml(guessWhy)}</p>` : ''}
            <div class="eg-inline">
                <label class="eg-field">Деньги <input type="number" class="text_pole" id="eg_money" value="${draft.money}"></label>
                <label class="eg-field">Валюта <input type="text" class="text_pole" id="eg_cur" value="${escapeHtml(draft.currency)}" maxlength="8"></label>
            </div>`}
            <h4 class="eg-h">Сюжет</h4>
            <label class="eg-check-opt"><input type="checkbox" id="eg_eroge" ${draft.eroge ? 'checked' : ''}><span><b>Эроге-режим</b><br><small>Сюжет сознательно строит пикантные ситуации, как в классической эроге. Персонажи не отдаются сразу — ступени близости работают как прежде</small></span></label>
            <label class="eg-check-opt"><input type="checkbox" id="eg_auto" ${S().autoStart ? 'checked' : ''}><span><b>Игра сама включается в новых чатах</b><br><small>Дата, место и деньги подбираются по карточке, навыки можно распределить позже.</small></span></label>
            <button class="eg2-fbtn eg2-fbtn-wide" data-act="prompts"><i class="fa-solid fa-file-pen"></i><span>Промпты игры<small>посмотреть и изменить инструкции для моделей</small></span></button>
            <h4 class="eg-h">Интерфейс</h4>
            <label class="eg-check-opt"><input type="checkbox" id="eg_card" ${S().checkCard ? 'checked' : ''}><span>Карточка проверки с шансами (иначе бросок автоматически)</span></label>
            <label class="eg-check-opt"><input type="checkbox" id="eg_tracker" ${S().hideTracker ? 'checked' : ''}><span>Прятать строку трекера [🕐 | 📍 | 🌤] — её показывает HUD</span></label>
            <label class="eg-check-opt"><input type="checkbox" id="eg_juice" ${S().juice ? 'checked' : ''}><span>Эффекты: вибрация, вспышки, баннеры</span></label>
            ${hasHelper(stageSettings()) ? '' : '<p class="eg-warn">Служебная модель не выбрана (Сцена и арт / Elephant Memory) — судья работает по ключевым словам, а отношения и цели не отслеживаются.</p>'}
            <button class="eg-btn eg-btn-roll eg-wide" id="eg_start" ${guessing ? 'disabled' : ''}>${editing ? 'Сохранить' : 'Начать игру'}</button>`);
    };
    const runGuess = async (force = false) => {
        if (editing) return;
        if (force && ctx().chatMetadata) delete ctx().chatMetadata.elephant_game_guess;
        guessing = true; render();
        const g = await guessStart();
        guessing = false;
        if (g) {
            draft.time = g.time; draft.era = g.era;
            if (g.location) draft.location = g.location;
            if (g.currency) draft.currency = g.currency;
            draft.money = g.money;
            draft.meal = g.meal; draft.day = g.day;
            guessWhy = g.why ? `🤖 ${g.why}` : '';
        }
        if ($('#eg-setup').hasClass('eg-open')) render();
    };
    render();
    openEgSheet('eg-setup');
    if (!editing && !m?.initial) runGuess(false);

    $('#eg-setup .eg-sheet-body').off('click').on('click', '.eg-step', function () {
        readInputs();
        const k = this.dataset.k;
        draft.skills[k] = Math.max(0, Math.min(E.START_MAX, draft.skills[k] + Number(this.dataset.d)));
        render();
    }).on('click', '[data-diff]', function () {
        readInputs();
        draft.difficulty = this.dataset.diff;
        render();
    }).on('click', '[data-pace]', function () {
        readInputs();
        draft.pace = this.dataset.pace;
        render();
    }).on('click', '[data-act="reguess"]', () => runGuess(true))
        .on('click', '[data-act="prompts"]', () => openPromptsSheet())
        .on('click', '#eg_start', async () => {
        draft.eroge = $('#eg_eroge').prop('checked');
        const s = S();
        s.checkCard = $('#eg_card').prop('checked');
        s.hideTracker = $('#eg_tracker').prop('checked');
        s.juice = $('#eg_juice').prop('checked');
        s.autoStart = $('#eg_auto').prop('checked');
        ctx().saveSettingsDebounced();
        const c = ctx();
        if (editing) {
            const st = currentState();
            st.difficulty = draft.difficulty;
            st.pace = draft.pace;
            st.eroge = draft.eroge;
            writeSnapshot(c.chat.length - 1, { state: st });
            await c.saveChat();
        } else {
            readInputs();
            const initial = E.newState(draft);
            E.setEcon(initial, draft.meal, draft.day);
            initial.location = draft.location || lastTracker?.location || '';
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
        const { state, record } = E.resolveCheck(st, v, { push: choice.push, dice: choice.dice, rerolled: choice.rerolled });
        writeSnapshot(ctx().chat.length - 1, { state });
        await ctx().saveChat();
        renderHud(state);
        showNotes(record.notes);
        return E.OUTCOMES[record.outcome].en;
    });
}

/** New chats start in game mode on their own: the world is read from the card, skills wait as free points. */
let autoBusy = false;
async function autoStart() {
    const c = ctx();
    if (autoBusy || !S().autoStart || !c.chatMetadata || c.chatMetadata[MODULE]) return;
    if (c.characterId == null && !c.groupId) return;
    const real = (c.chat ?? []).filter(m => !m.is_system);
    if (!real.length || real.length > 3) return;
    autoBusy = true;
    const chatId = c.getCurrentChatId?.();
    try {
        const g = await guessStart();
        const now = ctx();
        if (now.getCurrentChatId?.() !== chatId || !now.chatMetadata || now.chatMetadata[MODULE]) return;
        const initial = E.newState(g ? { time: g.time, era: g.era, location: g.location, currency: g.currency || undefined, money: g.money } : {});
        if (g) E.setEcon(initial, g.meal, g.day);
        initial.unspent = 3;
        now.chatMetadata[MODULE] = { active: true, initial, started: Date.now(), auto: true };
        if (now.chat.length) writeSnapshot(now.chat.length - 1, { state: initial });
        await now.saveMetadata();
        await now.saveChat();
        renderHud();
        hideTrackerLines();
        toastEnc('🎲 Игра началась · нажми на панель сверху, чтобы распределить навыки', 'gold');
    } catch (e) { log('auto start failed', e); } finally { autoBusy = false; }
}

function refresh() {
    autoStart();
    renderHud();
    renderEnc(isActive() ? currentState() : null);
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
    P.setOverrides(S().prompts);
    const c = ctx();
    const ev = c.eventSource;
    const et = c.eventTypes ?? c.event_types;
    ev.on(et.CHAT_CHANGED, () => { pendingRound = null; setTimeout(refresh, 50); });
    ev.on(et.MESSAGE_RECEIVED, (id, type) => { if (type !== 'impersonate' && type !== 'extension') onReply(Number(id)); });
    for (const e of [et.MESSAGE_SWIPED, et.MESSAGE_DELETED, et.MESSAGE_EDITED, et.MESSAGE_UPDATED]) if (e) ev.on(e, () => setTimeout(refresh, 30));
    for (const e of [et.CHARACTER_MESSAGE_RENDERED, et.USER_MESSAGE_RENDERED, et.MORE_MESSAGES_LOADED]) if (e) ev.on(e, () => setTimeout(hideTrackerLines, 0));
    registerCommands();
    ensureSheets();
    addHubTile();
    setTimeout(() => { addHubTile(); patchBack(); }, 1500);
    globalThis.ElephantGame = { isActive, ownsScene: isActive, currentState, openSetup, openStateSheet, openCard, openPrompts: openPromptsSheet, prompts: P, startEncounter: startEncounterFlow, engine: E, encounter: X };
    refresh();
    log('game mode ready');
}
