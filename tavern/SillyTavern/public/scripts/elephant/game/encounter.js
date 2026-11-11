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
import * as P from './prompts.js';
import * as ST from './status.js';

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
    stress:   { ru: 'Силы', icon: '⚡', max: E.STRESS_MAX },
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
/** Conditions an enemy uses in eroge mode to put someone in a predicament. */
const PREDICAMENTS = ['paralyzed', 'charmed', 'aroused', 'bound', 'asleep', 'weakened'];
/** Old saves kept one `status` per fighter. */
function upgrade(p) { if (p && p.status) { ST.add(p, p.status.id, { left: p.status.left }); delete p.status; } return p; }
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
        if (ex) upgrade(ex);
        if (raw.gone) { if (ex && !ST.cannotLeave(ex)) out.splice(out.indexOf(ex), 1); continue; }
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
        out.push({ name, side, bar, power, peaks: 0, statuses: [] });
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
const MAX_ROUNDS = 12;
/* How hard each partner is to bring over the edge, and how hard they push back. */
const HER_F = { duet: 1.1, duel: 0.8, her_lead: 1.1, your_lead: 1.1 };
const PUSH_F = { duet: 0.8, duel: 1.0, her_lead: 0.8, your_lead: 0.7 };
/** With an edge (an opening you made), the next strike or caress is easier and lands harder. */
const EDGE_MOD = 2, EDGE_MULT = 1.5, FOCUS_MOD = 2;
const SETUP_KINDS = { nsfw: ['redirect', 'resist', 'please'], combat: ['trick', 'defend', 'talk'] };
const PAYOFF_KINDS = { nsfw: ['act', 'obey', 'defy'], combat: ['attack', 'item'] };
export const usesEdge = (enc, option) => Boolean(enc?.edge) && PAYOFF_KINDS[enc.kind].includes(option.kind);
export const makesEdge = (enc, option) => SETUP_KINDS[enc.kind].includes(option.kind);

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
    // a lone opponent is a participant too: conditions (stunned, bound…) need someone to hold them
    if (!participants.length && partner !== '?') participants.push({ name: npc?.name || partner, side: v.kind === 'nsfw' ? 'partner' : 'enemy', bar: v.kind === 'nsfw' ? bars.her : (bars.foe ?? 100), power, peaks: 0, statuses: [] });
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
        inflict: ST.statusId(i.inflict) || '',
        target: String(i.target || '').slice(0, 40),
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
        inflict: ST.statusId(o?.inflict) || '',
    })).filter(o => o.en);
}

export function findNpc(s, name) {
    return E.resolveNpc(s, name);
}

// ------------------------------------------------------------------ odds for a card

/** Why the hero cannot play this card right now (his own condition), or ''. */
export function heroBlocked(s, enc, option) {
    const b = ST.blockOf(s);
    if (!b || !enc) return '';
    const k = option.kind;
    const allowed = b === 'act' ? ['defend', 'resist', 'defy'] : b === 'move' ? ['defend', 'resist', 'defy', 'talk', 'please', 'obey'] : ['defend', 'resist', 'defy', 'talk', 'trick', 'flee', 'item', 'please', 'obey', 'redirect', 'act'];
    if (allowed.includes(k) && !(b === 'attack' && k === 'attack')) return '';
    const st = ST.listOf(s).find(x => ST.STATUSES[x.id].block === b);
    return ST.STATUSES[st.id].ru;
}
/** The fighter behind the announced move. */
function actorOf(enc) {
    const who = enc.intent?.who;
    const P = enc.participants || [];
    return (who && P.find(p => E.sameName(p.name, who))) || (enc.kind === 'combat' ? aliveFoes(enc)[0] : targetOf(enc)) || null;
}

export function optionSetup(state, option, { focus = false } = {}) {
    const s = E.ensureState(clone(state));
    const enc = s.enc;
    const nsfw = enc?.kind === 'nsfw';
    let dc = nsfw ? 5 + option.power : 6 + (targetOf(enc)?.power ?? enc?.power ?? 2) + (option.power - 2);
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
    const tg = targetOf(enc);
    const open = Boolean(tg && tg.side !== 'ally' && ST.isOpen(tg) && PAYOFF_KINDS[enc.kind].includes(option.kind));
    const edge = usesEdge(enc, option) || open;
    const blocked = heroBlocked(s, enc, option);
    if (blocked) dc = clamp(dc + 4, 4, 18);
    const canFocus = E.energyOf(s) > 0;
    const mod = E.modifier(s, option.skill) + (edge ? EDGE_MOD : 0) + (focus && canFocus ? FOCUS_MOD : 0);
    const adv = E.hasAdvantage(s, option.skill);
    const lucky = E.hasPerk(s, 'lucky');
    const o = E.odds(mod, dc, 'risky', { adv, lucky });
    return { dc, mod, adv, lucky, locked, edge, open, blocked, focus: Boolean(focus && canFocus), odds: o };
}

