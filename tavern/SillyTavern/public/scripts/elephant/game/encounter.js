/*
 * Elephant Game — encounters: intimate scenes and fights played in rounds.
 *
 * One engine, seven variations picked from context:
 *   nsfw:   duet (together to the peak), duel (who breaks first, fight for control),
 *           her_lead (she rules: please her, hold out until she allows), your_lead (you lead, keep her trust)
 *   combat: fight (wear the enemy down), chase (close or open the distance), standoff (break their nerve)
 *
 * Each round: the player picks one of the action cards (or writes their own), 2d6 decide how well it
 * went, the partner's telegraphed move lands (or is stopped), the bars move. The narrator writes one
 * short beat from the result. Pure functions: the UI and the LLM calls live in index.js.
 */
import * as E from './engine.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const clone = (o) => JSON.parse(JSON.stringify(o));
const uid = () => Math.random().toString(36).slice(2, 9);

export const VARIANTS = {
    duet:      { kind: 'nsfw',   ru: 'Дуэт',            icon: '💞', en: 'a duet: two lovers moving toward the peak together', hint: 'Вместе к пику. Найди, что ей нравится, и не кончи раньше неё.', bars: ['her', 'you', 'mood'] },
    duel:      { kind: 'nsfw',   ru: 'Поединок',        icon: '😈', en: 'a duel of pleasure: whoever climaxes first loses, both fight for control', hint: 'Кто первым сдастся — проиграл. Борьба за контроль.', bars: ['her', 'you', 'control'] },
    her_lead:  { kind: 'nsfw',   ru: 'Её правила',      icon: '👑', en: 'she is in charge: Igor must please her and hold out until she allows him to finish', hint: 'Она главная. Угоди ей и продержись, пока она не разрешит.', bars: ['approval', 'you', 'her'] },
    your_lead: { kind: 'nsfw',   ru: 'Твои правила',    icon: '🎀', en: 'Igor is in charge and she gives herself to him; her trust must hold', hint: 'Ты ведёшь, она отдаётся. Не переступи её доверие.', bars: ['her', 'comfort', 'you'] },
    fight:     { kind: 'combat', ru: 'Бой',             icon: '⚔️', en: 'a fight', hint: 'Измотай противника. Его следующий ход виден — защищайся или бей первым.', bars: ['foe', 'harm', 'stress'] },
    chase:     { kind: 'combat', ru: 'Погоня',          icon: '🏃', en: 'a chase', hint: 'Сократи дистанцию (или оторвись). Препятствия видны заранее.', bars: ['distance', 'harm', 'stress'] },
    standoff:  { kind: 'combat', ru: 'Противостояние',  icon: '🗣️', en: 'a tense standoff of nerves and words', hint: 'Слом их волю раньше, чем они сломают твою.', bars: ['foe', 'stress'] },
};
export const NSFW_VARIANTS = Object.keys(VARIANTS).filter(k => VARIANTS[k].kind === 'nsfw');
export const COMBAT_VARIANTS = Object.keys(VARIANTS).filter(k => VARIANTS[k].kind === 'combat');

export const BARS = {
    her:      { ru: 'Её удовольствие', icon: '💗' },
    you:      { ru: 'Твоё возбуждение', icon: '🔥' },
    mood:     { ru: 'Настрой', icon: '🌡' },
    control:  { ru: 'Контроль', icon: '⚖️', min: -100 },
    approval: { ru: 'Её одобрение', icon: '👑' },
    comfort:  { ru: 'Её доверие', icon: '🤍' },
    foe:      { ru: 'Стойкость', icon: '🛡' },
    distance: { ru: 'Дистанция', icon: '📏' },
    harm:     { ru: 'Раны', icon: '♥', max: 3 },
    stress:   { ru: 'Стресс', icon: '⚡', max: E.STRESS_MAX },
};

/* What a partner can like. Options and preferences share this list, so the engine can match them. */
export const TAGS = {
    kiss: 'поцелуи', neck: 'шея', ears: 'ушки', breasts: 'грудь', thighs: 'бёдра', hands: 'пальцы', oral: 'оральные ласки',
    slow: 'медленный темп', fast: 'быстрый темп', deep: 'глубоко', gentle: 'нежность', rough: 'грубость', tease: 'дразнить',
    dirty: 'грязные словечки', praise: 'похвала', dominate: 'когда ей приказывают', worship: 'когда ей поклоняются',
    bite: 'укусы', hair: 'за волосы', eyes: 'взгляд в глаза', ass: 'попка', toys: 'игрушки', restraint: 'связывание', risk: 'риск быть пойманными',
};
const TAG_IDS = Object.keys(TAGS);

// ------------------------------------------------------------------ participants (several foes / partners / allies)

const FOE_BAR = [0, 45, 70, 100];
export const STATUSES = { paralyzed: 'парализована', charmed: 'очарована', aroused: 'шатает', bound: 'связана', asleep: 'уснула', weakened: 'ослаблена' };
export const STATUS_EN = { paralyzed: 'paralysed, unable to move', charmed: 'dazed by a charm, unfocused', aroused: 'dizzy and flushed, off balance', bound: 'bound or webbed in place', asleep: 'put to sleep', weakened: 'drained by a weakening curse' };
export const SIDES = ['enemy', 'ally', 'partner'];
const foesOf = (enc) => (enc.participants || []).filter(p => p.side === 'enemy');
const aliveFoes = (enc) => foesOf(enc).filter(p => p.bar > 0);
export const targetOf = (enc) => (enc?.participants || []).find(p => p.name === enc.target) || null;
export const targetName = (enc) => targetOf(enc)?.name || enc?.partner || '';

