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
    s.enc = {
        id: uid(),
        kind: v.kind,
        variant,
        partner: npc?.name || partner,
        title_ru: String(opts.title_ru || '').slice(0, 60) || `${v.ru}${v.kind === 'nsfw' ? ` с ${npc?.name || partner}` : `: ${partner}`}`,
        role: opts.role === 'fleeing' ? 'fleeing' : 'chaser',
        power,
        round: 0,
        startTurn: s.turn,
        bars,
        herPeaks: 0,
        youPeak: false,
        together: false,
        lastTag: null,
        found: [],
        intent: cleanIntent(opts.intent),
        options: cleanOptions(opts.options, v.kind),
        status: 'active',
        log: [],
        lastRound: null,
        result: null,
    };
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
        ru: String(i.ru || '').slice(0, 120),
        en: String(i.en || '').slice(0, 220),
        power: clamp(Math.round(Number(i.power) || 1), 1, 3),
        tags: (Array.isArray(i.tags) ? i.tags : []).map(String).filter(x => TAG_IDS.includes(x)).slice(0, 3),
    };
}

/** Card labels must be short: cut at a word boundary, "…" only as a last resort. */
export function trimLabel(t, max = 32) {
    t = String(t || '').replace(/\s+/g, ' ').trim().replace(/[.!]+$/, '');
    if (t.length <= max) return t;
    const cut = t.slice(0, max + 1);
    const sp = cut.lastIndexOf(' ');
    if (sp >= 12) return cut.slice(0, sp).replace(/[,;:—-]+$/, '');
    return t.slice(0, max - 1) + '…';
}