/**
 * What a card does if it works, as short chips for the card itself: the player sees the stakes
 * before choosing. Likes already discovered are shown; undiscovered ones stay a surprise.
 */
export function previewOption(state, option) {
    const enc = state?.enc;
    if (!enc) return [];
    const out = [];
    const edge = usesEdge(enc, option);
    const m = edge ? EDGE_MULT : 1;
    const k = option.kind;
    if (enc.kind === 'combat') {
        const base = (10 + 8 * option.power) * m;
        if (enc.variant === 'chase') {
            const step = Math.round(1.4 * base * ({ attack: 1, trick: 1.1, flee: 1, item: 1.1, defend: 0.5, talk: 0.4 }[k] ?? 0.8));
            out.push(`📏 ${enc.role === 'chaser' ? '−' : '+'}${step}`);
        } else if (k === 'flee') out.push('🚪 выйти из боя');
        else {
            const share = { attack: 1, trick: 0.85, talk: enc.variant === 'standoff' ? 1 : 0.3, item: 1.1, defend: 0.35 }[k] ?? 0.6;
            out.push(`🛡 −${Math.round(base * share)}`);
        }
        if (['defend', 'flee', 'trick'].includes(k)) out.push('🤺 отбивает удар');
    } else {
        const npc = findNpc(state, targetName(enc));
        const B = enc.bars;
        const moodF = 0.5 + (B.mood ?? B.comfort ?? 60) / 100;
        const gain = Math.round((5 + 6 * option.power) * moodF * (1 + (npc?.lust ?? 30) / 300) * (enc.variant === 'duel' ? 1 + (B.control || 0) / 200 : 1) * HER_F[enc.variant] * m);
        if (k === 'resist') out.push(`🔥 −${Math.round((12 + 6 * option.power) * m)} тебе`);
        else if (k === 'redirect') out.push(`💗 +${Math.round(gain * 0.6)}`, '↩ сбивает её ход');
        else if (k === 'defy') out.push(enc.forced ? '🏃 вырваться' : '↩ перехватить', `💗 +${Math.round(gain * 0.8)}`);
        else if (enc.variant === 'her_lead' && (k === 'please' || k === 'obey')) out.push(`👑 +${Math.round((9 + 6 * option.power) * m)}`, `💗 +${Math.round(gain * 0.6)}`);
        else out.push(`💗 +${gain}`);
        const found = npc?.prefsFound || [];
        const prefs = npc?.prefs || { loves: [], likes: [], dislikes: [] };
        const known = option.tags.filter(t => found.includes(t));
        if (known.some(t => prefs.loves.includes(t))) out.push('✨ её слабость');
        else if (known.some(t => prefs.likes.includes(t))) out.push('💗 ей нравится');
        if (known.some(t => prefs.dislikes.includes(t))) out.push('👎 не любит');
        if (option.tags[0] && option.tags[0] === enc.lastTag) out.push('↻ повтор');
    }
    if (edge) out.push('⚡ с преимуществом');
    else if (makesEdge(enc, option) && !enc.edge) out.push('→ ⚡ преимущество');
    return out;
}

// ------------------------------------------------------------------ a round


/**
 * Resolves one round: the player's option with these dice, then the partner's telegraphed move.
 * Returns { state, round } — the round record is also stored as state.enc.lastRound.
 */