/** Cleans a participants list from the helper; `old` keeps bars the engine already owns. */
export function cleanParticipants(list, kind, state = null, old = []) {
    const out = (old || []).map(p => ({ ...p }));
    for (const raw of (Array.isArray(list) ? list : []).slice(0, 8)) {
        const name = String(raw?.name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
        if (!name) continue;
        const ex = out.find(p => p.name.toLowerCase() === name.toLowerCase());
        if (raw.gone) { if (ex) out.splice(out.indexOf(ex), 1); continue; }
        const power = clamp(Math.round(Number(raw.power) || ex?.power || 2), 1, 3);
        if (ex) {
            ex.power = power;
            if (Number.isFinite(Number(raw.bar)) && Number(raw.bar) <= 0 && ex.side === 'enemy') ex.bar = 0;
            continue;
        }
        let side = SIDES.includes(raw.side) ? raw.side : (kind === 'nsfw' ? 'partner' : 'enemy');
        if (kind === 'nsfw') side = 'partner';
        else if (side === 'partner') side = 'ally';
        let bar;
        if (side === 'enemy') bar = FOE_BAR[power];
        else if (side === 'ally') bar = 100;
        else { const n = state ? findNpc(state, name) : null; bar = n ? clamp(Math.round((n.lust ?? 30) * 0.5), 0, 50) : 15; }
        out.push({ name, side, bar, power, peaks: 0 });
    }
    return out.slice(0, 8);
}

/** Puts the selected participant's bar into the shared her/foe slot (and back). Back-compat: no participants = no-op. */
function mirror(enc) {
    const P = enc.participants;
    if (!P?.length) return;
    if (enc.kind === 'nsfw') { const t = targetOf(enc); if (t) enc.bars.her = t.bar; }
    else if (enc.bars.foe != null) {
        const t = targetOf(enc);
        const show = t?.side === 'enemy' ? t : (aliveFoes(enc)[0] || foesOf(enc)[0]);
        if (show) enc.bars.foe = show.bar;
    }
}
/** After a hit: an enemy at 0 hands the target to the next one standing. */
function retarget(enc) {
    const t = targetOf(enc);
    if (t && t.side === 'enemy' && t.bar <= 0) { const n = aliveFoes(enc)[0]; if (n) enc.target = n.name; }
    mirror(enc);
}
/** The player adds a character to the scene by hand. */
export function addTarget(state, name, side = 'enemy') {
    const s = clone(state);
    const enc = s.enc;
    if (!enc) return s;
    enc.participants = cleanParticipants([{ name, side }], enc.kind, s, enc.participants || []);
    const t = enc.participants.find(p => p.name.toLowerCase() === String(name).trim().toLowerCase());
    if (t) enc.target = t.name;
    else if (!targetOf(enc)) enc.target = defaultTarget(enc);
    mirror(enc);
    return s;
}
export function defaultTarget(enc) {
    const P = enc.participants || [];
    if (!P.length) return '';
    return (enc.kind === 'nsfw' ? P.find(p => p.side === 'partner') : (aliveFoes(enc)[0] || P.find(p => p.side === 'enemy'))) ?.name || P[0].name;
}
export function setTarget(state, name) {
    const s = clone(state);
    const enc = s.enc;
    if (!enc?.participants?.some(p => p.name === name)) return s;
    enc.target = name;
    mirror(enc);
    return s;
}
/** The text sent as the player's move: {target} filled in, or the target appended when it is ambiguous. */
export function aimText(enc, en) {
    const P = enc?.participants || [];
    const t = targetOf(enc);
    en = String(en || '');
    if (en.includes('{target}')) return en.replace(/\{target\}/g, t?.name || enc?.partner || 'them');
    if (P.length > 1 && t) return /\*$/.test(en) ? `${en.slice(0, -1)}, aimed at ${t.name}.*` : `${en} (aimed at ${t.name})`;
    return en;
}
const foeLabel = (enc) => { const f = foesOf(enc).map(p => p.name); return f.length ? f.join(', ') : enc.partner; };

export const KINDS_NSFW = ['act', 'resist', 'redirect', 'obey', 'defy', 'please'];
export const KINDS_COMBAT = ['attack', 'defend', 'trick', 'flee', 'talk', 'item'];

export const COMPLICATIONS = ['interrupt', 'laugh', 'pullback', 'clumsy', 'cold'];
const OUT_MULT = { crit: 2, success: 1, near: 0.6, fail: 0.2, disaster: 0 };
const MAX_ROUNDS = 10;
/* How hard each partner is to bring over the edge, and how hard they push back. */
const HER_F = { duet: 1, duel: 0.6, her_lead: 1.05, your_lead: 1 };
const PUSH_F = { duet: 1, duel: 1.35, her_lead: 1.05, your_lead: 0.85 };

// ------------------------------------------------------------------ start

/**
 * Starts an encounter inside the game state.
 * opts: { kind, variant, partner, power (combat 1-3), role ('chaser'|'fleeing'), prefs, title_ru, intent, options }
 */
export function startEncounter(state, opts = {}) {
    const s = E.ensureState(clone(state));
    const variant = VARIANTS[opts.variant] ? opts.variant : (opts.kind === 'combat' ? 'fight' : 'duet');
    const v = VARIANTS[variant];
    const partner = String(opts.partner || '').trim().slice(0, 40) || (v.kind === 'nsfw' ? '?' : 'Противник');
    const npc = findNpc(s, partner);
    if (npc) E.ensureNpc(npc);
    if (npc && v.kind === 'nsfw' && opts.prefs && !npc.prefs) npc.prefs = cleanPrefs(opts.prefs);
    const power = clamp(Math.round(Number(opts.power) || 2), 1, 3);
    const bars = {};
    if (v.kind === 'nsfw') {
        const n = npc || E.ensureNpc({ name: partner, attraction: 50, trust: 20, affection: 20, lust: 30, openness: 40 });
        bars.her = clamp(Math.round(n.lust * 0.5), 0, 50);
        bars.you = clamp(10 + (n.attraction >= 60 ? 10 : 0) + (n.lust >= 60 ? 5 : 0), 0, 40);
        bars.mood = clamp(Math.round(40 + n.affection * 0.25 + n.openness * 0.15), 30, 85);
        if (variant === 'duel') bars.control = 0;
        if (variant === 'her_lead') bars.approval = 5;
        if (variant === 'your_lead') bars.comfort = clamp(Math.round(30 + n.trust * 0.6), 25, 90);
    } else {
        bars.foe = [0, 45, 70, 100][power];
        if (variant === 'chase') { bars.distance = 50; delete bars.foe; }
    }
    const participants = cleanParticipants(opts.participants, v.kind, s);
    if (participants.length) {
        if (v.kind === 'combat' && variant !== 'chase') {
            const f = participants.filter(p => p.side === 'enemy');
            if (f.length) bars.foe = f[0].bar;
        } else if (v.kind === 'nsfw') {
            const pp = participants.find(p => p.side === 'partner');
            if (pp) pp.bar = bars.her;
        }
    }
    s.enc = {
        id: uid(),
        participants,
        target: '',
        kind: v.kind,
        variant,
        partner: npc?.name || partner,
        title_ru: String(opts.title_ru || '').slice(0, 60) || `${v.ru}${v.kind === 'nsfw' ? ` с ${npc?.name || partner}` : `: ${partner}`}`,
        role: opts.role === 'fleeing' ? 'fleeing' : 'chaser',
        forced: Boolean(opts.forced),
        escape: 0,
        power,
        round: 0,
        startTurn: s.turn,
        bars,
        herPeaks: 0,
        youPeak: false,
        together: false,
        lastTag: null,
        found: [],
        pose: String(opts.pose_ru || '').slice(0, 60),
        intent: cleanIntent(opts.intent),
        options: cleanOptions(opts.options, v.kind),
        status: 'active',
        log: [],
        lastRound: null,
        result: null,
    };
    if (participants.length) { s.enc.target = defaultTarget(s.enc); mirror(s.enc); if (v.kind === 'combat') s.enc.power = Math.max(s.enc.power, ...participants.filter(p => p.side === 'enemy').map(p => p.power)); }
    return s;
}

export function cleanPrefs(p = {}) {
    const pick = (a, n) => [...new Set((Array.isArray(a) ? a : []).map(x => String(x).toLowerCase()).filter(x => TAG_IDS.includes(x)))].slice(0, n);
    const loves = pick(p.loves, 2);
    const likes = pick(p.likes, 4).filter(x => !loves.includes(x));
    const dislikes = pick(p.dislikes, 3).filter(x => !loves.includes(x) && !likes.includes(x));
    return { loves, likes, dislikes };
}

export function cleanIntent(i) {
    if (!i || typeof i !== 'object') return null;
    return {
        who: String(i.who || '').slice(0, 40),
        ru: String(i.ru || '').slice(0, 120),
        en: String(i.en || '').slice(0, 220),
        power: clamp(Math.round(Number(i.power) || 1), 1, 3),
        tags: (Array.isArray(i.tags) ? i.tags : []).map(String).filter(x => TAG_IDS.includes(x)).slice(0, 3),
    };
}

/** Card labels must be short: cut at a word boundary, "…" only as a last resort. */
export function trimLabel(t, max = 16) {
    t = String(t || '').replace(/\s+/g, ' ').trim().replace(/[.!]+$/, '');
    if (t.length <= max) return t;
    const cut = t.slice(0, max + 1);
    const sp = cut.lastIndexOf(' ');
    if (sp >= Math.min(8, Math.floor(max / 2))) return cut.slice(0, sp).replace(/[,;:—-]+$/, '');
    return t.slice(0, max - 1) + '…';
}

export function cleanOptions(list, kind = 'nsfw') {
    const kinds = kind === 'nsfw' ? KINDS_NSFW : KINDS_COMBAT;
    return (Array.isArray(list) ? list : []).slice(0, 4).map((o, i) => ({
        id: `o${i}`,
        ru: trimLabel(o?.ru || o?.en || '…', (o?.say || /^[«"„]/.test(String(o?.ru || '').trim())) ? 34 : 16),
        detail_ru: String(o?.detail_ru || '').replace(/\s+/g, ' ').trim().slice(0, 140),
        risk_ru: String(o?.risk_ru || '').replace(/\s+/g, ' ').trim().slice(0, 24),
        en: String(o?.en || o?.ru || '').slice(0, 360),
        skill: E.SKILLS[o?.skill] ? o.skill : (kind === 'nsfw' ? 'passion' : 'might'),
        power: clamp(Math.round(Number(o?.power) || 2), 1, 3),
        tags: (Array.isArray(o?.tags) ? o.tags : []).map(x => String(x).toLowerCase()).filter(x => TAG_IDS.includes(x)).slice(0, 3),
        kind: kinds.includes(o?.kind) ? o.kind : kinds[0],
        stage: clamp(Math.round(Number(o?.stage) || 0), 0, E.STAGES.length - 1),
        limit: Boolean(o?.limit),
        item: String(o?.item || '').slice(0, 40),
        say: Boolean(o?.say) || /^[«"„]/.test(String(o?.ru || '').trim()),
    })).filter(o => o.en);
}

export function findNpc(s, name) {
    const q = String(name || '').trim().toLowerCase();
    if (!q) return null;
    const all = Object.values(s.npcs || {});
    return s.npcs?.[q] ?? all.find(n => n.name.toLowerCase() === q)
        ?? all.find(n => q.includes(n.name.toLowerCase()) || n.name.toLowerCase().includes(q.split(/\s+/)[0])) ?? null;
}

// ------------------------------------------------------------------ odds for a card

export function optionSetup(state, option) {
    const s = E.ensureState(clone(state));
    const enc = s.enc;
    const nsfw = enc?.kind === 'nsfw';
    let dc = nsfw ? 6 + option.power : 7 + (targetOf(enc)?.power ?? enc?.power ?? 2) + (option.power - 2);
    if (!nsfw && option.kind === 'defend') dc -= 1;
    if (!nsfw && option.kind === 'flee') dc += 1;
    if (nsfw && enc.variant === 'duel') dc -= Math.round((enc.bars.control || 0) / 40);
    if (nsfw && enc.variant === 'her_lead' && option.kind === 'defy') dc += 2;
    const npc = nsfw ? findNpc(s, targetName(enc)) : null;
    let locked = false;
    if (npc && option.stage) {
        const r = E.readiness(npc, E.readyOpts(s));
        if (option.stage > r.ready) { locked = true; dc += 2 * (option.stage - r.ready); }
    }
    dc = clamp(dc + E.DIFFICULTY[s.difficulty].dc, 4, 18);
    const mod = E.modifier(s, option.skill);
    const adv = E.hasAdvantage(s, option.skill);
    const lucky = E.hasPerk(s, 'lucky');
    const o = E.odds(mod, dc, 'risky', { adv, lucky });
    return { dc, mod, adv, lucky, locked, odds: o };
}

// ------------------------------------------------------------------ a round


/**
 * Resolves one round: the player's option with these dice, then the partner's telegraphed move.
 * Returns { state, round } — the round record is also stored as state.enc.lastRound.
 */
export function resolveRound(state, option0, { dice = null, free = false } = {}) {
    let s = E.ensureState(clone(state));
    const enc = s.enc;
    if (!enc || enc.status !== 'active') return { state: s, round: null };
    const option = cleanOptions([option0], enc.kind)[0] || { ru: '…', en: '…', skill: 'passion', power: 1, tags: [], kind: 'act', stage: 0 };
    const set = optionSetup(s, option);
    const roll = dice || E.rollDice(Math.random, set.adv ? 3 : 2);
    const outcome = E.classifyDice(roll, set.mod, set.dc, 'risky', { lucky: set.lucky });
    const mult = OUT_MULT[outcome];
    const tgt = targetOf(enc);
    if (tgt && enc.kind === 'combat' && enc.bars.foe != null) enc.bars.foe = tgt.bar;
    if (tgt && enc.kind === 'nsfw') enc.bars.her = tgt.bar;
    const B = enc.bars;
    const before = clone(B);
    const hitAlly = Boolean(tgt && tgt.side === 'ally' && enc.kind === 'combat' && ['attack', 'trick'].includes(option.kind));
    const notes = [];
    const v = enc.variant;
    enc.round += 1;
    let intentLands = true;
    let refused = false;
    let effect = '';
    let complication = null;

    if (enc.kind === 'nsfw') {
        const npc = findNpc(s, targetName(enc));
        if (npc) E.ensureNpc(npc);
        const passion = s.skills.passion ?? 1;
        // stage gate: an act beyond what she's ready for needs the roll to carry it
        if (set.locked) {
            if (mult >= 1 && npc) { npc.boost = { scene: s.scene, steps: Math.max(1, option.stage - E.readiness(npc, E.readyOpts(s)).ready) }; notes.push({ kind: 'push_ok', name: npc.name }); }
            else { refused = true; B.mood = clamp((B.mood ?? 50) - 15, 0, 100); notes.push({ kind: 'push_fail', name: enc.partner }); }
        }
        if (option.limit || (npc && option.tags.some(t => (npc.limitTags || []).includes(t)))) {
            refused = true;
            if (B.mood != null) B.mood = clamp(B.mood - 25, 0, 100);
            if (B.comfort != null) B.comfort = clamp(B.comfort - 20, 0, 100);
            notes.push({ kind: 'enc_limit', name: enc.partner });
        }
        // what she likes
        const prefs = npc?.prefs || { loves: [], likes: [], dislikes: [] };
        let pref = 1;
        for (const t of option.tags) {
            if (prefs.loves.includes(t)) { pref = Math.max(pref, 1.7); if (mult >= 1) discover(npc, t, 'spot', notes, enc); }
            else if (prefs.likes.includes(t)) { pref = Math.max(pref, 1.35); if (mult >= 1) discover(npc, t, 'like', notes, enc); }
        }
        const disliked = option.tags.find(t => prefs.dislikes.includes(t));
        if (disliked) { pref *= 0.35; if (B.mood != null) B.mood = clamp(B.mood - 10, 0, 100); if (mult >= 1) discover(npc, disliked, 'dislike', notes, enc); }
        const rep = option.tags[0] && option.tags[0] === enc.lastTag ? 0.6 : 1;
        if (rep < 1 && B.mood != null) B.mood = clamp(B.mood - 5, 0, 100);
        enc.lastTag = option.tags[0] || null;
        const moodF = 0.5 + (B.mood ?? B.comfort ?? 60) / 100;
        const lustF = 1 + (npc?.lust ?? 30) / 300;
        const ctrlF = v === 'duel' ? 1 + (B.control || 0) / 200 : 1;
        const gain = refused ? 0 : Math.round((5 + 6 * option.power) * mult * pref * rep * moodF * lustF * ctrlF * HER_F[v]);

        switch (option.kind) {
            case 'resist': {
                B.you = clamp(B.you - Math.round((7 + 4 * option.power) * mult), 0, 100);
                if (v === 'her_lead' && mult >= 1) B.approval = clamp(B.approval + 8, 0, 100);
                break;
            }
            case 'redirect': {
                if (mult >= 1) intentLands = false;
                B.her = clamp(B.her + Math.round(gain * 0.6), 0, 100);
                if (v === 'duel') B.control = clamp(B.control + (mult >= 1 ? 15 : -10), -100, 100);
                break;
            }
            case 'obey':
            case 'please': {
                const a = Math.round((5 + 5 * option.power) * mult * pref * (option.kind === 'obey' ? 1.1 : 1));
                if (v === 'her_lead') B.approval = clamp(B.approval + a, 0, 100);
                B.her = clamp(B.her + Math.round(gain * (v === 'her_lead' ? 0.6 : 1)), 0, 100);
                B.you = clamp(B.you + 2 * option.power, 0, 100);
                break;
            }
            case 'defy': {
                if (enc.forced && mult >= 1) { enc.escape += 1; notes.push({ kind: 'enc_escape', n: enc.escape }); }
                if (v === 'her_lead') B.approval = clamp(B.approval + (mult >= 1 ? 6 : -15), 0, 100);
                if (mult >= 1) intentLands = false;
                B.her = clamp(B.her + Math.round(gain * 0.8), 0, 100);
                break;
            }
            default: { // act
                B.her = clamp(B.her + gain, 0, 100);
                B.you = clamp(B.you + 2 * option.power, 0, 100);
                if (v === 'duel') B.control = clamp(B.control + (mult >= 1 ? 10 * option.power : -10), -100, 100);
                if (v === 'your_lead') {
                    const intense = option.power >= 3 || option.tags.some(t => ['rough', 'restraint', 'hair', 'bite', 'risk'].includes(t));
                    B.comfort = clamp(B.comfort + (refused ? -10 : intense ? (B.comfort < 50 || mult < 1 ? -12 : 2) : (mult >= 1 ? 4 : -2)), 0, 100);
                }
            }
        }
        if (B.mood != null && !refused) B.mood = clamp(B.mood + (mult >= 1 ? 4 + (pref > 1 ? 5 : 0) : -4), 0, 100);
        if (crit(outcome) && v !== 'her_lead') intentLands = false;
        // a miss costs something: mood, her pleasure, and her move lands harder
        let intentMult = 1;
        if (!refused) {
            if (outcome === 'near') { if (B.mood != null) B.mood = clamp(B.mood - 3, 0, 100); }
            else if (outcome === 'fail' || outcome === 'disaster') {
                const dis = outcome === 'disaster';
                if (B.mood != null) B.mood = clamp(B.mood - (dis ? 20 : 10), 0, 100);
                B.her = clamp(B.her - (dis ? 15 : 5), 0, 100);
                if (B.comfort != null) B.comfort = clamp(B.comfort - 15, 0, 100);
                if (B.approval != null && v === 'her_lead' && option.kind !== 'defy') B.approval = clamp(B.approval - (dis ? 8 : 3), 0, 100);
                intentMult = 1.5;
                if (dis) { complication = COMPLICATIONS[Math.floor(Math.random() * COMPLICATIONS.length)]; notes.push({ kind: 'complication', text: complication }); }
            }
        }
        effect = refused ? 'refused' : gain >= 25 ? 'strong' : gain >= 12 ? 'good' : gain > 0 ? 'weak' : 'nothing';

        // her move
        const intent = enc.intent;
        if (intent && intentLands) {
            const resistF = 1 - 0.06 * Math.max(0, passion - 1) - (E.hasPerk(s, 'cool') ? 0.1 : 0);
            const domF = PUSH_F[v] * (v === 'duel' ? 1 - (B.control || 0) / 200 : 1);
            B.you = clamp(B.you + Math.round(intent.power * 10 * resistF * domF * intentMult), 0, 100);
            B.her = clamp(B.her + intent.power * 3, 0, 100);
        }

        // peaks
        let herPeakNow = false;
        if (B.her >= 100) {
            enc.herPeaks += 1; herPeakNow = true;
            B.her = 30;
            if (B.mood != null) B.mood = clamp(B.mood + 10, 0, 100);
            if (v === 'her_lead') B.approval = clamp(B.approval + 25, 0, 100);
            if (tgt) tgt.peaks = (tgt.peaks || 0) + 1;
            notes.push({ kind: 'enc_peak', name: targetName(enc), n: tgt ? tgt.peaks : enc.herPeaks });
        }
        let youPeakNow = false;
        if (B.you >= 100) {
            enc.youPeak = true; youPeakNow = true; B.you = 100;
            notes.push({ kind: 'enc_you_peak' });
        }
        if (herPeakNow && youPeakNow) enc.together = true;
        if (youPeakNow && enc.log.at(-1)?.herPeak) enc.together = true;

        // how it ends
        if (enc.forced && enc.escape >= 2) enc.status = 'fled';
        else if (v === 'duet') {
            if (youPeakNow) enc.status = enc.herPeaks ? 'won' : 'early';
        } else if (v === 'duel') {
            if (herPeakNow && !youPeakNow) enc.status = 'won';
            else if (youPeakNow) enc.status = enc.together ? 'draw' : 'lost';
        } else if (v === 'her_lead') {
            if (B.approval >= 100 && !youPeakNow) { enc.status = 'won'; enc.allowed = true; }
            else if (youPeakNow) enc.status = enc.together ? 'draw' : 'lost';
        } else if (v === 'your_lead') {
            if (B.comfort <= 0) enc.status = 'lost';
            else if (youPeakNow) enc.status = enc.herPeaks ? 'won' : 'early';
        }
        enc.round_herPeak = herPeakNow;
        if (tgt) tgt.bar = B.her;
        var round = { herPeak: herPeakNow, youPeak: youPeakNow };
    } else {
        // ---------------------------------------------------------- combat
        const k = option.kind;
        const dmgBase = (10 + 8 * option.power) * mult;
        if (v === 'fight' || v === 'standoff') {
            const share = { attack: 1, trick: 0.85, talk: v === 'standoff' ? 1 : 0.3, item: 1.1, defend: 0.35, flee: 0 }[k] ?? 0.6;
            B.foe = clamp(B.foe - Math.round(dmgBase * share), 0, 100);
        } else if (v === 'chase') {
            const step = Math.round(1.4 * dmgBase * ({ attack: 1, trick: 1.1, flee: 1, item: 1.1, defend: 0.5, talk: 0.4 }[k] ?? 0.8));
            B.distance = clamp(B.distance + (enc.role === 'chaser' ? -step : step), 0, 100);
        }
        if (v === 'chase') { if (outcome === 'fail' || outcome === 'disaster') B.distance = clamp(B.distance + (enc.role === 'chaser' ? 5 : -5), 0, 100); }
        else if (outcome === 'fail' || outcome === 'disaster') B.foe = clamp(B.foe + 5, 0, 100);
        if (tgt) {
            tgt.bar = B.foe;
            if (hitAlly) {
                const an = findNpc(s, tgt.name);
                if (an) { E.ensureNpc(an); an.trust = clamp(an.trust - 5, -100, 100); }
                notes.push({ kind: 'ally_hit', name: tgt.name });
            }
            retarget(enc);
        }
        // eroge: enemies press an advantage; the failed roll can leave an ally (or the hero) harassed or hit by a binding effect
        const victims = (enc.participants || []).filter(p => p.side === 'ally' && p.bar > 0);
        for (const p of (enc.participants || [])) if (p.status && --p.status.left <= 0) { notes.push({ kind: 'status_end', name: p.name }); delete p.status; }
        const rescue = tgt && tgt.status && !hitAlly && ['defend', 'item', 'talk', 'trick'].includes(k) && mult >= 1;
        if (rescue) { notes.push({ kind: 'status_end', name: tgt.name }); delete tgt.status; }
        if (s.eroge && foesOf(enc).length && (outcome === 'fail' || outcome === 'disaster') && !rescue) {
            const vic = (tgt && tgt.side === 'ally' && tgt.bar > 0 ? tgt : null) || victims[Math.floor(Math.random() * victims.length)];
            const by = aliveFoes(enc)[0]?.name || 'the enemy';
            if (outcome === 'disaster' && vic && !vic.status) {
                const id = Object.keys(STATUSES)[Math.floor(Math.random() * 6)];
                vic.status = { id, left: 3 };
                notes.push({ kind: 'status', name: vic.name, id });
            }
            complication = 'molest';
            enc.molest = { who: vic?.name || '', by };
            notes.push({ kind: 'molest', name: vic?.name || '{{user}}' });
        }
        if (outcome === 'crit') intentLands = false;
        else if (outcome === 'success' && ['defend', 'flee', 'trick'].includes(k)) intentLands = false;
        const intent = enc.intent;
        const p = intent?.power ?? 1;
        let harm = 0;
        let stress = 0;
        if (intent && intentLands) {
            if (v === 'chase') {
                B.distance = clamp(B.distance + (enc.role === 'chaser' ? p * 5 : -p * 5), 0, 100);
                if (outcome === 'disaster') harm = 1;
            } else if (v === 'standoff') {
                stress = p;
            } else if (outcome === 'success') {
                if (p >= 3) harm = 1;
            } else {
                harm = p >= 2 ? 1 : 0;
                stress = p === 1 ? 1 : 0;
                if (outcome === 'disaster') harm += 1;
            }
        }
        if (outcome === 'disaster') stress += 1;
        if (harm && E.hasPerk(s, 'tough') && outcome === 'disaster') harm -= 1;
        if (stress && E.hasPerk(s, 'cool')) stress = Math.max(0, stress - 1);
        const ev = [];
        if (harm) s = E.hurt(s, harm, ev, notes);
        if (stress) { s.stress = clamp(s.stress + stress, 0, E.STRESS_MAX); notes.push({ kind: 'stress', delta: stress }); }
        // item use
        if (k === 'item' && option.item) E.useItem(s, option.item, 1, notes);
        const enc2 = s.enc;
        if (ev.some(e => e.kind === 'defeat')) { enc2.status = 'lost'; enc2.defeat = true; }
        else if (k === 'flee' && mult >= 1 && v !== 'chase') enc2.status = 'fled';
        else if (v === 'chase' && B.distance <= 0) enc2.status = enc2.role === 'chaser' ? 'won' : 'lost';
        else if (v === 'chase' && B.distance >= 100) enc2.status = enc2.role === 'chaser' ? 'lost' : 'won';
        else if (B.foe != null && (enc2.participants?.length ? !aliveFoes(enc2).length : B.foe <= 0)) enc2.status = 'won';
        else if (v === 'standoff' && s.stress >= E.STRESS_MAX - 1) enc2.status = 'lost';
        effect = mult >= 1 ? 'good' : mult > 0 ? 'weak' : 'nothing';
        var round = { harm, stress };
        s.enc.bars = B;
    }
    const encNow = s.enc;
    if (encNow.status === 'active' && encNow.round >= MAX_ROUNDS + Math.min(8, 3 * Math.max(0, foesOf(encNow).length - 1))) encNow.status = 'ended';

    const rec = {
        round: encNow.round,
        turn: s.turn,
        target: tgt ? { name: tgt.name, side: tgt.side } : null,
        hitAlly,
        option: { ru: option.ru, en: option.en, skill: option.skill, power: option.power, kind: option.kind, tags: option.tags },
        free,
        dice: roll, dc: set.dc, mod: set.mod, adv: set.adv,
        outcome,
        effect,
        refused,
        intent: encNow.intent,
        intentLands,
        before, after: clone(encNow.bars),
        notes,
        complication,
        ...round,
    };
    encNow.log = [...encNow.log, { round: rec.round, ru: option.ru, outcome, herPeak: rec.herPeak, youPeak: rec.youPeak }].slice(-20);
    encNow.lastRound = rec;
    encNow.options = [];
    if (encNow.status !== 'active') s = finishEncounter(s, notes);
    return { state: s, round: rec };
}

const COMP_EN = {
    molest: 'a foe presses its advantage in a teasing, threatening way: grabbing, pinning, a torn cloak or sleeve, a lewd taunt — a brief, non-sexual or fading threat, never a sex scene.',
    interrupt: 'someone approaches or a sound outside makes them freeze and listen for a moment',
    laugh: 'she laughs at him (not cruelly, but it stings and breaks the rhythm)',
    pullback: 'she pulls back for a moment, hand on his chest, breathing, needing a second',
    clumsy: 'an awkward bump, cramp, slipped grip or tangled clothing ruins the flow',
    cold: 'the mood breaks; she goes quiet and cool and needs coaxing before she warms again',
};
/** Compact "Настрой −12 · Её удовольствие −5" line from a round record (biggest changes first). */
export function deltaLine(rec, max = 3) {
    if (!rec) return '';
    const short = { her: 'Её удовольствие', you: 'Возбуждение', mood: 'Настрой', control: 'Контроль', approval: 'Одобрение', comfort: 'Доверие', foe: 'Стойкость врага', distance: 'Дистанция' };
    const parts = Object.keys(short).map(k => [k, (rec.after?.[k] ?? 0) - (rec.before?.[k] ?? 0)])
        .filter(([k, d]) => rec.after?.[k] != null && rec.before?.[k] != null && Math.abs(d) >= 2)
        .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, max)
        .map(([k, d]) => `${short[k]} ${d > 0 ? '+' : '−'}${Math.abs(d)}`);
    if (rec.complication === 'molest') parts.unshift('Враг распускает руки');
    if (rec.harm) parts.push(`Раны +${rec.harm}`);
    if (rec.stress) parts.push(`Стресс +${rec.stress}`);
    return parts.join(' · ');
}

const crit = (o) => o === 'crit';

function discover(npc, tag, kind, notes, enc) {
    if (!npc || !tag) return;
    const label = TAGS[tag];
    npc.prefsFound ??= [];
    if (npc.prefsFound.includes(tag)) return;
    npc.prefsFound.push(tag);
    enc.found.push({ tag, kind });
    if (kind === 'spot') { if (!npc.spots.includes(label)) npc.spots.push(label); notes.push({ kind: 'spot', name: npc.name, text: label }); }
    else if (kind === 'like') { if (!npc.likes.includes(label)) npc.likes.push(label); notes.push({ kind: 'like', name: npc.name, text: label }); }
    else { npc.dislikes ??= []; if (!npc.dislikes.includes(label)) npc.dislikes.push(label); notes.push({ kind: 'dislike', name: npc.name, text: label }); }
}

/** Rewards and the summary card. The encounter stays in state (status != active) until the reply lands. */
export function finishEncounter(state, notes = []) {
    const s = state;
    const enc = s.enc;
    const v = enc.variant;
    const res = { status: enc.status, stars: 0, xp: 0, rel: {} };
    if (enc.kind === 'nsfw') {
        const npc = findNpc(s, enc.partner);
        const good = ['won', 'draw'].includes(enc.status);
        res.stars = (enc.herPeaks > 0 ? 1 : 0) + (enc.together ? 1 : 0) + (((enc.bars.mood ?? 0) >= 70 || enc.allowed || (enc.bars.comfort ?? 0) >= 60 || (v === 'duel' && enc.status === 'won')) ? 1 : 0);
        res.xp = 1 + res.stars + (v === 'duel' && enc.status === 'won' ? 2 : 0);
        if (npc) {
            E.ensureNpc(npc);
            const d = { affection: res.stars, attraction: 1 + res.stars, trust: good || enc.status === 'early' ? 1 : (v === 'your_lead' ? -4 : 0) };
            if (enc.status === 'early') d.attraction = 0;
            for (const [k, x] of Object.entries(d)) npc[k] = clamp(npc[k] + x, k === 'trust' ? -100 : 0, 100);
            npc.openness = clamp(npc.openness + (v === 'duet' ? 1 : 2), 0, 100);
            npc.scenes = (npc.scenes || 0) + 1;
            npc.bestStars = Math.max(npc.bestStars || 0, res.stars);
            res.rel = d;
        }
        if (v === 'duel' && enc.status === 'lost') { s.stress = clamp(s.stress + 2, 0, E.STRESS_MAX); notes.push({ kind: 'stress', delta: 2 }); }
    } else {
        res.xp = enc.status === 'won' ? 2 + enc.power : enc.status === 'fled' ? 1 : 2;
    }
    if (E.hasPerk(s, 'fast_learner') && enc.status === 'lost') res.xp += 1;
    s.xp += res.xp;
    notes.push({ kind: 'xp', delta: res.xp, why: VARIANTS[v].ru.toLowerCase() });
    E.levelUpState(s, notes);
    enc.result = res;
    return s;
}

// ------------------------------------------------------------------ narrator

const bandHer = (x) => x >= 85 ? 'right on the edge, about to come' : x >= 65 ? 'close, losing composure' : x >= 40 ? 'well into it, breathing hard' : x >= 20 ? 'warming up, responsive' : 'just starting, still composed';
const bandYou = (x, u) => x >= 85 ? `${u} is barely holding back` : x >= 65 ? `${u} is getting close` : x >= 40 ? `${u} is very turned on` : `${u} is in control of himself`;
const OUT_EN = { crit: 'BRILLIANTLY — better than hoped', success: 'well', near: 'only partly — it half-works', fail: 'badly — it misses or falls flat', disaster: 'disastrously — it goes wrong' };

/** The block the narrator sees for a round that has just been resolved (or nothing). */
export function encounterBlock(state, userName = '{{user}}') {
    const enc = state.enc;
    if (!enc) return '';
    const r = enc.lastRound;
    const v = VARIANTS[enc.variant];
    const u = userName;
    const who = targetName(enc);
    const P = enc.participants || [];
    const lines = [];
    if (!r || r.turn !== state.turn) {
        if (enc.status === 'active') lines.push(`ENCOUNTER in progress: ${v.en} with ${P.length ? P.map(p => p.name).join(', ') : who}. Keep replies to one short beat (80-130 words).`);
        return lines.join('\n');
    }
    if (enc.forced && enc.kind === 'nsfw') lines.push(`${who} started this without asking: she is taking ${u}, and he may struggle against it or give in.`);
    lines.push(`ENCOUNTER — ${v.en}${enc.kind === 'nsfw' ? ` with ${P.length > 1 ? P.map(p => p.name).join(' and ') : who}` : ` against ${foeLabel(enc)}`}, round ${r.round}. Write ONE short beat for this round only: 80-130 words, vivid, in the scene's voice. Never mention numbers, bars, rounds or dice.`);
    if (P.length > 1) {
        const band = (p) => enc.kind === 'nsfw' ? bandHer(p.bar) : p.side === 'ally' ? (p.bar <= 0 ? 'knocked out' : p.bar <= 40 ? 'battered' : 'holding up') : (p.bar <= 0 ? 'down' : p.bar <= 25 ? 'nearly broken' : p.bar <= 60 ? 'hurt' : 'still strong');
        lines.push(`WHO IS HERE: ${P.map(p => `${p.name} (${p.side}, ${band(p)})`).join('; ')}. ${u}'s move this round was aimed at ${who}; the others act around it, in character.`);
    }
    const sts = P.filter(p => p.status);
    if (sts.length) lines.push(`STATUS: ${sts.map(p => `${p.name} is ${STATUS_EN[p.status.id]} (${p.status.left} more rounds unless freed)`).join('; ')}. Show it in the beat. This is a predicament to escape or be rescued from — a status is only a combat debuff.`);
    if (r.notes.some(n => n.kind === 'status')) lines.push(`NEW EFFECT: ${r.notes.filter(n => n.kind === 'status').map(n => `${n.name} is hit by a ${STATUS_EN[n.id]} effect`).join('; ')} — the enemy's spell, venom, web or potion lands; describe it.`);
    if (r.hitAlly) lines.push(`${u} turned on his ally ${who}: show her shock, hurt or anger; she may fight back or lose trust in him.`);
    const act = r.free ? `${u}'s own move` : `${u}'s move ("${r.option.en.replace(/\{target\}/g, who).replace(/^\*|\*$/g, '')}")`;
    if (r.refused) lines.push(`THIS ROUND: ${act} — ${who} stops it or turns it down: ${enc.kind === 'nsfw' ? 'not that, not now; in character, the mood dips but she stays in the scene' : 'it fails'}.`);
    else lines.push(`THIS ROUND: ${act} goes ${OUT_EN[r.outcome]}${enc.kind === 'nsfw' ? ` (effect on ${who}: ${r.effect})` : ''}.`);
    if (!r.refused && (r.outcome === 'fail' || r.outcome === 'disaster')) {
        const dis = r.outcome === 'disaster';
        if (enc.kind === 'nsfw') {
            lines.push(`WHAT WENT WRONG: ${u}'s move ${dis ? 'badly backfires' : 'misjudges the moment'} — pick one that fits (wrong spot, too much too fast, a clumsy hand, bad timing, a line that falls flat). Show it clearly in the beat, and show ${who}'s mood visibly cooling: ${dis ? 'she stiffens, pulls back or loses the thread' : 'a flicker of disappointment, a breath of distance, less eager'}. Her pleasure dips instead of rising.`);
            if (r.complication) lines.push(`COMPLICATION: ${COMP_EN[r.complication]}; show it clearly in this beat.`);
        } else {
            lines.push(`WHAT WENT WRONG: ${u}'s move ${dis ? 'goes badly wrong — a misjudged step, a bad angle, a slip' : 'is misjudged — too slow, wrong angle or wrong moment'}; show it, and show ${who} gaining ground because of it.${dis ? ` ${u} is shaken and off balance.` : ''}`);
        }
    } else if (!r.refused && r.outcome === 'near' && enc.kind === 'nsfw') lines.push('It half-works: a small hitch or awkward beat takes a little of the heat out of the moment.');
    if (r.intent) lines.push(r.intentLands ? `THEN ${r.intent.who || who}: ${r.intent.en} — and it lands.` : `${r.intent.who || who} tried to ${r.intent.en.replace(/^she |^he |^they /i, '')} but ${u}'s move stops or turns it.`);
    const B = enc.bars;
    if (enc.kind === 'nsfw') {
        lines.push(`NOW (show through bodies and voices): ${who}: ${bandHer(B.her)}; ${bandYou(B.you, u)}${B.mood != null ? `; mood: ${B.mood >= 70 ? 'hot and close' : B.mood >= 40 ? 'good' : 'cooling, a little off'}` : ''}${B.control != null ? `; control: ${B.control >= 30 ? u + ' has the upper hand' : B.control <= -30 ? who + ' has the upper hand' : 'contested'}` : ''}${B.approval != null ? `; she is ${B.approval >= 70 ? 'very pleased with him' : B.approval >= 40 ? 'satisfied so far' : 'not yet impressed'}` : ''}${B.comfort != null ? `; her trust: ${B.comfort >= 60 ? 'she is giving herself completely' : B.comfort >= 30 ? 'holding' : 'shaky, she is close to stopping'}` : ''}.`);
        if (r.herPeak) lines.push(`${who} CLIMAXES in this beat${enc.herPeaks > 1 ? ' (again)' : ''}: write it fully, broken speech and all.`);
        if (r.youPeak) lines.push(`${u} can't hold back any more: he climaxes in this beat${enc.together ? ', together with her' : ''}. Show it through her eyes and his body; do not write his words.`);
        if (r.notes.some(n => n.kind === 'spot')) lines.push(`${who} reacts unusually strongly: ${u} has found one of her most sensitive spots.`);
    } else {
        lines.push(`NOW: ${B.foe != null ? `${who} is ${B.foe <= 25 ? 'nearly broken' : B.foe <= 60 ? 'hurt and shaken' : 'still strong'}` : ''}${B.distance != null ? `distance: ${B.distance <= 20 ? 'almost within reach' : B.distance >= 80 ? 'almost gone' : 'still a gap'}` : ''}${r.harm ? `; ${u} takes a hit` : ''}${r.stress ? `; ${u} is rattled` : ''}.`);
    }
    if (enc.status !== 'active') {
        const end = {
            won: enc.kind === 'nsfw' ? (enc.variant === 'her_lead' ? `${who} finally allows ${u} to finish. This is the last beat of the scene: let it land, then the afterglow.` : `This is the last beat of the scene: the release lands, then the afterglow.`) : `${u} wins: ${who} is beaten, gives up or is caught. Last beat of the encounter.`,
            early: `${u} came before her. Last beat of the scene: she reacts in character (teasing, amused, a little frustrated, or kind), afterglow.`,
            lost: enc.kind === 'nsfw' ? (enc.variant === 'your_lead' ? `${who} stops the scene: it went too far for her. Last beat: she pulls back, in character.` : `${who} wins this one. Last beat: she savours her victory, in character.`) : `${u} loses this ${v.en.replace(/^a /, '')}: the worst plausible outcome lands. Last beat of the encounter.`,
            draw: 'They break together. Last beat of the scene, then the afterglow.',
            fled: enc.kind === 'nsfw' ? `${u} breaks free and stops it. Last beat: ${who} reacts in character (amused, offended, hungry for a next time, or backing off).` : `${u} gets away. Last beat of the encounter.`,
            ended: 'This is the last beat of the encounter: wind it down.',
        }[enc.status];
        lines.push(end);
        if (state.eroge && enc.kind === 'combat' && enc.status === 'lost') lines.push(`ERO-GE: the defeat leaves ${P.find(p => p.side === 'ally')?.name || 'whoever lost (an ally or a female foe)'} in a revealing, helpless or humiliating predicament that ${u} can see — torn or slipping clothes, bindings, a compromising pose, capture; played for embarrassment and tease, then it moves to rescue, escape or aftermath. `);
    }
    return lines.join('\n');
}

// ------------------------------------------------------------------ helper prompts

function partnerSheet(state, enc) {
    const npc = findNpc(state, enc.partner);
    if (!npc) return `${enc.partner}: no record yet.`;
    const n = E.ensureNpc(clone(npc));
    const r = E.readiness(n, E.readyOpts(state));
    return `${E.npcLine(n, '{{user}}', state)}\nIntimacy ladder (0-8): ${E.STAGES.map((s, i) => `${i}=${s.id}`).join(', ')}. Ready now up to: ${r.ready}.${n.limits.length ? `\nHer limits: ${n.limits.join(', ')}` : ''}`;
}

const partsSchema = (nsfw) => nsfw ? '{"name":"her name","power":1-3}' : '{"name":"1-3 words","side":"enemy|ally","power":1-3}';
const partsRule = (nsfw) => nsfw
    ? 'participants: every partner actually in the scene (usually one; several only if the narration really has several).'
    : 'participants: EVERY character actually in the fight from the narration, one entry each (3 goblins = 3 entries "Гоблин 1"..., or "Гоблины ×3" if truly indistinguishable); enemies side "enemy"; companions fighting on ${user}\'s side (a sorceress, a guard) side "ally"; power = how dangerous each one is.';
const erogeNote = (state) => state?.eroge ? '\n' + E.EROGE_HELPER_NOTE + (state.enc?.participants?.some(p => p.status) ? '\nSomeone in the scene is under a status effect: make 1-2 of the four cards a way to free or protect them (kind defend/item/talk aimed at that character: resist, dispel, cure, pull them away, rescue).' : '') : '';

export function startPrompt({ state, kind, partner, narration, card, user, char, forced = false }) {
    const nsfw = kind === 'nsfw';
    return `An ${nsfw ? 'intimate scene' : 'action encounter'} is starting in an interactive story. Set it up as a mini-game.

${nsfw ? `Variations: duet (mutual lovemaking, both move toward the peak together — the default), duel (a playful or real contest of pleasure: whoever comes first loses — for succubi, rivals, bets, competitive or predatory characters), her_lead (she is dominant and in charge: ${user} must please her and hold out until she allows), your_lead (she is submissive or asks ${user} to take charge; ${user} leads, her trust must hold).` : `Variations: fight (a physical fight), chase (someone runs, someone pursues), standoff (a tense confrontation of nerves, threats or words).`}
Pick the variation that fits the character and the moment.${forced ? ` She is taking ${user} without asking: pick her_lead or duel, and make one of the four cards a way to break free or push her off (kind defy).` : ''}

Character card (${char}):
${String(card || '').slice(0, 1800)}

${nsfw ? `Partner record:\n${partnerSheet(state, { partner })}\n` : ''}Last narration:
<narration>
${String(narration || '').slice(-1800)}
</narration>

Reply with ONE line of JSON:
{"variant":"${nsfw ? 'duet|duel|her_lead|your_lead' : 'fight|chase|standoff'}","participants":[${partsSchema(nsfw)}],"partner":"${nsfw ? 'her name' : 'opponent name, 1-3 words'}","title_ru":"короткое название сцены",${nsfw ? `"prefs":{"loves":[1-2 tags],"likes":[2-4 tags],"dislikes":[1-2 tags]},` : `"power":1-3 (opponent strength: 1 weak, 2 even match, 3 dangerous),"role":"chaser|fleeing",`}
${optionsSchema(nsfw)}}
${partsRule(nsfw).replace('${user}', user)}
${nsfw ? `prefs: her hidden tastes, true to the card, from these tags only: ${TAG_IDS.join(', ')}.` : ''}
${optionsRules(nsfw, user)}${erogeNote(state)}`;
}

function optionsSchema(nsfw) {
    return `"pose_ru":"${nsfw ? 'текущая поза и действие прямо сейчас, 3-7 слов, например «Она сверху, медленно двигается» или «Прижата к стене, его рука под юбкой»' : 'положение сейчас, 3-7 слов, например «Сцепились у стойки»'}","intent":{"who":"кто именно действует","ru":"что она/он сейчас собирается сделать, 4-10 слов","en":"what they are about to do, 1 short sentence, third person","power":1-3${nsfw ? ',"tags":[]' : ''}},
"options":[{"say":bool,"ru":"ПРОСТАЯ метка, 1-2 слова, до 16 символов («Атаковать», «Поцеловать», «Уклониться», «Раздеть», «Прижать», «Дразнить»); для реплики — короткая фраза в «ёлочках», до 4 слов","detail_ru":"подробно по-русски, одно предложение: что именно делает герой и чем рискует (показывается только после выбора)","risk_ru":"1-3 слова о риске или отдаче, можно пусто","en":"*detailed, specific first-person action in English, 1-2 sentences grounded in the scene; write {target} where the target's name goes*","skill":"${nsfw ? 'passion|charm|finesse|resolve|insight' : 'might|finesse|insight|charm|resolve|lore'}","power":1-3,"kind":"${nsfw ? KINDS_NSFW.join('|') : KINDS_COMBAT.join('|')}"${nsfw ? ',"tags":[1-3 tags],"stage":0-8,"limit":bool' : ',"item":"item name if it uses one"'}}]`;
}

function optionsRules(nsfw, user, recent = []) {
    const avoid = recent.length ? `\nDo NOT repeat or paraphrase these recent cards (verbs, actions, body parts): ${recent.join('; ')}.` : '';
    const lang = `\nLabels ("ru"): Russian, SIMPLE and SHORT: 1-2 words, at most 16 characters ("Атаковать", "Поцеловать", "Уклониться", "Раздеть", "Прижать", "Дразнить"); spoken cards are a short phrase in «ёлочках», at most 4 words. All the detail goes into "en": it is sent as ${user}'s message, so make it a specific, vivid first-person action (1-2 sentences) using details of the scene; use {target} for the name of whoever the move is aimed at when there are several characters. "risk_ru": 1-3 words about the gamble or the payoff ("рискованно", "может понравиться", "она может отказать", "надёжно"), different on each card.`;
    return (nsfw
        ? `Options: exactly 4 cards that are genuinely DIFFERENT from each other, each grounded in a specific detail of the latest narration (her body, her clothes, the place, a prop, ${user}'s inventory, what she just said or did). Required mix:
1. TENDER or sensual (power 1-2): slow, attentive, a touch or a kiss placed somewhere specific.
2. BOLD (power 3): the high-risk move that can ruin the mood or blow her away.
3. SITUATION-CHANGER: a new position, a new place, removing or moving clothing, using the room or an item ${user} carries, a game, a tease, a bit of roleplay, a dare.
4. VERBAL or TACTICAL: holding back, or turning her telegraphed move (kind redirect or resist).
SPOKEN LINES: one or two of the four cards are things ${user} SAYS, not does (say: true): a tease, a compliment, a command, a confession, a dirty promise, a question that makes her blush, a challenge; in his own voice, fitting the moment and the variation. For these, ru = the phrase itself in Russian in «ёлочках», at most 4 words ("«Ты дрожишь»"), and en = *the exact words in quotes, plus at most a short tag* (e.g. "I lean in. \"You're shaking. I like that.\""); skill charm (or passion for dirty talk, insight for a question that reads her). A spoken card can be any of the four styles.
Rotate which style leads from round to round; do not repeat the pattern of the previous round. Follow the variation: duel = every card fights for control (pin, steal the initiative, make her break first); her_lead = obey / please / defy with real stakes (defy can win her over or cost ${user}); your_lead = ${user} leads with care, reads her, asks, builds trust; bold cards risk her trust. ${user}'s skill passion = technique, charm = words, finesse = precise hands, resolve = holding out, insight = reading her. power 1 = light, 3 = intense. stage = the ladder step the act belongs to; never offer acts more than one step above "ready now". limit: true only if it touches one of her limits. The intent is her next move toward ${user}, building from the narration.`
        : `Options: exactly 4 cards, each specific to the opponent's telegraphed move and to the surroundings in the latest narration:
1. ATTACK (name the strike and the target).
2. DEFEND or EVADE aimed at the telegraphed move.
3. ENVIRONMENT TRICK: use a named object, terrain, light, crowd or a hazard from the narration.
4. WILDCARD: a bold gamble (power 3), or an item ${user} carries.
SPOKEN LINES: one of the four cards (two in a standoff) is something ${user} SAYS (say: true): a taunt, a threat, a bluff, a bargain, a calm word, kind talk; ru = the phrase in Russian in «ёлочках», at most 4 words; en = *the exact words in quotes, plus at most a short tag*; skill charm (bluff, persuade), resolve (calm, threat) or insight.
Do not offer two cards of the same kind. The intent is the opponent's next move, telegraphed so ${user} can react.`) + lang + avoid;
}

export function nextPrompt({ state, narration, user }) {
    const enc = state.enc;
    const nsfw = enc.kind === 'nsfw';
    const B = enc.bars;
    return `Mini-game round ${enc.round + 1} of ${VARIANTS[enc.variant].en} between ${user} and ${enc.partner}.
${nsfw ? partnerSheet(state, enc) : `Opponent strength ${enc.power}/3. ${user} carries: ${E.itemsLine(state) || 'nothing useful'}.`}
Bars: ${Object.entries(B).map(([k, x]) => `${k} ${x}`).join(', ')}. Last moves: ${enc.log.slice(-3).map(l => l.ru).join('; ') || 'none'}.

Latest narration:
<narration>
${String(narration || '').slice(-1600)}
</narration>

Participants now: ${(enc.participants || []).map(p => `${p.name} (${p.side}, bar ${p.bar})`).join('; ') || 'single opponent'}. Selected target: ${targetName(enc)}.
Reply with ONE line of JSON: {"participants":[{"name":"","side":"enemy|ally|partner","power":1-3,"gone":bool,"bar":0 only if knocked out}],${optionsSchema(nsfw)}}
participants: include only NEW arrivals, and anyone knocked out, fled or gone (gone:true or bar 0); otherwise [].
${optionsRules(nsfw, user, enc.log.slice(-5).map(l => l.ru))}${erogeNote(state)}${enc.forced && nsfw ? `\nShe started this without asking: one of the four cards is always a way to break free or push her off (kind defy)${enc.escape ? ' — he already got partly free once' : ''}.` : ''}`;
}

export function classifyPrompt({ state, action, narration, user }) {
    const enc = state.enc;
    const nsfw = enc.kind === 'nsfw';
    return `In a ${VARIANTS[enc.variant].en} mini-game, ${user} wrote their own move. Classify it as one option card.
${nsfw ? partnerSheet(state, enc) : ''}
Narration: ${String(narration || '').slice(-800)}
${user}'s move: ${String(action || '').slice(0, 600)}
Selected target: ${targetName(enc)}.
Reply with ONE line of JSON: {"ru":"1-2 слова, до 16 символов","en":"the move, 1-2 specific sentences","skill":"${nsfw ? 'passion|charm|finesse|resolve|insight' : 'might|finesse|insight|charm|resolve|lore'}","power":1-3,"kind":"${nsfw ? KINDS_NSFW.join('|') : KINDS_COMBAT.join('|')}"${nsfw ? ',"tags":[from: ' + TAG_IDS.join(', ') + '],"stage":0-8,"limit":bool' : ',"item":""'}}`;
}