export function cleanOptions(list, kind = 'nsfw') {
    const kinds = kind === 'nsfw' ? KINDS_NSFW : KINDS_COMBAT;
    return (Array.isArray(list) ? list : []).slice(0, 4).map((o, i) => ({
        id: `o${i}`,
        ru: trimLabel(o?.ru || o?.en || '…'),
        risk_ru: String(o?.risk_ru || '').replace(/\s+/g, ' ').trim().slice(0, 24),
        en: String(o?.en || o?.ru || '').slice(0, 240),
        skill: E.SKILLS[o?.skill] ? o.skill : (kind === 'nsfw' ? 'passion' : 'might'),
        power: clamp(Math.round(Number(o?.power) || 2), 1, 3),
        tags: (Array.isArray(o?.tags) ? o.tags : []).map(x => String(x).toLowerCase()).filter(x => TAG_IDS.includes(x)).slice(0, 3),
        kind: kinds.includes(o?.kind) ? o.kind : kinds[0],
        stage: clamp(Math.round(Number(o?.stage) || 0), 0, E.STAGES.length - 1),
        limit: Boolean(o?.limit),
        item: String(o?.item || '').slice(0, 40),
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
    let dc = nsfw ? 6 + option.power : 7 + (enc?.power ?? 2) + (option.power - 2);
    if (!nsfw && option.kind === 'defend') dc -= 1;
    if (!nsfw && option.kind === 'flee') dc += 1;
    if (nsfw && enc.variant === 'duel') dc -= Math.round((enc.bars.control || 0) / 40);
    if (nsfw && enc.variant === 'her_lead' && option.kind === 'defy') dc += 2;
    const npc = nsfw ? findNpc(s, enc.partner) : null;
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
    const B = enc.bars;
    const before = clone(B);
    const notes = [];
    const v = enc.variant;
    enc.round += 1;
    let intentLands = true;
    let refused = false;
    let effect = '';
    let complication = null;

    if (enc.kind === 'nsfw') {
        const npc = findNpc(s, enc.partner);
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
            notes.push({ kind: 'enc_peak', name: enc.partner, n: enc.herPeaks });
        }
        let youPeakNow = false;
        if (B.you >= 100) {
            enc.youPeak = true; youPeakNow = true; B.you = 100;
            notes.push({ kind: 'enc_you_peak' });
        }
        if (herPeakNow && youPeakNow) enc.together = true;
        if (youPeakNow && enc.log.at(-1)?.herPeak) enc.together = true;

        // how it ends
        if (v === 'duet') {
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
        else if (B.foe != null && B.foe <= 0) enc2.status = 'won';
        else if (v === 'standoff' && s.stress >= E.STRESS_MAX - 1) enc2.status = 'lost';
        effect = mult >= 1 ? 'good' : mult > 0 ? 'weak' : 'nothing';
        var round = { harm, stress };
        s.enc.bars = B;
    }
    const encNow = s.enc;
    if (encNow.status === 'active' && encNow.round >= MAX_ROUNDS) encNow.status = 'ended';

    const rec = {
        round: encNow.round,
        turn: s.turn,
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
    const lines = [];
    if (!r || r.turn !== state.turn) {
        if (enc.status === 'active') lines.push(`ENCOUNTER in progress: ${v.en} with ${enc.partner}. Keep replies to one short beat (80-130 words).`);
        return lines.join('\n');
    }
    lines.push(`ENCOUNTER — ${v.en}${enc.kind === 'nsfw' ? ` with ${enc.partner}` : ` against ${enc.partner}`}, round ${r.round}. Write ONE short beat for this round only: 80-130 words, vivid, in the scene's voice. Never mention numbers, bars, rounds or dice.`);
    const act = r.free ? `${u}'s own move` : `${u}'s move ("${r.option.en.replace(/^\*|\*$/g, '')}")`;
    if (r.refused) lines.push(`THIS ROUND: ${act} — ${enc.partner} stops it or turns it down: ${enc.kind === 'nsfw' ? 'not that, not now; in character, the mood dips but she stays in the scene' : 'it fails'}.`);
    else lines.push(`THIS ROUND: ${act} goes ${OUT_EN[r.outcome]}${enc.kind === 'nsfw' ? ` (effect on ${enc.partner}: ${r.effect})` : ''}.`);
    if (!r.refused && (r.outcome === 'fail' || r.outcome === 'disaster')) {
        const dis = r.outcome === 'disaster';
        if (enc.kind === 'nsfw') {
            lines.push(`WHAT WENT WRONG: ${u}'s move ${dis ? 'badly backfires' : 'misjudges the moment'} — pick one that fits (wrong spot, too much too fast, a clumsy hand, bad timing, a line that falls flat). Show it clearly in the beat, and show ${enc.partner}'s mood visibly cooling: ${dis ? 'she stiffens, pulls back or loses the thread' : 'a flicker of disappointment, a breath of distance, less eager'}. Her pleasure dips instead of rising.`);
            if (r.complication) lines.push(`COMPLICATION: ${COMP_EN[r.complication]}; show it clearly in this beat.`);
        } else {
            lines.push(`WHAT WENT WRONG: ${u}'s move ${dis ? 'goes badly wrong — a misjudged step, a bad angle, a slip' : 'is misjudged — too slow, wrong angle or wrong moment'}; show it, and show ${enc.partner} gaining ground because of it.${dis ? ` ${u} is shaken and off balance.` : ''}`);
        }
    } else if (!r.refused && r.outcome === 'near' && enc.kind === 'nsfw') lines.push('It half-works: a small hitch or awkward beat takes a little of the heat out of the moment.');
    if (r.intent) lines.push(r.intentLands ? `THEN ${enc.partner}: ${r.intent.en} — and it lands.` : `${enc.partner} tried to ${r.intent.en.replace(/^she |^he |^they /i, '')} but ${u}'s move stops or turns it.`);
    const B = enc.bars;
    if (enc.kind === 'nsfw') {
        lines.push(`NOW (show through bodies and voices): ${enc.partner}: ${bandHer(B.her)}; ${bandYou(B.you, u)}${B.mood != null ? `; mood: ${B.mood >= 70 ? 'hot and close' : B.mood >= 40 ? 'good' : 'cooling, a little off'}` : ''}${B.control != null ? `; control: ${B.control >= 30 ? u + ' has the upper hand' : B.control <= -30 ? enc.partner + ' has the upper hand' : 'contested'}` : ''}${B.approval != null ? `; she is ${B.approval >= 70 ? 'very pleased with him' : B.approval >= 40 ? 'satisfied so far' : 'not yet impressed'}` : ''}${B.comfort != null ? `; her trust: ${B.comfort >= 60 ? 'she is giving herself completely' : B.comfort >= 30 ? 'holding' : 'shaky, she is close to stopping'}` : ''}.`);
        if (r.herPeak) lines.push(`${enc.partner} CLIMAXES in this beat${enc.herPeaks > 1 ? ' (again)' : ''}: write it fully, broken speech and all.`);
        if (r.youPeak) lines.push(`${u} can't hold back any more: he climaxes in this beat${enc.together ? ', together with her' : ''}. Show it through her eyes and his body; do not write his words.`);
        if (r.notes.some(n => n.kind === 'spot')) lines.push(`${enc.partner} reacts unusually strongly: ${u} has found one of her most sensitive spots.`);
    } else {
        lines.push(`NOW: ${B.foe != null ? `${enc.partner} is ${B.foe <= 25 ? 'nearly broken' : B.foe <= 60 ? 'hurt and shaken' : 'still strong'}` : ''}${B.distance != null ? `distance: ${B.distance <= 20 ? 'almost within reach' : B.distance >= 80 ? 'almost gone' : 'still a gap'}` : ''}${r.harm ? `; ${u} takes a hit` : ''}${r.stress ? `; ${u} is rattled` : ''}.`);
    }
    if (enc.status !== 'active') {
        const end = {
            won: enc.kind === 'nsfw' ? (enc.variant === 'her_lead' ? `${enc.partner} finally allows ${u} to finish. This is the last beat of the scene: let it land, then the afterglow.` : `This is the last beat of the scene: the release lands, then the afterglow.`) : `${u} wins: ${enc.partner} is beaten, gives up or is caught. Last beat of the encounter.`,
            early: `${u} came before her. Last beat of the scene: she reacts in character (teasing, amused, a little frustrated, or kind), afterglow.`,
            lost: enc.kind === 'nsfw' ? (enc.variant === 'your_lead' ? `${enc.partner} stops the scene: it went too far for her. Last beat: she pulls back, in character.` : `${enc.partner} wins this one. Last beat: she savours her victory, in character.`) : `${u} loses this ${v.en.replace(/^a /, '')}: the worst plausible outcome lands. Last beat of the encounter.`,
            draw: 'They break together. Last beat of the scene, then the afterglow.',
            fled: `${u} gets away. Last beat of the encounter.`,
            ended: 'This is the last beat of the encounter: wind it down.',
        }[enc.status];
        lines.push(end);
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

export function startPrompt({ state, kind, partner, narration, card, user, char }) {
    const nsfw = kind === 'nsfw';
    return `An ${nsfw ? 'intimate scene' : 'action encounter'} is starting in an interactive story. Set it up as a mini-game.

${nsfw ? `Variations: duet (mutual lovemaking, both move toward the peak together — the default), duel (a playful or real contest of pleasure: whoever comes first loses — for succubi, rivals, bets, competitive or predatory characters), her_lead (she is dominant and in charge: ${user} must please her and hold out until she allows), your_lead (she is submissive or asks ${user} to take charge; ${user} leads, her trust must hold).` : `Variations: fight (a physical fight), chase (someone runs, someone pursues), standoff (a tense confrontation of nerves, threats or words).`}
Pick the variation that fits the character and the moment.

Character card (${char}):
${String(card || '').slice(0, 1800)}

${nsfw ? `Partner record:\n${partnerSheet(state, { partner })}\n` : ''}Last narration:
<narration>
${String(narration || '').slice(-1800)}
</narration>

Reply with ONE line of JSON:
{"variant":"${nsfw ? 'duet|duel|her_lead|your_lead' : 'fight|chase|standoff'}","partner":"${nsfw ? 'her name' : 'opponent name, 1-3 words'}","title_ru":"короткое название сцены",${nsfw ? `"prefs":{"loves":[1-2 tags],"likes":[2-4 tags],"dislikes":[1-2 tags]},` : `"power":1-3 (opponent strength: 1 weak, 2 even match, 3 dangerous),"role":"chaser|fleeing",`}
${optionsSchema(nsfw)}}
${nsfw ? `prefs: her hidden tastes, true to the card, from these tags only: ${TAG_IDS.join(', ')}.` : ''}
${optionsRules(nsfw, user)}`;
}

function optionsSchema(nsfw) {
    return `"intent":{"ru":"что она/он сейчас собирается сделать, 4-10 слов","en":"what they are about to do, 1 short sentence, third person","power":1-3${nsfw ? ',"tags":[]' : ''}},
"options":[{"ru":"действие по-русски, 2-5 слов, не длиннее 28 символов","risk_ru":"1-3 слова о риске или отдаче, можно пусто","en":"*first-person action in English, 1 sentence*","skill":"${nsfw ? 'passion|charm|finesse|resolve|insight' : 'might|finesse|insight|charm|resolve|lore'}","power":1-3,"kind":"${nsfw ? KINDS_NSFW.join('|') : KINDS_COMBAT.join('|')}"${nsfw ? ',"tags":[1-3 tags],"stage":0-8,"limit":bool' : ',"item":"item name if it uses one"'}}]`;
}

function optionsRules(nsfw, user, recent = []) {
    const avoid = recent.length ? `\nDo NOT repeat or paraphrase these recent cards (verbs, actions, body parts): ${recent.join('; ')}.` : '';
    const lang = `\nLabels ("ru"): Russian, 2-5 words, at most 28 characters, a concrete verb phrase ("Укусить за мочку", "Поднять на стол"), never a full sentence. "risk_ru": 1-3 words about the gamble or the payoff ("рискованно", "может понравиться", "она может отказать", "надёжно"), different on each card.`;
    return (nsfw
        ? `Options: exactly 4 cards that are genuinely DIFFERENT from each other, each grounded in a specific detail of the latest narration (her body, her clothes, the place, a prop, ${user}'s inventory, what she just said or did). Required mix:
1. TENDER or sensual (power 1-2): slow, attentive, a touch or a kiss placed somewhere specific.
2. BOLD (power 3): the high-risk move that can ruin the mood or blow her away.
3. SITUATION-CHANGER: a new position, a new place, removing or moving clothing, using the room or an item ${user} carries, a game, a tease, a bit of roleplay, a dare.
4. VERBAL or TACTICAL: a tease, a command, a whispered confession, holding back, or turning her telegraphed move (kind redirect or resist).
Rotate which style leads from round to round; do not repeat the pattern of the previous round. Follow the variation: duel = every card fights for control (pin, steal the initiative, make her break first); her_lead = obey / please / defy with real stakes (defy can win her over or cost ${user}); your_lead = ${user} leads with care, reads her, asks, builds trust; bold cards risk her trust. ${user}'s skill passion = technique, charm = words, finesse = precise hands, resolve = holding out, insight = reading her. power 1 = light, 3 = intense. stage = the ladder step the act belongs to; never offer acts more than one step above "ready now". limit: true only if it touches one of her limits. The intent is her next move toward ${user}, building from the narration.`
        : `Options: exactly 4 cards, each specific to the opponent's telegraphed move and to the surroundings in the latest narration:
1. ATTACK (name the strike and the target).
2. DEFEND or EVADE aimed at the telegraphed move.
3. ENVIRONMENT TRICK: use a named object, terrain, light, crowd or a hazard from the narration.
4. WILDCARD: a bold gamble (power 3), or talk, or an item ${user} carries.
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

Reply with ONE line of JSON: {${optionsSchema(nsfw)}}
${optionsRules(nsfw, user, enc.log.slice(-5).map(l => l.ru))}`;
}

export function classifyPrompt({ state, action, narration, user }) {
    const enc = state.enc;
    const nsfw = enc.kind === 'nsfw';
    return `In a ${VARIANTS[enc.variant].en} mini-game, ${user} wrote their own move. Classify it as one option card.
${nsfw ? partnerSheet(state, enc) : ''}
Narration: ${String(narration || '').slice(-800)}
${user}'s move: ${String(action || '').slice(0, 600)}
Reply with ONE line of JSON: {"ru":"2-5 слов, не длиннее 28 символов","en":"the move, 1 sentence","skill":"${nsfw ? 'passion|charm|finesse|resolve|insight' : 'might|finesse|insight|charm|resolve|lore'}","power":1-3,"kind":"${nsfw ? KINDS_NSFW.join('|') : KINDS_COMBAT.join('|')}"${nsfw ? ',"tags":[from: ' + TAG_IDS.join(', ') + '],"stage":0-8,"limit":bool' : ',"item":""'}}`;
}