export function resolveRound(state, option0, { dice = null, free = false, focus = false } = {}) {
    let s = E.ensureState(clone(state));
    const enc = s.enc;
    if (!enc || enc.status !== 'active') return { state: s, round: null };
    const option = cleanOptions([option0], enc.kind)[0] || { ru: '…', en: '…', skill: 'passion', power: 1, tags: [], kind: 'act', stage: 0 };
    const set = optionSetup(s, option, { focus });
    const roll = dice || E.rollDice(Math.random, set.adv ? 3 : 2);
    const outcome = E.classifyDice(roll, set.mod, set.dc, 'risky', { lucky: set.lucky });
    const usedEdge = set.edge;
    const mult = OUT_MULT[outcome] * (usedEdge ? EDGE_MULT : 1);
    const focusNotes = [];
    if (set.focus) E.strain(s, 1, focusNotes, 'Собраться');
    if (usedEdge) enc.edge = false;
    const tgt = targetOf(enc);
    if (tgt && enc.kind === 'combat' && enc.bars.foe != null) enc.bars.foe = tgt.bar;
    if (tgt && enc.kind === 'nsfw') enc.bars.her = tgt.bar;
    const B = enc.bars;
    const before = clone(B);
    const hitAlly = Boolean(tgt && tgt.side === 'ally' && enc.kind === 'combat' && ['attack', 'trick'].includes(option.kind));
    const notes = focusNotes;
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
                B.you = clamp(B.you - Math.round((12 + 6 * option.power) * mult), 0, 100);
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
                const a = Math.round((9 + 6 * option.power) * mult * pref * (option.kind === 'obey' ? 1.1 : 1));
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
                if (option.inflict === 'bound' && mult >= 1 && !refused && tgt) { const e = ST.add(tgt, 'bound', { by: '{{user}}' }); notes.push({ kind: 'status', name: tgt.name, id: 'bound', left: e.left }); }
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
                intentMult = 1.25;
                if (dis) { complication = COMPLICATIONS[Math.floor(Math.random() * COMPLICATIONS.length)]; notes.push({ kind: 'complication', text: complication }); }
            }
        }
        effect = refused ? 'refused' : gain >= 25 ? 'strong' : gain >= 12 ? 'good' : gain > 0 ? 'weak' : 'nothing';

        // her move
        const intent = enc.intent;
        const partnerHeld = Boolean(tgt && ST.blockOf(tgt));
        // the hero strains out of what holds him
        if (mult >= 1 && ['resist', 'defy'].includes(option.kind)) for (const id of ST.free(s)) notes.push({ kind: 'status_end', name: '', id });
        if (intent && intentLands && partnerHeld) notes.push({ kind: 'helpless', name: tgt.name, id: ST.listOf(tgt).find(x => ST.STATUSES[x.id].block)?.id });
        if (intent && intentLands && !partnerHeld) {
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
            if (v === 'duet' || v === 'your_lead') B.you = clamp(B.you + 15, 0, 100); // watching her come pulls him along
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
        const victims = (enc.participants || []).filter(p => p.side === 'ally' && p.bar > 0);
        const baseOk = OUT_MULT[outcome] >= 1;
        // a blow wakes a sleeper; a move that really pins, blinds or scares leaves its mark
        if (tgt && OUT_MULT[outcome] > 0 && ['attack', 'item'].includes(k) && ST.has(tgt, 'asleep')) { ST.remove(tgt, 'asleep'); notes.push({ kind: 'status_end', name: tgt.name, id: 'asleep' }); }
        if (option.inflict && baseOk && tgt && tgt.side === 'enemy' && tgt.bar > 0) {
            const e = ST.add(tgt, option.inflict, { by: '{{user}}' });
            if (e) { if (outcome === 'crit') e.left += 1; notes.push({ kind: 'status', name: tgt.name, id: e.id, left: e.left }); }
        }
        // the hero breaks out of what holds him; an ally is freed by a successful rescue
        if (baseOk && k === 'defend') for (const id of ST.free(s)) notes.push({ kind: 'status_end', name: '', id });
        const rescue = tgt && tgt.side === 'ally' && ST.blockOf(tgt) && !hitAlly && ['defend', 'item', 'talk', 'trick'].includes(k) && baseOk;
        if (rescue) for (const id of ST.free(tgt)) notes.push({ kind: 'status_end', name: tgt.name, id });
        // poison and bleeding wear a fighter down
        for (const p of (enc.participants || [])) {
            const dot = ST.dotOf(p);
            if (dot && p.bar > 0 && p.side !== 'partner') { p.bar = clamp(p.bar - dot, 0, 100); if (p === targetOf(enc) && B.foe != null) B.foe = p.bar; }
        }
        retarget(enc);
        // eroge: enemies press an advantage; a disastrous roll can leave an ally in a predicament
        const actor = actorOf(enc);
        const helpless = Boolean(actor && ST.cannotStrike(actor));
        if (s.eroge && !helpless && foesOf(enc).length && (outcome === 'fail' || outcome === 'disaster') && !rescue) {
            const vic = (tgt && tgt.side === 'ally' && tgt.bar > 0 ? tgt : null) || victims[Math.floor(Math.random() * victims.length)];
            const by = aliveFoes(enc)[0]?.name || 'the enemy';
            if (outcome === 'disaster' && vic && !ST.blockOf(vic) && !enc.intent?.inflict) {
                const e = ST.add(vic, PREDICAMENTS[Math.floor(Math.random() * PREDICAMENTS.length)], { left: 3, by });
                notes.push({ kind: 'status', name: vic.name, id: e.id, left: e.left });
            }
            complication = 'molest';
            enc.molest = { who: vic?.name || '', by };
            notes.push({ kind: 'molest', name: vic?.name || '{{user}}' });
        }
        if (helpless) { intentLands = false; notes.push({ kind: 'helpless', name: actor.name, id: ST.listOf(actor).find(x => ST.STATUSES[x.id].block)?.id }); }
        if (outcome === 'crit') intentLands = false;
        else if ((outcome === 'success' || outcome === 'near') && ['defend', 'flee'].includes(k)) intentLands = false;
        else if (outcome === 'success' && k === 'trick') intentLands = false;
        const intent = enc.intent;
        const p = intent?.power ?? 1;
        let harm = 0;
        let stress = 0;
        if (intent && intentLands) {
            if (v === 'chase') {
                B.distance = clamp(B.distance + (enc.role === 'chaser' ? p * 5 : -p * 5), 0, 100);
                if (outcome === 'disaster') harm = 1;
            } else if (v === 'standoff') {
                stress = outcome === 'success' ? 0 : 1;
            } else if (outcome === 'success') {
                // a clean success keeps you out of reach
            } else if (outcome === 'near') {
                if (p >= 3) harm = 1; else stress = 1;
            } else {
                if (p >= 2) harm = 1; else stress = 1;
                if (outcome === 'disaster') stress += 1;
            }
        }
        if (intent?.inflict && intentLands && OUT_MULT[outcome] < 0.6) {
            const vname = intent.target && (enc.participants || []).find(p => p.side === 'ally' && E.sameName(p.name, intent.target));
            const e = ST.add(vname || s, intent.inflict, { by: actor?.name || intent.who });
            if (e) notes.push({ kind: 'status', name: vname ? vname.name : '', id: e.id, left: e.left });
        }
        if (harm && E.hasPerk(s, 'tough') && outcome === 'disaster') harm -= 1;
        if (stress && E.hasPerk(s, 'cool')) stress = Math.max(0, stress - 1);
        const ev = [];
        if (harm) s = E.hurt(s, harm, ev, notes);
        if (stress) E.strain(s, stress, notes);
        // item use
        if (k === 'item' && option.item) E.useItem(s, option.item, 1, notes);
        const enc2 = s.enc;
        if (ev.some(e => e.kind === 'defeat')) { enc2.status = 'lost'; enc2.defeat = true; }
        else if (k === 'flee' && mult >= 1 && v !== 'chase' && !ST.cannotLeave(s)) enc2.status = 'fled';
        else if (v === 'chase' && B.distance <= 0) enc2.status = enc2.role === 'chaser' ? 'won' : 'lost';
        else if (v === 'chase' && B.distance >= 100) enc2.status = enc2.role === 'chaser' ? 'lost' : 'won';
        else if (B.foe != null && (enc2.participants?.length ? !aliveFoes(enc2).length : B.foe <= 0)) enc2.status = 'won';
        else if (v === 'standoff' && s.stress >= E.STRESS_MAX) enc2.status = 'lost';
        effect = mult >= 1 ? 'good' : mult > 0 ? 'weak' : 'nothing';
        var round = { harm, stress };
        s.enc.bars = B;
    }
    const encNow = s.enc;
    for (const p of (encNow.participants || [])) { upgrade(p); for (const id of ST.tick(p)) notes.push({ kind: 'status_end', name: p.name, id }); }
    // an opening: a successful set-up move (or any brilliant one) makes the next strike easier and stronger
    const baseMult = OUT_MULT[outcome];
    if (!refused && !usedEdge && ((baseMult >= 1 && makesEdge(encNow, option)) || outcome === 'crit')) { encNow.edge = true; notes.push({ kind: 'edge' }); }
    if (encNow.status === 'active' && encNow.round >= MAX_ROUNDS + Math.min(8, 3 * Math.max(0, foesOf(encNow).length - 1))) encNow.status = (encNow.kind === 'nsfw' && encNow.herPeaks && ['duet', 'your_lead'].includes(encNow.variant)) ? 'won' : 'ended';

    const rec = {
        round: encNow.round,
        turn: s.turn,
        target: tgt ? { name: tgt.name, side: tgt.side } : null,
        hitAlly,
        option: { ru: option.ru, en: option.en, skill: option.skill, power: option.power, kind: option.kind, tags: option.tags },
        free,
        dice: roll, dc: set.dc, mod: set.mod, adv: set.adv, blocked: set.blocked, usedEdge, focus: set.focus, edge: Boolean(encNow.edge),
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
        if (v === 'duel' && enc.status === 'lost') E.strain(s, 1, notes);
        if (good && res.stars >= 2) E.strain(s, -2, notes, 'хорошо было');
    } else {
        res.xp = enc.status === 'won' ? 2 + enc.power : enc.status === 'fled' ? 1 : 2;
        if (enc.status === 'won') E.strain(s, -1, notes, 'победа');
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
    const cond = [...P.filter(p => ST.listOf(p).length).map(p => ST.describe(p.name, p)), ST.describe(u, state)].filter(Boolean);
    if (cond.length) lines.push(`CONDITIONS (binding): ${cond.join('; ')}. Nobody does what their condition forbids: no blow, no escape, no getting up, no turning the tables until it ends or they are freed. Show the condition in the beat.`);
    for (const n of r.notes.filter(x => x.kind === 'status')) lines.push(`NEW CONDITION: ${n.name || u} is now ${n.id.toUpperCase()} — show exactly how it happened in this beat.`);
    for (const n of r.notes.filter(x => x.kind === 'status_end')) lines.push(`${n.name || u} is no longer ${n.id}: show them shaking it off or being freed.`);
    for (const n of r.notes.filter(x => x.kind === 'helpless')) lines.push(`${n.name} is ${n.id} and cannot carry out their move this round: show them helpless, struggling or dazed instead.`);
    if (enc.status === 'active') lines.push(`The ${enc.kind === 'nsfw' ? 'scene' : 'encounter'} is NOT over: in this beat nobody leaves, flees, yields, faints, is knocked out, calls it off or finishes it — the game decides when it ends, and it will say so.${enc.kind === 'nsfw' ? ` Her clear "stop" always counts: if ${who} wants it to end, she says so in words and the beat honours it.` : ''}`);
    if (r.hitAlly) lines.push(`${u} turned on his ally ${who}: show her shock, hurt or anger; she may fight back or lose trust in him.`);
    const act = r.free ? `${u}'s own move` : `${u}'s move ("${r.option.en.replace(/\{target\}/g, who).replace(/^\*|\*$/g, '')}")`;
    if (r.refused) lines.push(`THIS ROUND: ${act} — ${who} stops it or turns it down: ${enc.kind === 'nsfw' ? 'not that, not now; in character, the mood dips but she stays in the scene' : 'it fails'}.`);
    else lines.push(`THIS ROUND: ${act} goes ${OUT_EN[r.outcome]}${enc.kind === 'nsfw' ? ` (effect on ${who}: ${r.effect})` : ''}.`);
    if (r.usedEdge) lines.push(`${userName} uses the opening made a moment ago: the move comes easier and lands with extra force.`);
    if (r.focus) lines.push(`${userName} pulls himself together for this one: focused, deliberate, spending real effort.`);
    if (r.edge && !r.usedEdge) lines.push(enc.kind === 'nsfw' ? `It leaves ${who} off her rhythm, open to whatever ${userName} does next.` : `It leaves ${who} off balance and open for a moment: show the opening.`);
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
            lost: enc.kind === 'nsfw' ? (enc.variant === 'your_lead' ? `${who} stops the scene: it went too far for her. Last beat: she says stop (if she is bound or held, the word is enough and ${u} lets go at once), in character.` : `${who} wins this one. Last beat: she savours her victory, in character.`) : `${u} loses this ${v.en.replace(/^a /, '')}: the worst plausible outcome lands. Last beat of the encounter.`,
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

const erogeNote = (state) => (state?.eroge ? '\n' + E.erogeHelperNote() : '') + conditionsNote(state);
/** Conditions in play, for the card designer: who cannot act, and what the hero's own cards must be. */
function conditionsNote(state) {
    const enc = state?.enc;
    if (!enc) return '';
    const held = (enc.participants || []).filter(p => ST.listOf(p).length);
    const lines = [];
    if (held.length) lines.push(`Conditions: ${held.map(p => ST.describe(p.name, p)).join('; ')}. A character cannot do what their condition forbids: the announced move ("intent") must come from someone who is able to act, or be that character struggling against the condition; nobody under a condition leaves the scene ("gone").`);
    if (held.some(p => p.side === 'ally' && ST.blockOf(p))) lines.push('An ally is held by a condition: make one or two of the four cards a way to free or protect them (kind defend, item, talk or trick aimed at that ally).');
    if (ST.listOf(state).length) lines.push(`{{user}}'s own conditions: ${ST.describe('{{user}}', state)}. ${ST.blockOf(state) ? 'At least two of the four cards are ways to break free or resist (kind defend); the others only what the condition still allows.' : 'The cards reflect it.'}`);
    return lines.length ? '\n' + lines.join('\n') : '';
}

/** The card rules for this kind of scene + the shared label rules + what not to repeat. */
function cardsRules(nsfw, user, recent = []) {
    const avoid = recent.length ? `\nDo NOT repeat or paraphrase these recent cards (verbs, actions, body parts): ${recent.join('; ')}.` : '';
    return P.render(nsfw ? 'enc_cards_nsfw' : 'enc_cards_combat', { user }) + '\n' + P.render('enc_cards_labels', { user }) + avoid;
}

export function startPrompt({ state, kind, partner, narration, card, user, char, forced = false }) {
    const nsfw = kind === 'nsfw';
    const k = nsfw ? 'nsfw' : 'combat';
    return P.render(`enc_start_${k}`, {
        user, char,
        forced: forced ? ` She is taking ${user} without asking: pick her_lead or duel, and make one of the four cards a way to break free or push her off (kind defy).` : '',
        card: String(card || '').slice(0, 1800),
        partner_record: nsfw ? partnerSheet(state, { partner }) : '',
        narration: String(narration || '').slice(-1800),
        format: P.render(`enc_start_${k}_format`, { user }),
        cards: cardsRules(nsfw, user),
        eroge: erogeNote(state),
    });
}

export function nextPrompt({ state, narration, user }) {
    const enc = state.enc;
    const nsfw = enc.kind === 'nsfw';
    return P.render('enc_next', {
        user,
        round: enc.round + 1, variant: VARIANTS[enc.variant].en, partner: enc.partner,
        sheet: nsfw ? partnerSheet(state, enc) : `Opponent strength ${enc.power}/3. ${user} carries: ${E.itemsLine(state) || 'nothing useful'}.`,
        bars: Object.entries(enc.bars).map(([k, x]) => `${k} ${x}`).join(', '),
        last_moves: enc.log.slice(-3).map(l => l.ru).join('; ') || 'none',
        narration: String(narration || '').slice(-1600),
        participants: (enc.participants || []).map(p => `${p.name} (${p.side}, bar ${p.bar}${ST.listOf(p).map(x => `, ${x.id.toUpperCase()} ${x.left}`).join('')})`).join('; ') || 'single opponent',
        target: targetName(enc),
        format: P.render(nsfw ? 'enc_next_nsfw_format' : 'enc_next_combat_format', { user }),
        cards: cardsRules(nsfw, user, enc.log.slice(-5).map(l => l.ru)),
        eroge: erogeNote(state),
        forced: enc.forced && nsfw ? `\nShe started this without asking: one of the four cards is always a way to break free or push her off (kind defy)${enc.escape ? ' — he already got partly free once' : ''}.` : '',
    });
}

export function classifyPrompt({ state, action, narration, user }) {
    const enc = state.enc;
    const nsfw = enc.kind === 'nsfw';
    return P.render('enc_classify', {
        user, variant: VARIANTS[enc.variant].en,
        sheet: nsfw ? partnerSheet(state, enc) : '',
        narration: String(narration || '').slice(-800), action: String(action || '').slice(0, 600),
        target: targetName(enc),
        format: P.render(nsfw ? 'enc_classify_nsfw_format' : 'enc_classify_combat_format', { user }),
    });
}
