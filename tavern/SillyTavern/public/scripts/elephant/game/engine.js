/*
 * Elephant Game — the rules engine. Pure functions, no DOM, no LLM.
 *
 * The engine owns the numbers: skills, harm, stress, clocks, relationships,
 * money, time. The LLM only classifies (referee) and reports what happened
 * (extractor); the engine validates, clamps and applies. The narrator receives
 * the result as ground truth.
 */
import { MOOD_IDS } from '../stage/scene.js';

import * as P from './prompts.js';
import * as ST from './status.js';

export const SKILLS = {
    might:   { ru: 'Сила',     icon: '💪', en: 'Might' },
    finesse: { ru: 'Ловкость', icon: '🗝️', en: 'Finesse' },
    insight: { ru: 'Чутьё',    icon: '👁️', en: 'Insight' },
    charm:   { ru: 'Обаяние',  icon: '🎭', en: 'Charm' },
    resolve: { ru: 'Воля',     icon: '🔥', en: 'Resolve' },
    lore:    { ru: 'Знание',   icon: '📜', en: 'Lore' },
    passion: { ru: 'Страсть',  icon: '💋', en: 'Passion' },
};

export const SKILL_MAX = 6;
export const START_MAX = 3;
/** Rank names for skill values 0..6. */
export const RANKS = ['Слабое место', 'Обычный', 'Умелый', 'Опытный', 'Мастер', 'Виртуоз', 'Легенда'];

/*
 * Living traits: skills shape every reply, not only dice. Level 1 is ordinary and stays silent;
 * the narrator gets a line for every skill that stands out (0, 2..6).
 * `hint` is what the setup screen tells the player.
 */
export const TRAITS = {
    might: {
        hint: 'сила тела: драки, тяжёлое, выносливость; мир видит, насколько ты крепкий',
        0: 'physically weak and out of shape: heavy things, fights and long exertion go badly, and others see it',
        2: 'strong: doors give, loads are easy, people think twice before shoving {{user}}',
        3: 'powerfully built: an imposing body that others notice, size up and react to, wary or impressed',
        4: 'exceptionally strong, almost frighteningly so: feats of strength come easily and people react with awe or fear',
        5: 'superhuman strength: walls, chains and doors give way; fights against ordinary foes are over fast; people stare',
        6: 'legendary strength, the stuff of stories: monsters and armies hesitate to face {{user}}',
    },
    finesse: {
        hint: 'ловкость рук и тела: тихо, быстро, точно; руки, которые знают, что делают',
        0: 'clumsy: things get dropped, noise gets made, quiet and delicate tasks go wrong',
        2: 'quick and light on their feet: quiet, precise hands, easy balance',
        3: 'nimble and deft: moves silently, hands are sure and skilled, in a fight or in bed',
        4: 'uncannily graceful and precise: others notice how effortlessly {{user}} moves',
        5: 'a virtuoso of hands and body: impossible locks, silent as a shadow, hands that play bodies like instruments',
        6: 'legendary grace: {{user}} moves like a rumour; nothing is locked, nothing is noticed',
    },
    insight: {
        hint: 'чутьё: замечать ложь, маски, скрытые чувства — рассказ покажет тебе подсказки',
        0: 'misses subtle tells: lies, hidden motives and disguises that are not obvious slip past {{user}}, so the prose does not point them out',
        2: 'sharp-eyed: when someone lies, hides something or wears a disguise, the prose lets {{user}} catch one small tell',
        3: 'reads people: hidden intent, lies, disguises and unspoken feelings show through to {{user}} as clear tells in the prose',
        4: 'sees through almost anything: no mask, lie or hidden mood stays hidden from {{user}} for long',
        5: 'reads minds by their faces: every lie, mask and secret want shows to {{user}} at a glance',
        6: 'nothing stays hidden: even magic disguises and perfect liars give themselves away to {{user}}',
    },
    charm: {
        hint: 'обаяние: как к тебе тянутся, насколько легко флиртовать, уговаривать и нравиться',
        0: 'awkward company: people warm to {{user}} slowly, flirting and persuasion tend to land wrong',
        2: 'likeable: people open up a little faster and enjoy {{user}}\'s company',
        3: 'magnetic: characters find {{user}} attractive and easy to like; flirting lands, warmth comes quickly (within each character\'s nature)',
        4: 'irresistible presence: even guarded or hostile characters feel the pull of {{user}}\'s charm, whether they like it or not',
        5: 'devastating charisma: rooms turn toward {{user}}, enemies hesitate, hearts open quickly',
        6: 'legendary allure: people fall for {{user}} almost against their nature (still within it)',
    },
    resolve: {
        hint: 'воля: страх, боль, соблазн, внушение и магия разума берут тебя меньше',
        0: 'easily rattled: fear, pain, temptation and manipulation hit {{user}} hard and show',
        2: 'steady nerves: pressure and fear get less grip on {{user}}',
        3: 'iron will: intimidation, seduction used as a weapon and mind-affecting magic get little grip; characters notice that {{user}} does not bend easily',
        4: 'unshakable: almost nothing can force {{user}}\'s mind or nerve',
        5: 'will like a fortress: fear, pain and mind magic slide off; {{user}}\'s calm steadies others',
        6: 'unbreakable soul: nothing in this world can bend {{user}}\'s will',
    },
    lore: {
        hint: 'знание: узнавать существ, магию, историю, лечить; рассказ подскажет, что ты знаешь',
        0: 'knows little of this world: strange creatures, magic and customs stay strange to {{user}}',
        2: 'well-read: the prose can let {{user}} recognize common creatures, magic and customs',
        3: 'deeply learned: the prose can let {{user}} recognize rare creatures, spells, history and weaknesses',
        4: 'a true scholar: {{user}} understands nearly anything uncanny that appears',
        5: 'a master of secrets: {{user}} knows the true names, weaknesses and history of almost everything',
        6: 'living archive: the prose can let {{user}} know what even the wise have forgotten',
    },
    passion: {
        hint: 'страсть: каково с тобой в постели, как ты чувствуешь тело партнёра; близость идёт быстрее',
        0: 'inexperienced and clumsy in intimacy: {{user}} fumbles, misreads bodies, partners stay patient or tease',
        2: 'a good lover: attentive hands and mouth, partners respond warmly',
        3: 'a skilled lover: {{user}} reads a partner\'s body and finds what works; partners come apart faster',
        4: 'an exceptional lover: partners lose composure quickly with {{user}} and want more afterwards',
        5: 'a virtuoso lover: one touch from {{user}} makes partners weak; they think about it for days',
        6: 'legendary in bed: lovers become addicted to {{user}}, rivals hear rumours',
    },
};

/** Narrator line about the player's standout traits ('' when everything is ordinary). */
export function traitsBlock(state, userName = '{{user}}') {
    const items = Object.keys(SKILLS).map((k) => {
        const lvl = clamp(Number(state.skills?.[k] ?? 1), 0, SKILL_MAX);
        const t = TRAITS[k]?.[lvl];
        return t ? `${SKILLS[k].en}: ${t.replaceAll('{{user}}', userName)}` : '';
    }).filter(Boolean);
    if (!items.length) return '';
    return `${userName}'s traits (let the world and the characters react to them in every reply, without naming them and without writing ${userName}'s actions):\n- ${items.join('\n- ')}`;
}

export const POSITIONS = {
    controlled: { ru: 'Под контролем', en: 'controlled', tick: 1, harm: 0 },
    risky:      { ru: 'Рискованно',    en: 'risky',      tick: 2, harm: 1 },
    desperate:  { ru: 'Отчаянно',      en: 'desperate',  tick: 3, harm: 1 },
};

export const EFFECTS = {
    limited:  { ru: 'Слабый эффект',   bonus: -1 },
    standard: { ru: 'Обычный эффект',  bonus: 0 },
    great:    { ru: 'Сильный эффект',  bonus: 1 },
};

export const OUTCOMES = {
    crit:     { ru: 'Блестяще!',           en: 'CRITICAL SUCCESS', tone: 'gold' },
    success:  { ru: 'Успех',               en: 'SUCCESS',          tone: 'good' },
    near:     { ru: 'Успех ценой',         en: 'NEAR MISS',        tone: 'warn' },
    fail:     { ru: 'Провал',              en: 'FAILURE',          tone: 'bad' },
    disaster: { ru: 'Катастрофа',          en: 'DISASTER',         tone: 'dark' },
};

export const DIFFICULTY = {
    story:    { ru: 'Сюжет',     dc: -2, death: false },
    standard: { ru: 'Стандарт',  dc: 0,  death: true },
    brutal:   { ru: 'Жестокий',  dc: 1,  death: true },
};

export const HARM = [
    { ru: 'Цел', penalty: 0 },
    { ru: 'Ушибы', penalty: 0 },
    { ru: 'Ранен', penalty: -1 },
    { ru: 'Тяжело ранен', penalty: -2 },
];

export const TIERS = [
    { id: 'hostile', ru: 'Враждебно', en: 'Hostile', min: -101 },
    { id: 'neutral', ru: 'Нейтрально', en: 'Neutral', min: -30 },
    { id: 'warm', ru: 'Тепло', en: 'Warm', min: 15 },
    { id: 'close', ru: 'Близко', en: 'Close', min: 45 },
    { id: 'devoted', ru: 'Предан(а)', en: 'Devoted', min: 75 },
];

/* Romance & intimacy, per character (eroge-style card). All 0..100 except trust (−100..100). */

/*
 * The ladder: intimacy goes up step by step. A stage opens when the feelings are there AND the
 * stage below has happened; one scene can only climb a few steps (pace). The narrator is told how
 * far the character is ready to go right now and what holds them back.
 * req: attraction / trust / affection / openness the step needs (normal pace).
 */
export const STAGES = [
    { id: 'none',    ru: 'Знакомство',          icon: '🤝', en: 'nothing yet', req: {} },
    { id: 'flirt',   ru: 'Флирт',               short: 'Флирт', icon: '😊', en: 'flirting, light touches, holding hands, hugs', req: { attraction: 10 } },
    { id: 'kiss',    ru: 'Поцелуй',             short: 'Поцелуй', icon: '💋', en: 'kissing', req: { attraction: 25, trust: 5 } },
    { id: 'makeout', ru: 'Страстные поцелуи',   short: 'Страсть', icon: '😘', en: 'making out, close embraces, hands roaming over clothes', req: { attraction: 35, trust: 12, openness: 20 } },
    { id: 'petting', ru: 'Ласки через одежду',  short: 'Ласки', icon: '🤲', en: 'groping and grinding through clothes, hands under a shirt', req: { attraction: 45, trust: 18, openness: 25 } },
    { id: 'bare',    ru: 'Ласки без одежды',    short: 'Голые', icon: '✋', en: 'undressing, naked touching, fingering, handjobs', req: { attraction: 52, trust: 24, openness: 30, affection: 10 } },
    { id: 'oral',    ru: 'Оральный',            short: 'Орал', icon: '👅', en: 'oral sex', req: { attraction: 58, trust: 30, openness: 36, affection: 15 } },
    { id: 'sex',     ru: 'Секс',                short: 'Секс', icon: '🔥', en: 'full sex', req: { attraction: 63, trust: 35, openness: 42, affection: 20 } },
    { id: 'wild',    ru: 'Смелое',              short: 'Смелое', icon: '⛓️', en: 'anal, kinks, toys, risky places, anything bold', req: { attraction: 68, trust: 45, openness: 60, affection: 25 } },
];
export const STAGE_IDS = STAGES.map(x => x.id);
export const PACES = {
    fast:   { ru: 'Быстро',  k: 0.6, perScene: 3 },
    medium: { ru: 'Средне',  k: 1,   perScene: 2 },
    slow:   { ru: 'Медленно', k: 1.25, perScene: 1 },
};

/* Acts the card counts. stage = the ladder step the act belongs to. */
export const ACTS = [
    { id: 'kiss',     ru: 'Поцелуи',          icon: '💋', stage: 2 },
    { id: 'makeout',  ru: 'Страстные поцелуи', icon: '😘', stage: 3 },
    { id: 'grope',    ru: 'Ласки',            icon: '🤲', stage: 4 },
    { id: 'hands',    ru: 'Руками',           icon: '✋', stage: 5 },
    { id: 'oral_her', ru: 'Куни / ей ртом',   icon: '👅', stage: 6 },
    { id: 'oral_you', ru: 'Минет / тебе ртом', icon: '💦', stage: 6 },
    { id: 'sex',      ru: 'Секс',             icon: '🔥', stage: 7 },
    { id: 'anal',     ru: 'Анал',             icon: '🍑', stage: 8 },
    { id: 'kink',     ru: 'Кинки и игрушки',  icon: '⛓️', stage: 8 },
];
const ACT_IDS = ACTS.map(x => x.id);
const ACT_ALIASES = { touch: 'grope', petting: 'grope', fingering: 'hands', handjob: 'hands', naked: 'hands', oral: 'oral_her', cunnilingus: 'oral_her', blowjob: 'oral_you', fellatio: 'oral_you', vaginal: 'sex', toys: 'kink', bdsm: 'kink' };
const normAct = (x) => { const t = String(x || '').toLowerCase().trim(); return ACT_IDS.includes(t) ? t : ACT_ALIASES[t] || null; };
/** Old cards (before the ladder) used these four. */
export const INTIMACY = ACTS;
export const EXPERIENCE = { virgin: 'Девственница', inexperienced: 'Неопытная', experienced: 'Опытная', very: 'Очень опытная' };

/** Fields every character record has (old saves get them on the fly). */
// ------------------------------------------------------------------ who is who

const TRANSLIT = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
const NAME_TITLES = new Set(['the', 'a', 'an', 'miss', 'mrs', 'mr', 'ms', 'lady', 'lord', 'sir', 'dr', 'doctor', 'captain', 'master', 'mistress', 'old', 'young', 'gospozha', 'gospodin', 'miss', 'ledi', 'lord', 'ser', 'doktor', 'kapitan', 'staryi', 'staraya', 'molodoi', 'molodaya', 'tetya', 'dyadya']);
/** "Старый Бруно" → ['bruno'], "Mara Voss" → ['mara', 'voss']: lower case, transliterated, titles dropped. */
export function nameTokens(name) {
    const all = String(name || '').toLowerCase().replace(/[а-яё]/g, ch => TRANSLIT[ch] ?? ch).split(/[^a-z0-9]+/).filter(Boolean);
    const core = all.filter(t => !NAME_TITLES.has(t));
    return core.length ? core : all;
}
/** The same character under another spelling: Мара / Mara, Mara / Mara Voss, Бруно / Старый Бруно. */
export function sameName(a, b) {
    const ta = nameTokens(a), tb = nameTokens(b);
    if (!ta.length || !tb.length) return false;
    if (ta.join(' ') === tb.join(' ')) return true;
    const digits = (t) => t.filter(x => /^\d+$/.test(x)).join(',');
    if (digits(ta) !== digits(tb)) return false; // "Гоблин 1" is not "Гоблин 2", nor plain "Гоблин"
    const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
    return short.every(t => t.length >= 3 && long.includes(t));
}
/** Finds a character by any name the story uses for them; remembers the new spelling. */
export function resolveNpc(s, name, { learn = false } = {}) {
    const q = String(name || '').trim();
    if (!q) return null;
    const key = q.toLowerCase();
    const all = Object.values(s.npcs || {});
    let npc = s.npcs?.[key] ?? all.find(n => n.name.toLowerCase() === key || (n.aliases || []).some(a => a.toLowerCase() === key));
    if (!npc) npc = all.find(n => sameName(n.name, q) || (n.aliases || []).some(a => sameName(a, q)));
    if (npc && learn && npc.name.toLowerCase() !== key && !(npc.aliases || []).some(a => a.toLowerCase() === key)) npc.aliases = [...(npc.aliases || []), q.slice(0, 40)].slice(-6);
    return npc ?? null;
}
const keyOf = (s, npc) => Object.keys(s.npcs).find(k => s.npcs[k] === npc);

/** Folds one record of a character into another (the duplicate disappears). */
export function mergeNpcs(s, keepName, dropName) {
    const keep = resolveNpc(s, keepName), drop = resolveNpc(s, dropName);
    if (!keep || !drop || keep === drop) return false;
    ensureNpc(keep); ensureNpc(drop);
    const kKey = keyOf(s, keep), dKey = keyOf(s, drop);
    const uniq = (a, b, max) => [...new Set([...(a || []), ...(b || [])])].slice(-max);
    for (const f of ['trust', 'affection', 'attraction', 'openness', 'lust', 'stage', 'sceneStage', 'bestStars']) keep[f] = Math.max(keep[f] || 0, drop[f] || 0) || keep[f];
    for (const f of ['orgasms', 'userOrgasms', 'protected', 'unprotected', 'scenes', 'times']) keep[f] = (keep[f] || 0) + (drop[f] || 0);
    for (const [a, c] of Object.entries(drop.counts)) keep.counts[a] = (keep.counts[a] || 0) + c;
    for (const [a, f] of Object.entries(drop.firsts)) if (!keep.firsts[a] || String(f.time) < String(keep.firsts[a].time)) keep.firsts[a] = f;
    for (const [a, c] of Object.entries(drop.other.counts)) keep.other.counts[a] = (keep.other.counts[a] || 0) + c;
    keep.other.partners = uniq(keep.other.partners, drop.other.partners, 20);
    keep.other.orgasms += drop.other.orgasms;
    if (keep.other.past == null) keep.other.past = drop.other.past;
    keep.positions = uniq(keep.positions, drop.positions, 12); keep.places = uniq(keep.places, drop.places, 10);
    keep.likes = uniq(keep.likes, drop.likes, 10); keep.spots = uniq(keep.spots, drop.spots, 6);
    keep.limits = uniq(keep.limits, drop.limits, 6); keep.dislikes = uniq(keep.dislikes, drop.dislikes, 6);
    keep.diary = [...keep.diary, ...drop.diary].sort((x, y) => String(x.time).localeCompare(String(y.time))).slice(-40);
    keep.knows = { ...drop.knows, ...keep.knows };
    keep.aliases = uniq(keep.aliases, [drop.name, ...(drop.aliases || [])], 6).filter(a => a.toLowerCase() !== keep.name.toLowerCase());
    keep.schedule ??= drop.schedule; keep.experience ||= drop.experience;
    if (!keep.last || (drop.last && String(drop.last.time) > String(keep.last.time))) keep.last = drop.last;
    keep.present = keep.present || drop.present; keep.seen = Math.max(keep.seen || 0, drop.seen || 0); keep.met = Math.min(keep.met ?? 1e9, drop.met ?? 1e9);
    delete s.npcs[dKey];
    for (const other of Object.values(s.npcs)) {
        if (other.knows && dKey in other.knows) { if (other !== keep) other.knows[kKey] = Math.max(other.knows[kKey] || 0, other.knows[dKey]); delete other.knows[dKey]; }
    }
    delete keep.knows[kKey]; delete keep.knows[dKey];
    return true;
}
/** Merges records that are plainly one character (old saves made them when a name was respelled). */
export function dedupeNpcs(s) {
    let merged = 0;
    for (let guard = 0; guard < 20; guard++) {
        const list = Object.values(s.npcs || {});
        let pair = null;
        for (let i = 0; i < list.length && !pair; i++) for (let j = i + 1; j < list.length; j++) if (sameName(list[i].name, list[j].name)) { pair = [list[i], list[j]]; break; }
        if (!pair) break;
        const weight = (n) => (n.stage || 0) * 100 + (n.diary?.length || 0) * 5 + Math.abs(n.trust || 0) + (n.affection || 0) + (n.attraction || 0) - (n.met || 0) / 1000;
        const [keep, drop] = weight(pair[0]) >= weight(pair[1]) ? pair : [pair[1], pair[0]];
        if (!mergeNpcs(s, keep.name, drop.name)) break;
        merged++;
    }
    return merged;
}

/** With the player / with others / both: counts per act, for the card. */
export function intimacyTotals(n) {
    const you = n.counts || {}, oth = n.other?.counts || {};
    const all = {};
    for (const a of ACT_IDS) all[a] = (you[a] || 0) + (oth[a] || 0);
    const past = Math.max(0, Number(n.other?.past) || 0);
    const partners = past + (n.other?.partners?.length || 0) + ((you.sex || you.anal || you.oral_her || you.oral_you) ? 1 : 0);
    return { you, others: oth, all, partners, pastKnown: n.other?.past != null && n.other.past >= 0 };
}

export function ensureNpc(n) {
    n.trust ??= 0;
    n.attraction ??= 0;
    n.affection ??= Math.max(0, Math.round((n.trust || 0) / 2));
    n.lust ??= 0;
    n.openness ??= 20;
    n.orgasms ??= 0;
    n.userOrgasms ??= 0;
    n.firsts ??= {};
    // old saves: firsts were ISO strings under kiss/touch/oral/sex
    for (const [k, v] of Object.entries(n.firsts)) {
        const id = normAct(k) || k;
        const val = typeof v === 'string' ? { time: v } : v;
        if (id !== k) { delete n.firsts[k]; n.firsts[id] ??= val; } else n.firsts[k] = val;
    }
    n.counts ??= Object.fromEntries(Object.keys(n.firsts).filter(k => ACT_IDS.includes(k)).map(k => [k, 1]));
    n.protected ??= 0;
    n.unprotected ??= 0;
    n.positions ??= [];
    n.places ??= [];
    n.likes ??= [];
    n.spots ??= [];
    n.limits ??= [];
    n.last ??= null;
    n.pace ??= 'normal';
    n.experience ??= '';
    n.stage ??= Math.max(0, ...ACTS.filter(a => n.firsts[a.id]).map(a => a.stage), n.attraction >= 10 ? 1 : 0);
    n.sceneStage ??= n.stage;
    n.boost ??= null;
    n.diary ??= [];
    n.knows ??= {};
    n.schedule ??= null;
    n.dislikes ??= [];
    n.aliases ??= [];
    n.statuses ??= [];
    n.other ??= {};
    n.other.counts ??= {}; n.other.partners ??= []; n.other.orgasms ??= 0; n.other.past ??= null; n.other.sess ??= null; n.other.last ??= null;
    n.sess ??= null;
    // "times together": old saves only have the sex scenes the mini-game finished
    n.times ??= Math.max(n.scenes || 0, (n.counts?.sex || n.counts?.oral_her || n.counts?.oral_you || n.counts?.hands) ? 1 : 0);
    return n;
}

// ------------------------------------------------------------------ schedules

const DAY_RE = { all: /./, weekdays: /[1-5]/, weekend: /[06]/ };
const toMin = (t) => { const m = String(t || '').match(/(\d{1,2}):(\d{2})/); return m ? (+m[1]) * 60 + (+m[2]) : null; };

/** What a character is supposed to be doing at this moment by their routine, or null. */
export function activityAt(n, iso) {
    if (!Array.isArray(n?.schedule) || !n.schedule.length) return null;
    const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (!m) return null;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    const dow = String(d.getUTCDay());
    const now = (+m[4]) * 60 + (+m[5]);
    for (const e of n.schedule) {
        if (!(DAY_RE[e.days] || DAY_RE.all).test(dow)) continue;
        const a = toMin(e.from), b = toMin(e.to);
        if (a == null || b == null) continue;
        const inside = a <= b ? (now >= a && now < b) : (now >= a || now < b);
        if (inside) return e;
    }
    return null;
}

export function cleanSchedule(list) {
    return (Array.isArray(list) ? list : []).slice(0, 10).map(e => ({
        days: DAY_RE[e?.days] ? e.days : 'all',
        from: String(e?.from || '').slice(0, 5), to: String(e?.to || '').slice(0, 5),
        where_ru: String(e?.where_ru || '').slice(0, 40), doing_ru: String(e?.doing_ru || '').slice(0, 60), doing_en: String(e?.doing_en || '').slice(0, 100),
        busy: Boolean(e?.busy),
    })).filter(e => toMin(e.from) != null && toMin(e.to) != null);
}

export function schedulePrompt({ npc, card, era, setting }) {
    return P.render('schedule', { name: npc.name, card: card ? ` (card: ${String(card).slice(0, 1200)})` : '', setting: setting || 'unknown', era: era ? ` (${era})` : '', format: P.render('schedule_format') });
}

// ------------------------------------------------------------------ side quests

export function questPrompt({ state, setting, user }) {
    const npcs = Object.values(state.npcs || {}).slice(-6).map(n => n.name).join(', ') || 'none yet';
    const goals = (state.goals || []).filter(g => g.status === 'active').map(g => g.title).join('; ') || 'none';
    return P.render('quest', { user, setting: setting || 'unknown', time: `${timeEn(state.time)}${state.era ? ` (${state.era})` : ''}`, location: state.location || '?', npcs, goals, level: state.level, money: state.money, currency: state.currency, scale: scaleLine(state), format: P.render('quest_format', { user }) });
}

export function addOffer(s, q) {
    if (!q?.title_ru) return null;
    const offer = { id: uid(), title: String(q.title_ru).slice(0, 70), giver: String(q.giver || '').slice(0, 40), hook_en: String(q.hook_en || '').slice(0, 300), reward_money: clamp(Math.round(Number(q.reward_money) || 0), 0, incomeCap(s)), reward_xp: clamp(Math.round(Number(q.reward_xp) || 4), 2, 10), reward_ru: String(q.reward_ru || '').slice(0, 60), turn: s.turn, status: 'offered', hooks: 0 };
    s.offers = [...(s.offers || []).filter(o => o.status === 'offered' || o.status === 'taken').slice(-4), offer];
    s.lastOfferTurn = s.turn;
    return offer;
}

/** Thresholds for a stage with this character, the game's pace and the player's passion. */
export function stageReq(stageIdx, n, { pace = 'medium', passion = 1 } = {}) {
    const st = STAGES[stageIdx];
    const k = (PACES[pace]?.k ?? 1) * (n.pace === 'fast' ? 0.55 : n.pace === 'slow' ? 1.3 : 1);
    const heat = n.lust >= 70 ? 8 : n.lust >= 45 ? 4 : 0; // the heat of the moment lowers the bar a little
    const skill = Math.max(0, (passion ?? 1) - 1) * 2;
    const out = {};
    for (const [key, v] of Object.entries(st.req)) {
        // characters made for quick sex don't need trust or love for it
        if (n.pace === 'fast' && (key === 'trust' || key === 'affection')) continue;
        let need = Math.round(v * k);
        if (key === 'attraction' || key === 'openness') need -= heat + skill;
        out[key] = Math.max(0, need);
    }
    return out;
}

const REQ_RU = { attraction: 'влечение', trust: 'доверие', affection: 'привязанность', openness: 'раскрепощённость' };
const REQ_EN = { attraction: 'to want {{user}} more', trust: 'to trust {{user}} more', affection: 'to feel more attached', openness: 'to feel less shy, more comfortable' };

/**
 * How far this character is ready to go right now.
 * { reached, ready, next, missing: [{key, have, need}] }
 */
export function readiness(n0, opts = {}) {
    const n = ensureNpc(JSON.parse(JSON.stringify(n0)));
    const scene = opts.scene ?? 0;
    const perScene = PACES[opts.pace]?.perScene ?? 2;
    const met = (i) => Object.entries(stageReq(i, n, opts)).every(([k, v]) => (n[k] ?? 0) >= v);
    const bondOk = n.trust > -20 && n.attraction >= 15;
    let open = 0;
    for (let i = 1; i < STAGES.length; i++) {
        // what has already happened stays open while the bond is not broken
        if ((i <= n.stage && bondOk) || met(i)) open = i; else break;
    }
    if (n.trust <= -30) open = n.attraction >= 50 ? Math.min(open, n.stage) : 0;
    const b = n.boost && n.boost.scene === scene ? n.boost.steps : 0; // a won roll: a step further than feelings allow
    const cap = Math.max(n.stage, (n.sceneStage ?? n.stage) + perScene + (n.pace === 'fast' ? 1 : 0)) + b;
    const ready = clamp(Math.min(open + b, cap), 0, STAGES.length - 1);
    const nextIdx = Math.min(STAGES.length - 1, ready + 1);
    const missing = ready >= STAGES.length - 1 ? [] : Object.entries(stageReq(nextIdx, n, opts)).filter(([k, v]) => (n[k] ?? 0) < v).map(([key, need]) => ({ key, have: n[key] ?? 0, need }));
    const sceneLimited = ready < STAGES.length - 1 && !missing.length;
    return { reached: n.stage, ready, next: ready >= STAGES.length - 1 ? null : nextIdx, missing, sceneLimited };
}
export const reqRu = (k) => REQ_RU[k] || k;

/** One-word status for the card, from the numbers. */
export function loveStatus(n) {
    ensureNpc(n);
    if (n.trust <= -30) return n.attraction >= 50 ? 'Ненависть и страсть' : 'Вражда';
    if (n.affection >= 75 && n.attraction >= 60) return 'Любовь';
    const intimate = n.stage >= 4;
    if (intimate && n.affection >= 45) return 'Любовники';
    if (intimate) return 'Страсть без обязательств';
    if (n.lust >= 70) return 'Сгорает от желания';
    if (n.stage >= 2) return 'Целовались';
    if (n.attraction >= 60) return 'Хочет тебя';
    if (n.affection >= 50) return 'Привязанность';
    if (n.attraction >= 30) return 'Интерес';
    if (n.trust >= 15) return 'Симпатия';
    return 'Знакомство';
}

export const NPC_COLORS = ['7ec8e3', 'e3b77e', 'c3a6ff', '8fe3a8', 'ff9fb2', 'e3e07e', '7ee3d4', 'ffb38a', 'a6c8ff', 'd9a6ff', 'b4e37e', 'ff8f8f'];

/*
 * "Силы" (energy): the player's spendable reserve. Internally it is still `stress` = how much is
 * spent (0 = fresh, STRESS_MAX = empty), so old saves and prompts keep working.
 * Spend 1 to pull yourself together (+2 to a roll); disasters and hard scenes drain it; rest,
 * good scenes, victories and calming items give it back. At 0 the hero is spent: -1 to every roll
 * until at least half is back.
 */
export const STRESS_MAX = 6;
export const energyOf = (s) => STRESS_MAX - clamp(s?.stress ?? 0, 0, STRESS_MAX);
/** Changes the strain by delta (+ drains energy, - restores) and keeps the "spent" flag honest. */
export function strain(s, delta, notes = null, why = '') {
    const before = s.stress ?? 0;
    s.stress = clamp(before + delta, 0, STRESS_MAX);
    const d = s.stress - before;
    if (d && notes) notes.push({ kind: 'stress', delta: d, why });
    if (s.stress >= STRESS_MAX && !s.spent) { s.spent = true; if (notes) notes.push({ kind: 'spent' }); }
    else if (s.spent && s.stress <= STRESS_MAX / 2) { s.spent = false; if (notes) notes.push({ kind: 'recovered' }); }
    return d;
}
export const MAX_LEVEL = 30;
/** XP to go from `level` to the next one: 6, 7, 9, 10 … ~48 at the top. */
export const xpNeed = (level) => Math.round(4.5 + 1.5 * level);
/** Kept for old code paths; the real need grows per level. */
export const XP_PER_LEVEL = xpNeed(1);
export const TITLES = [[1, 'Новичок'], [3, 'Бродяга'], [6, 'Искатель'], [9, 'Бывалый'], [12, 'Ветеран'], [15, 'Герой'], [18, 'Чемпион'], [21, 'Мастер'], [24, 'Прославленный'], [27, 'Живая легенда'], [30, 'Легенда']];
export const titleOf = (level) => { let t = TITLES[0][1]; for (const [l, n] of TITLES) if (level >= l) t = n; return t; };
export const PERK_EVERY = 3;

/*
 * Perks: one every PERK_EVERY levels. adv = roll 3 dice, keep the best two, for that skill.
 */
export const PERKS = {
    second_chance: { ru: 'Второй шанс', icon: '🔁', text: 'Раз за сцену можно перебросить проваленный бросок.' },
    lucky:         { ru: 'Везунчик', icon: '🍀', text: 'Две единицы — просто провал, а не катастрофа.' },
    tough:         { ru: 'Крепкий', icon: '🛡️', text: 'Катастрофы ранят на одну ступень меньше.' },
    cool:          { ru: 'Хладнокровие', icon: '🧊', text: 'Провалы не добавляют стресс.' },
    fast_learner:  { ru: 'Самоучка', icon: '📈', text: '+1 опыт за каждый провал и каждую цель.' },
    heartthrob:    { ru: 'Сердцеед', icon: '💘', text: 'Влечение к тебе растёт быстрее.' },
    seducer:       { ru: 'Обольститель', icon: '🌹', text: 'Близость открывается легче (пороги ниже).' },
    tireless:      { ru: 'Неутомимый', icon: '♾️', text: 'Оргазмы партнёра сильнее раскрепощают и привязывают.' },
    adv_might:     { ru: 'Талант: Сила', icon: '💪', text: 'Броски Силы — 3 кубика, лучшие два.', adv: 'might' },
    adv_finesse:   { ru: 'Талант: Ловкость', icon: '🗝️', text: 'Броски Ловкости — 3 кубика, лучшие два.', adv: 'finesse' },
    adv_insight:   { ru: 'Талант: Чутьё', icon: '👁️', text: 'Броски Чутья — 3 кубика, лучшие два.', adv: 'insight' },
    adv_charm:     { ru: 'Талант: Обаяние', icon: '🎭', text: 'Броски Обаяния — 3 кубика, лучшие два.', adv: 'charm' },
    adv_resolve:   { ru: 'Талант: Воля', icon: '🔥', text: 'Броски Воли — 3 кубика, лучшие два.', adv: 'resolve' },
    adv_lore:      { ru: 'Талант: Знание', icon: '📜', text: 'Броски Знания — 3 кубика, лучшие два.', adv: 'lore' },
    adv_passion:   { ru: 'Талант: Страсть', icon: '💋', text: 'Броски Страсти — 3 кубика, лучшие два.', adv: 'passion' },
};
export const hasPerk = (s, id) => Array.isArray(s.perks) && s.perks.includes(id);
export const hasAdvantage = (s, skill) => (s.perks || []).some(p => PERKS[p]?.adv === skill);
/** Perk picks earned but not chosen yet. */
export const perkPicks = (s) => Math.max(0, Math.floor((s.level || 1) / PERK_EVERY) - (s.perks?.length || 0));
export function choosePerk(state, id) {
    const s = clone(state);
    if (!PERKS[id] || hasPerk(s, id) || perkPicks(s) <= 0) return state;
    s.perks = [...(s.perks || []), id];
    return s;
}
/** Fills in fields added after a save was made. */
export function ensureState(s) {
    s.skills ??= {};
    for (const k of Object.keys(SKILLS)) s.skills[k] ??= 1;
    s.perks ??= [];
    s.perkUsed ??= {};
    s.scene ??= 0;
    s.pace ??= 'medium';
    s.era ??= '';
    s.gear ??= {};
    s.offers ??= [];
    s.pending ??= [];
    s.enc ??= null;
    // eroge is the default way to play: saves from before v3 are switched on once
    if ((s.v || 2) < 3) { s.eroge = true; s.v = 3; }
    if (s.v < 4) { for (const n of Object.values(s.npcs || {})) ensureNpc(n); dedupeNpcs(s); }
    if (s.v < 5) { s.stress = clamp(Math.round((s.stress || 0) * 6 / 9), 0, STRESS_MAX); s.spent = s.stress >= STRESS_MAX; }
    s.spent ??= false;
    s.statuses ??= [];
    s.v = 5;
    s.eroge ??= true;
    s.econ ??= null;
    s.ledger ??= [];
    s.journal ??= [];
    s.level ??= 1; s.xp ??= 0; s.unspent ??= 0;
    for (const n of Object.values(s.npcs || {})) ensureNpc(n);
    return s;
}
// ------------------------------------------------------------------ economy

/** "a simple meal costs about 8, a day of ordinary work pays about 40" — for helper prompts. */
export function scaleLine(state) {
    const e = state?.econ;
    return e ? `a simple meal costs about ${e.meal} ${state.currency}, a day of ordinary work pays about ${e.day} ${state.currency}` : 'unknown; keep amounts modest';
}
export function setEcon(s, meal, day) {
    const m = Math.round(Number(meal) || 0), d = Math.round(Number(day) || 0);
    if (m > 0 && d > 0) s.econ = { meal: m, day: Math.max(d, m) };
    return s.econ || null;
}
/** The most a single windfall can bring: a month of wages, or a guess when the scale is unknown. */
export const incomeCap = (s) => (s.econ ? s.econ.day * 30 : Math.max(500, (s.money || 0) * 3));

export const MONEY_KINDS = {
    payment: { ru: 'Оплата', sign: 1, icon: '🤝' }, reward: { ru: 'Награда', sign: 1, icon: '🏅' }, found: { ru: 'Находка', sign: 1, icon: '🔎' },
    loot: { ru: 'Добыча', sign: 1, icon: '🗡' }, wage: { ru: 'Заработок', sign: 1, icon: '⚒' }, sale: { ru: 'Продажа', sign: 1, icon: '⚖' },
    gift: { ru: 'Подарок', sign: 0, icon: '🎁' }, purchase: { ru: 'Покупка', sign: -1, icon: '🛒' }, fee: { ru: 'Плата', sign: -1, icon: '🧾' },
    loss: { ru: 'Потеря', sign: -1, icon: '💸' }, theft: { ru: 'Кража', sign: -1, icon: '🕳' },
};

/**
 * One money movement with a reason. Returns the applied delta (0 if rejected).
 * The engine, not the model, has the last word: a known kind, a stated reason, a sane size.
 */
export function moneyOp(s, op, notes = []) {
    const kind = MONEY_KINDS[op?.kind] ? op.kind : null;
    const why = String(op?.why_ru || op?.why || '').trim().slice(0, 60);
    let amount = Math.round(Number(op?.amount) || 0);
    if (!kind || !why || !amount) return 0;
    const sign = MONEY_KINDS[kind].sign || Math.sign(amount);
    amount = Math.abs(amount) * sign;
    if (amount > 0) amount = Math.min(amount, incomeCap(s));
    else amount = -Math.min(-amount, s.money);
    if (!amount) return 0;
    s.money += amount;
    const who = String(op?.who || '').trim().slice(0, 40);
    s.ledger = [...(s.ledger || []), { turn: s.turn, time: s.time, amount, kind, who, why }].slice(-40);
    notes.push({ kind: 'money', delta: amount, why, who, op: kind });
    return amount;
}

/** What a consumable does when used from the bag. */
export const ITEM_EFFECTS = { heal: { ru: 'лечит раны', icon: '🩹' }, calm: { ru: 'снимает стресс', icon: '🍵' } };

/** Uses a consumable with an effect. Returns notes, or null when it can't be used now. */
export function consumeItem(s, name, userName = 'The player') {
    const g = s.gear?.[name];
    if (!g || !ITEM_EFFECTS[g.effect]) return null;
    const notes = [];
    if (g.effect === 'heal') {
        const sick = ['poisoned', 'bleeding'].filter(id => ST.has(s, id));
        if (!(s.harm > 0) && !sick.length) return null;
        for (const id of sick) { ST.remove(s, id); notes.push({ kind: 'status_end', name: '', id }); }
        if (s.harm > 0) { notes.push({ kind: 'harm', from: s.harm, to: s.harm - 1 }); s.harm -= 1; }
    }
    if (g.effect === 'calm') { if (!(s.stress > 0)) return null; strain(s, -3, notes, name); }
    useItem(s, name, 1, notes);
    s.pending = [...(s.pending || []), `${userName} used ${name} (${g.effect === 'heal' ? 'wounds treated' : 'nerves settled'}; already counted)`];
    return notes;
}

/** Gives an item to a character who is present: a small, real warming of the relationship. */
export function giftItem(s, name, npcName, userName = 'The player') {
    const g = s.gear?.[name];
    const npc = Object.values(s.npcs || {}).find(n => n.name === npcName);
    if (!s.items.includes(name) || !npc) return null;
    ensureNpc(npc);
    const notes = [];
    const worth = Number(g?.value) || 0;
    const big = s.econ ? worth >= s.econ.day : worth > 0 && (g?.bonus || 0) >= 1;
    const aff = big ? 5 : 3;
    npc.affection = clamp(npc.affection + aff, 0, 100);
    npc.trust = clamp(npc.trust + 1, -100, 100);
    notes.push({ kind: 'gift', name: npc.name, item: name, affection: aff });
    npc.diary = [...(npc.diary || []), { time: s.time, ru: `Подарок: ${name}`, en: `${userName} gave ${npc.name} a gift: ${name}` }].slice(-12);
    useItem(s, name, 1, []);
    s.pending = [...(s.pending || []), `${userName} gives ${npc.name} a gift: ${name} (the item has already left ${userName}'s bag; show ${npc.name}'s reaction in character)`];
    return notes;
}

/** What a trader pays for an item: half its worth. */
export function sellPrice(s, name) {
    const g = s.gear?.[name];
    const v = Math.round((Number(g?.value) || 0) / 2);
    return v > 0 ? v : 0;
}
export function sellItem(s, name, place = '', userName = 'The player') {
    const price = sellPrice(s, name);
    if (!price || !s.items.includes(name)) return null;
    const notes = [];
    useItem(s, name, 1, []);
    notes.push({ kind: 'item', name, delta: -1 });
    moneyOp(s, { amount: price, kind: 'sale', who: place, why_ru: name }, notes);
    s.pending = [...(s.pending || []), `${userName} sold ${name} for ${price} ${s.currency} (already counted)`];
    return notes;
}

/** The player takes an offered side quest from the menu. */
export function acceptOffer(s, id, userName = 'The player') {
    const offer = (s.offers || []).find(o => o.id === id && o.status === 'offered');
    if (!offer || s.goals.filter(g => g.status === 'active').length >= MAX_GOALS) return null;
    offer.status = 'taken';
    s.goals.push({ id: uid(), title: offer.title, status: 'active', since: s.turn, offer: offer.id });
    s.pending = [...(s.pending || []), `${userName} has decided to take up the task "${offer.title}"${offer.giver ? ` from ${offer.giver}` : ''}: ${offer.hook_en}`];
    return [{ kind: 'goal_new', title: offer.title, quest: true }];
}
export function declineOffer(s, id) {
    const offer = (s.offers || []).find(o => o.id === id && o.status === 'offered');
    if (!offer) return false;
    offer.status = 'declined';
    return true;
}

export const MAX_GOALS = 6;
export const MAX_CLOCKS = 6;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const uid = () => Math.random().toString(36).slice(2, 9);
export const clone = (o) => JSON.parse(JSON.stringify(o));

// ------------------------------------------------------------------ state

export function newState(setup = {}) {
    const skills = {};
    for (const k of Object.keys(SKILLS)) skills[k] = clamp(Number(setup.skills?.[k] ?? 1), 0, START_MAX);
    return {
        v: 5,
        spent: false,
        statuses: [],
        pace: PACES[setup.pace] ? setup.pace : 'medium',
        eroge: setup.eroge === undefined ? true : Boolean(setup.eroge),
        econ: null,
        ledger: [],
        journal: [],
        perks: [],
        perkUsed: {},
        scene: 0,
        era: String(setup.era || '').slice(0, 40),
        difficulty: DIFFICULTY[setup.difficulty] ? setup.difficulty : 'standard',
        skills,
        level: 1,
        xp: 0,
        unspent: 0,
        harm: 0,
        scars: [],
        stress: 0,
        money: Number(setup.money ?? 0) || 0,
        currency: setup.currency || '🪙',
        items: [],
        time: setup.time || new Date().toISOString().slice(0, 11) + '19:00',
        location: setup.location || '',
        weather: 'clear',
        npcs: {},
        clocks: [],
        goals: [],
        log: [],
        turn: 0,
    };
}

export function tierOf(trust) {
    let t = TIERS[0];
    for (const x of TIERS) if (trust >= x.min) t = x;
    return t;
}

// ------------------------------------------------------------------ checks

/** Modifier the player gets for a skill right now (skill + harm penalty). */
export function modifier(state, skill) {
    return (state.skills?.[skill] ?? 1) + HARM[clamp(state.harm, 0, 3)].penalty + (gearFor(state, skill)?.bonus || 0) - (state.spent ? 1 : 0) + ST.modOf(state);
}

// ------------------------------------------------------------------ gear

/** The best item the player carries for this skill: { name, bonus } or null. Bonuses don't stack. */
export function gearFor(state, skill) {
    let best = null;
    for (const [name, g] of Object.entries(state.gear || {})) {
        if (g.skill !== skill || !(g.bonus > 0) || (g.consumable && !(g.qty > 0))) continue;
        if (!best || g.bonus > best.bonus) best = { name, bonus: g.bonus };
    }
    return best;
}

const CONDOM = /презерв|condom|резинк/i;

/** Adds an item; extractor/shop objects carry a skill bonus, plain strings don't. */
export function addItem(s, raw, notes = []) {
    const it = typeof raw === 'string' ? { name_ru: raw } : (raw || {});
    const name = String(it.name_ru || it.name || '').trim().slice(0, 40);
    if (!name) return;
    const qty = clamp(Math.round(Number(it.qty) || 1), 1, 99);
    const key = Object.keys(s.gear).find(k => k.toLowerCase() === name.toLowerCase()) || name;
    const g = s.gear[key] ?? { skill: '', bonus: 0, consumable: false, qty: 0, desc: '', effect: '', value: 0 };
    if (SKILLS[it.skill]) g.skill = it.skill;
    if (Number(it.bonus) > 0) g.bonus = clamp(Math.round(Number(it.bonus)), 0, 2);
    g.consumable = Boolean(it.consumable ?? g.consumable) || CONDOM.test(name);
    if (it.desc_ru) g.desc = String(it.desc_ru).slice(0, 80);
    if (ITEM_EFFECTS[it.effect]) { g.effect = it.effect; g.consumable = true; }
    const worth = Math.round(Number(it.value ?? it.price) || 0);
    if (worth > 0) g.value = Math.max(1, Math.round(Math.min(worth, incomeCap(s)) / (it.price != null ? qty : 1))); // a shop price is for the whole pack
    g.qty = (g.qty || 0) + qty;
    s.gear[key] = g;
    if (!s.items.some(x => x.toLowerCase() === key.toLowerCase())) s.items.push(key);
    notes.push({ kind: 'item', name: key, delta: qty });
}

export function useItem(s, name, n = 1, notes = []) {
    const key = Object.keys(s.gear || {}).find(k => k.toLowerCase() === String(name).toLowerCase())
        ?? Object.keys(s.gear || {}).find(k => k.toLowerCase().includes(String(name).toLowerCase()));
    const i = s.items.findIndex(x => x.toLowerCase() === String(key || name).toLowerCase());
    if (!key && i < 0) return false;
    const g = key ? s.gear[key] : null;
    if (g && g.consumable && g.qty > n) { g.qty -= n; notes.push({ kind: 'item', name: key, delta: -n }); return true; }
    if (key) delete s.gear[key];
    if (i >= 0) { notes.push({ kind: 'item', name: s.items[i], delta: -1 }); s.items.splice(i, 1); }
    return true;
}

/** "Нож (+1 Сила), Презервативы ×3" — for the narrator, the referee and the card. */
export function itemsLine(state) {
    return (state.items || []).map((name) => {
        const g = state.gear?.[name];
        if (!g) return name;
        const bits = [];
        if (g.skill && g.bonus) bits.push(`+${g.bonus} ${SKILLS[g.skill].en.toLowerCase()}`);
        return `${name}${g.consumable && g.qty > 1 ? ` ×${g.qty}` : ''}${bits.length ? ` (${bits.join(', ')})` : ''}`;
    }).join(', ');
}
export const hasCondoms = (state) => Object.entries(state.gear || {}).some(([k, g]) => CONDOM.test(k) && g.qty > 0);

/** Exposed for encounters: wounds through the normal harm track. */
export function hurt(s, n, events = [], notes = []) { applyHarm(s, n, events, notes); return s; }
export function levelUpState(s, notes = []) { levelUp(s, notes); return s; }

/**
 * How a character's feelings change a check aimed at them.
 * charm: easier with someone who trusts, wants or is aroused by the player; harder with an enemy.
 * resolve (resisting them): harder when they are bold and aroused, easier when the bond is thin.
 * Returns { delta, why: ['её влечение −1', …] } — negative delta = easier.
 */
export function bondModifier(state, check) {
    const out = { delta: 0, why: [] };
    const name = String(check?.target || '').trim().toLowerCase();
    if (!name) return out;
    const npc = state.npcs?.[name] ?? Object.values(state.npcs || {}).find(n => n.name.toLowerCase().includes(name) || name.includes(n.name.toLowerCase()));
    if (!npc) return out;
    const n = ensureNpc(JSON.parse(JSON.stringify(npc)));
    const add = (d, why) => { if (d) { out.delta += d; out.why.push(`${why} ${d > 0 ? '+' : '−'}${Math.abs(d)}`); } };
    if (check.skill === 'charm' || check.skill === 'insight' || check.skill === 'passion') {
        if (n.trust <= -30) add(2, 'вражда');
        else if (n.trust >= 45) add(-1, 'доверие');
    }
    if (check.skill === 'charm' || check.skill === 'passion') {
        if (n.attraction >= 65) add(-2, 'влечение');
        else if (n.attraction >= 40) add(-1, 'влечение');
        if (n.lust >= 60) add(-1, 'возбуждение');
        if (n.affection >= 60) add(-1, 'привязанность');
    }
    if (check.skill === 'resolve') {
        if (n.lust >= 60 && n.openness >= 50) add(1, 'её напор');
        if (n.attraction >= 65) add(1, 'взаимное влечение');
    }
    out.delta = clamp(out.delta, -3, 3);
    return out;
}

export function effectiveDc(state, dc, check = null) {
    return clamp(Math.round(Number(dc) || 8), 4, 16) + DIFFICULTY[state.difficulty].dc + (check ? bondModifier(state, check).delta : 0);
}

/** Classify a total of 2d6 + mod. */
export function classify(d1, d2, mod, dc, position) {
    const total = d1 + d2 + mod;
    if (d1 === 1 && d2 === 1) return position === 'controlled' ? 'fail' : 'disaster';
    if ((d1 === 6 && d2 === 6) || total >= dc + 5) return 'crit';
    if (total >= dc) return 'success';
    if (total >= dc - 2) return 'near';
    if (position === 'desperate' && total <= dc - 5) return 'disaster';
    return 'fail';
}

/** The two dice that count: with advantage (3 dice) the best two. */
export const bestTwo = (dice) => [...dice].sort((x, y) => y - x).slice(0, 2);

/** Classify a roll (2 or 3 dice). opts.lucky: double ones are only a fail. */
export function classifyDice(dice, mod, dc, position, opts = {}) {
    const [a, b] = bestTwo(dice);
    const out = classify(a, b, mod, dc, position);
    if (opts.lucky && out === 'disaster' && a === 1 && b === 1) return 'fail';
    return out;
}

/** Exact odds over 2d6 (or 3d6 keep best 2 with advantage). */
export function odds(mod, dc, position, opts = {}) {
    const r = { crit: 0, success: 0, near: 0, fail: 0, disaster: 0 };
    let total = 0;
    if (opts.adv) {
        for (let a = 1; a <= 6; a++) for (let b = 1; b <= 6; b++) for (let c = 1; c <= 6; c++) { r[classifyDice([a, b, c], mod, dc, position, opts)]++; total++; }
    } else {
        for (let a = 1; a <= 6; a++) for (let b = 1; b <= 6; b++) { r[classifyDice([a, b], mod, dc, position, opts)]++; total++; }
    }
    for (const k in r) r[k] /= total;
    r.atLeastSuccess = r.crit + r.success;
    r.atLeastNear = r.atLeastSuccess + r.near;
    return r;
}

export function rollDice(rng = Math.random, n = 2) {
    return Array.from({ length: n }, () => 1 + Math.floor(rng() * 6));
}

/** Everything the card and the engine need to know about a roll before it happens. */
export function rollSetup(state, check) {
    const s = ensureState(clone(state));
    const skill = SKILLS[check.skill] ? check.skill : 'insight';
    const position = POSITIONS[check.position] ? check.position : 'risky';
    return {
        skill, position,
        dc: effectiveDc(s, check.dc, { ...check, skill }),
        mod: modifier(s, skill),
        adv: hasAdvantage(s, skill),
        lucky: hasPerk(s, 'lucky'),
        reroll: hasPerk(s, 'second_chance') && s.perkUsed.second_chance !== s.scene,
    };
}

/**
 * Resolves a referee verdict into an outcome and the state after it.
 * check: { skill, action_en, label_ru, position, effect, dc, success_en, cost_en, fail_en, threat, threat_size, target, intimacy_push }
 * opts: { push: bool, dice: [d1,d2(,d3)], rerolled: bool }
 */
export function resolveCheck(state, check, opts = {}) {
    const s = ensureState(clone(state));
    const setup = rollSetup(s, check);
    const { skill, position, dc } = setup;
    const effect = EFFECTS[check.effect] ? check.effect : 'standard';
    let mod = setup.mod;
    const notes = [];
    if (opts.push) {
        if (s.stress < STRESS_MAX) { strain(s, 1, notes, 'Собраться'); mod += 2; }
    }
    if (opts.rerolled) s.perkUsed.second_chance = s.scene;
    const dice = opts.dice || rollDice(opts.rng, setup.adv ? 3 : 2);
    const outcome = classifyDice(dice, mod, dc, position, { lucky: setup.lucky });
    const events = [];
    const xp = (n, why) => { if (n > 0) { s.xp += n; notes.push({ kind: 'xp', delta: n, why }); } };
    const learner = hasPerk(s, 'fast_learner') ? 1 : 0;

    // Consequences — the engine decides, the narrator dramatises.
    const threat = String(check.threat || '').trim();
    const tickThreat = (n) => {
        if (!threat || n <= 0) return;
        const c = upsertClock(s, threat, 'threat', [4, 6, 8].includes(Number(check.threat_size)) ? Number(check.threat_size) : 6);
        const before = c.filled;
        c.filled = clamp(c.filled + n, 0, c.size);
        notes.push({ kind: 'clock', name: c.name, from: before, to: c.filled, size: c.size });
        if (c.filled >= c.size && before < c.size) events.push({ kind: 'clock_full', clock: clone(c) });
    };
    const pos = POSITIONS[position];
    const cool = hasPerk(s, 'cool');
    switch (outcome) {
        case 'crit':
            events.push({ kind: 'crit' });
            xp(position === 'controlled' ? 1 : 2);
            break;
        case 'success':
            if (position !== 'controlled') xp(1);
            break;
        case 'near':
            if (threat) tickThreat(1);
            xp(1);
            break;
        case 'fail':
            tickThreat(pos.tick);
            if (pos.harm && !threat) applyHarm(s, 1, events, notes);
            xp(2 + learner);
            break;
        case 'disaster':
            tickThreat(pos.tick + 1);
            applyHarm(s, Math.max(0, (position === 'desperate' ? 2 : 1) - (hasPerk(s, 'tough') ? 1 : 0)), events, notes);
            if (!cool) strain(s, 1, notes, 'катастрофа');
            xp(3 + learner);
            break;
        default:
    }

    // Trying to go further in intimacy than the character is ready for.
    const npc = check.intimacy_push ? findNpcIn(s, check.target) : null;
    if (npc) {
        ensureNpc(npc);
        const steps = { crit: 2, success: 1, near: 1 }[outcome] || 0;
        if (steps) {
            npc.boost = { scene: s.scene, steps };
            notes.push({ kind: 'push_ok', name: npc.name });
        } else {
            const hard = outcome === 'disaster';
            npc.attraction = clamp(npc.attraction - (hard ? 4 : 2), 0, 100);
            npc.lust = clamp(npc.lust - (hard ? 30 : 15), 0, 100);
            if (hard) npc.trust = clamp(npc.trust - 3, -100, 100);
            notes.push({ kind: 'push_fail', name: npc.name });
        }
    }
    levelUp(s, notes);

    const record = {
        id: uid(),
        turn: s.turn,
        skill, position, effect, dc,
        mod, dice, total: bestTwo(dice)[0] + bestTwo(dice)[1] + mod,
        adv: dice.length > 2,
        rerolled: Boolean(opts.rerolled),
        outcome,
        push: Boolean(opts.push),
        label_ru: String(check.label_ru || check.action_en || '').slice(0, 80),
        action_en: String(check.action_en || '').slice(0, 120),
        success_en: String(check.success_en || '').slice(0, 160),
        cost_en: String(check.cost_en || '').slice(0, 160),
        fail_en: String(check.fail_en || '').slice(0, 160),
        target: String(check.target || '').slice(0, 40),
        intimacy_push: Boolean(npc),
        bond: bondModifier(state, { ...check, skill }).why,
        notes,
        events,
    };
    s.log = [record, ...s.log].slice(0, 30);
    return { state: s, record };
}

function findNpcIn(s, name) {
    const q = String(name || '').trim().toLowerCase();
    if (!q) return null;
    const all = Object.values(s.npcs || {});
    return s.npcs?.[q] ?? all.find(n => n.name.toLowerCase() === q)
        ?? all.find(n => q.includes(n.name.toLowerCase()) || n.name.toLowerCase().includes(q.split(/\s+/)[0])) ?? null;
}

function applyHarm(s, n, events, notes) {
    if (n <= 0) return;
    const before = s.harm;
    const next = s.harm + n;
    if (next > 3) {
        s.harm = 3;
        events.push({ kind: 'defeat' });
    } else {
        s.harm = next;
    }
    if (s.harm !== before) notes.push({ kind: 'harm', from: before, to: s.harm });
}

function levelUp(s, notes) {
    while (s.level < MAX_LEVEL && s.xp >= xpNeed(s.level)) {
        s.xp -= xpNeed(s.level);
        s.level += 1;
        s.unspent += 1;
        notes.push({ kind: 'level', level: s.level });
        if (s.level % PERK_EVERY === 0) notes.push({ kind: 'perk_pick' });
    }
    if (s.level >= MAX_LEVEL) s.xp = Math.min(s.xp, xpNeed(MAX_LEVEL));
}

export function spendPoint(state, skill) {
    const s = clone(state);
    if (s.unspent <= 0 || !SKILLS[skill] || (s.skills[skill] ?? 1) >= SKILL_MAX) return state;
    s.skills[skill] ??= 1;
    s.skills[skill] += 1;
    s.unspent -= 1;
    return s;
}

// ------------------------------------------------------------------ clocks & goals

export function upsertClock(s, name, kind = 'threat', size = 6) {
    const key = String(name).trim().toLowerCase();
    let c = s.clocks.find(x => x.name.toLowerCase() === key);
    if (!c) {
        c = { id: uid(), name: String(name).trim().slice(0, 40), kind: kind === 'progress' ? 'progress' : 'threat', size: [4, 6, 8].includes(size) ? size : 6, filled: 0 };
        s.clocks.push(c);
        if (s.clocks.length > MAX_CLOCKS) s.clocks.splice(s.clocks.findIndex(x => x.filled >= x.size) >= 0 ? s.clocks.findIndex(x => x.filled >= x.size) : 0, 1);
    }
    return c;
}

/** Finished clocks are dropped one turn after they fire. */
function sweepClocks(s) {
    s.clocks = s.clocks.filter(c => !(c.filled >= c.size && c.fired));
    for (const c of s.clocks) if (c.filled >= c.size) c.fired = true;
}

// ------------------------------------------------------------------ time

const WEEKDAYS_RU = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const MONTHS_RU = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

function parseTime(iso) {
    const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (!m) return new Date(Date.UTC(2026, 2, 12, 19, 0));
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
}

function formatIso(d) {
    return d.toISOString().slice(0, 16);
}

export function advanceTime(iso, minutes) {
    const d = parseTime(iso);
    d.setUTCMinutes(d.getUTCMinutes() + clamp(Math.round(Number(minutes) || 0), 0, 60 * 24 * 30));
    return formatIso(d);
}

export function timeRu(iso) {
    const d = parseTime(iso);
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    return `${WEEKDAYS_RU[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS_RU[d.getUTCMonth()]} · ${hh}:${mm}`;
}

export function timeEn(iso) {
    const d = parseTime(iso);
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    let h = d.getUTCHours();
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${days[d.getUTCDay()]}, ${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}, ${h}:${String(d.getUTCMinutes()).padStart(2, '0')} ${ampm}`;
}

/** Reads the preset's own tracker line: [ 🕐 Tuesday, March 12, 2026. 11:40 PM | 📍 Docks | 🌤 Rain ] */
export function parseTrackerLine(text) {
    const m = String(text || '').match(/\[\s*🕐\s*([^|\]]+)\|\s*📍\s*([^|\]]+)\|\s*🌤\s*([^\]]+)\]/u);
    if (!m) return null;
    const out = { location: m[2].trim(), weatherText: m[3].trim() };
    const t = m[1].match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})\.?,?\s+(\d{1,2}):(\d{2})\s*([AaPp][Mm])?/);
    if (t) {
        const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
        const mi = months.findIndex(x => x.startsWith(t[1].toLowerCase().slice(0, 3)));
        if (mi >= 0) {
            let h = Number(t[4]) % 12;
            if (!t[6]) h = Number(t[4]);
            else if (/p/i.test(t[6])) h += 12;
            out.time = `${t[3]}-${String(mi + 1).padStart(2, '0')}-${String(t[2]).padStart(2, '0')}T${String(h).padStart(2, '0')}:${t[5]}`;
        }
    }
    const w = out.weatherText.toLowerCase();
    out.weather = /storm|thunder|гроз/.test(w) ? 'storm' : /rain|drizzle|дожд|ливн/.test(w) ? 'rain' : /snow|снег/.test(w) ? 'snow' : /fog|mist|туман/.test(w) ? 'fog' : 'clear';
    return out;
}

// ------------------------------------------------------------------ extraction (after a reply)

/**
 * Applies the extractor's report of what happened in the narrator's reply.
 * Everything is clamped: the model reports, the engine decides how much it counts.
 */
export function applyReport(state, report, { trackerLine = null, colors = null, userName = '' } = {}) {
    const s = ensureState(clone(state));
    const notes = [];
    const events = [];
    s.turn += 1;
    sweepClocks(s);
    // conditions: one turn passes (hours of story time pass faster), poison and bleeding drain the hero
    const ticks = 1 + Math.min(12, Math.floor((Number(report?.minutes) || 0) / 60));
    for (const id of ST.tick(s, ticks)) notes.push({ kind: 'status_end', name: '', id });
    for (const n of Object.values(s.npcs)) for (const id of ST.tick(n, ticks)) notes.push({ kind: 'status_end', name: n.name, id });
    if (ST.dotOf(s) && s.turn % 3 === 0) strain(s, 1, notes, ST.has(s, 'poisoned') ? 'яд' : 'кровь');
    for (const c of (Array.isArray(report?.statuses) ? report.statuses : []).slice(0, 4)) {
        const who = String(c?.who || '').trim();
        const hero = !who || /^(\{\{user\}\}|user|player|hero|you)$/i.test(who) || (userName && sameName(who, userName));
        const holder = hero ? s : resolveNpc(s, who);
        const id = ST.statusId(c?.id);
        if (!holder || !id) continue;
        if (c.on === false) { if (ST.remove(holder, id)) notes.push({ kind: 'status_end', name: hero ? '' : holder.name, id }); }
        else if (!ST.has(holder, id)) { const e = ST.add(holder, id, { by: c.by }); notes.push({ kind: 'status', name: hero ? '' : holder.name, id, left: e.left }); }
    }
    const xp = (n, why) => { if (n > 0) { s.xp += n; notes.push({ kind: 'xp', delta: n, why }); } };
    const learner = hasPerk(s, 'fast_learner') ? 1 : 0;
    // A new scene starts with a scene change or a big jump in time; the intimacy pace counts per scene.
    if (report?.scene_changed || Number(report?.minutes) >= 180) {
        s.scene += 1;
        for (const n of Object.values(s.npcs)) { ensureNpc(n); n.sceneStage = n.stage; n.lust = Math.round(n.lust * 0.4); n.boost = null; }
    }

    if (trackerLine?.time) s.time = trackerLine.time;
    else s.time = advanceTime(s.time, report?.minutes ?? 5);
    if (trackerLine?.location) s.location = trackerLine.location;
    else if (report?.location_ru) s.location = String(report.location_ru).slice(0, 40);
    if (trackerLine?.weather) s.weather = trackerLine.weather;
    else if (report?.weather) s.weather = report.weather;

    s.pending = [];
    for (const o of s.offers || []) if (o.status === 'offered') o.hooks = (o.hooks || 0) + 1;
    // an offer nobody picked up fades after a while
    s.offers = (s.offers || []).filter(o => !(o.status === 'offered' && o.hooks > 12));
    if (!report) return { state: s, notes, events };

    // relationships, romance, intimacy
    const touched = new Set();
    for (const n of Array.isArray(report.npcs) ? report.npcs.slice(0, 6) : []) {
        const name = String(n?.name || '').trim();
        if (!name || name.length > 40) continue;
        let npc = resolveNpc(s, name, { learn: true });
        const key = npc ? keyOf(s, npc) : name.toLowerCase();
        if (!npc) {
            const used = new Set(Object.values(s.npcs).map(x => x.color));
            npc = s.npcs[key] = {
                name,
                // A character who already has history with the player (card, earlier story) starts where they are.
                trust: clamp(Number(n.start_trust ?? 0) || 0, -40, 40),
                attraction: clamp(Number(n.start_attraction ?? 0) || 0, 0, 70),
                affection: clamp(Number(n.start_affection ?? 0) || 0, 0, 70),
                openness: clamp(Number(n.start_openness ?? 20) || 20, 0, 70),
                // The app's voice table (elephant/voices) decides colours when it knows this character.
                color: (typeof colors === 'function' ? colors(name) : null) || NPC_COLORS.find(c => !used.has(c)) || NPC_COLORS[Object.keys(s.npcs).length % NPC_COLORS.length],
                met: s.turn,
            };
            notes.push({ kind: 'npc_new', name });
            xp(1);
        }
        ensureNpc(npc);
        touched.add(key);
        npc.present = n.present !== false;
        npc.seen = s.turn;
        const dt = clamp(Math.round(Number(n.trust) || 0), -6, 6);
        const da = clamp(Math.round(Number(n.attraction) || 0), -5, 5);
        const df = clamp(Math.round(Number(n.affection) || 0), -5, 5);
        const dl = clamp(Math.round(Number(n.lust) || 0), -40, 40);
        let dop = clamp(Math.round(Number(n.openness) || 0), 0, 3);
        let daa = da;
        if (daa > 0 && hasPerk(s, 'heartthrob')) daa += 1;
        if (dt || daa || df) {
            const beforeTier = tierOf(npc.trust).id;
            npc.trust = clamp(npc.trust + dt, -100, 100);
            npc.attraction = clamp(npc.attraction + daa, 0, 100);
            npc.affection = clamp(npc.affection + df, 0, 100);
            notes.push({ kind: 'rel', name: npc.name, trust: dt, attraction: daa, affection: df, why: String(n.why_ru || '').slice(0, 60) });
            const afterTier = tierOf(npc.trust).id;
            if (afterTier !== beforeTier) {
                notes.push({ kind: 'tier', name: npc.name, from: beforeTier, to: afterTier });
                if (TIERS.findIndex(t => t.id === afterTier) > TIERS.findIndex(t => t.id === beforeTier)) xp(1);
            }
        }
        // what the card says they bring with them (only for a character the game has just met)
        if (npc.met === s.turn) {
            if (['fast', 'slow'].includes(n.start_pace)) npc.pace = n.start_pace;
            if (EXPERIENCE[n.start_experience]) npc.experience = n.start_experience;
            const st = clamp(Math.round(Number(n.start_stage) || 0), 0, STAGES.length - 1);
            if (st) { npc.stage = st; npc.sceneStage = st; }
            const past = Math.round(Number(n.start_partners));
            if (Number.isFinite(past) && past >= 0) npc.other.past = Math.min(past, 999);
            else if (npc.experience === 'virgin') npc.other.past = 0;
        }
        // intimacy that happened in THIS exchange
        const acts = [...new Set((Array.isArray(n.intimacy) ? n.intimacy : [n.intimacy]).map(normAct).filter(Boolean))];
        const where = String(n.place_ru || s.location || '').trim().slice(0, 40);
        // One session = one continuous time together: an act counts once per session, however many
        // replies the scene takes. A new session starts after a pause or in a new scene.
        if (acts.length) {
            const se = npc.sess;
            if (!se || s.turn - se.turn > 6 || (se.scene !== s.scene && s.turn - se.turn > 1)) npc.sess = { scene: s.scene, turn: s.turn, start: s.time, acts: [], deep: false, prot: false };
            npc.sess.turn = s.turn;
            if (!npc.sess.deep && acts.some(a => ACTS.find(x => x.id === a).stage >= 5)) { npc.sess.deep = true; npc.times += 1; }
        }
        for (const act of acts) {
            const def = ACTS.find(x => x.id === act);
            if (!npc.sess.acts.includes(act)) { npc.sess.acts.push(act); npc.counts[act] = (npc.counts[act] || 0) + 1; }
            npc.last = { act, time: s.time };
            if (!npc.firsts[act]) {
                npc.firsts[act] = { time: s.time, place: where };
                dop += 4; // every first time opens them up
                notes.push({ kind: 'first', name: npc.name, act });
                if (act === 'sex' && npc.experience === 'virgin') { notes.push({ kind: 'virgin', name: npc.name }); npc.experience = 'inexperienced'; }
                xp(def.stage >= 6 ? 2 : 1);
            }
            if (def.stage > npc.stage) {
                npc.stage = def.stage;
                notes.push({ kind: 'stage', name: npc.name, stage: def.stage });
            }
        }
        if ((acts.includes('sex') || acts.includes('anal')) && n.protection && !npc.sess.prot) {
            npc.sess.prot = true;
            if (n.protection === 'none') npc.unprotected += 1; else npc.protected += 1;
            if (n.protection === 'condom' && !(report.items_used || []).some(x => CONDOM.test(typeof x === 'string' ? x : x?.name_ru || ''))) {
                const k = Object.keys(s.gear).find(x => CONDOM.test(x) && s.gear[x].qty > 0);
                if (k) useItem(s, k, 1, notes);
            }
        }
        // witnesses: everyone else in the room now knows how far it went with this character
        if (acts.length) {
            const st = Math.max(...acts.map(a => ACTS.find(x => x.id === a).stage));
            for (const other of report.npcs || []) {
                const on = resolveNpc(s, other?.name);
                const ok = on ? keyOf(s, on) : '';
                if (!ok || ok === key || other.present === false || !s.npcs[ok]) continue;
                ensureNpc(s.npcs[ok]);
                if ((s.npcs[ok].knows[key] || 0) < st) { s.npcs[ok].knows[key] = st; notes.push({ kind: 'knows', name: s.npcs[ok].name, about: npc.name }); }
            }
        }
        for (const about of (Array.isArray(n.learned_about) ? n.learned_about : []).slice(0, 3)) {
            const target = resolveNpc(s, about);
            if (!target || target === npc) continue;
            ensureNpc(target);
            const st = Math.max(1, target.stage || 1);
            const tk = keyOf(s, target);
            if ((npc.knows[tk] || 0) < st) { npc.knows[tk] = st; notes.push({ kind: 'knows', name: npc.name, about: target.name }); }
        }
        const moment = String(n.moment_ru || '').trim();
        if (moment) {
            npc.diary.push({ time: s.time, ru: moment.slice(0, 120), en: String(n.moment_en || '').slice(0, 160) });
            if (npc.diary.length > 40) npc.diary.shift();
            notes.push({ kind: 'moment', name: npc.name, text: moment.slice(0, 80) });
        }
        for (const raw of (Array.isArray(n.positions_ru) ? n.positions_ru : []).slice(0, 3)) {
            const t = String(raw || '').trim().slice(0, 30);
            if (t && !npc.positions.some(x => x.toLowerCase() === t.toLowerCase())) { npc.positions.push(t); if (npc.positions.length > 12) npc.positions.shift(); }
        }
        if (acts.some(a => ACTS.find(x => x.id === a).stage >= 5) && where && !npc.places.some(x => x.toLowerCase() === where.toLowerCase())) {
            npc.places.push(where); if (npc.places.length > 10) npc.places.shift();
        }
        if (!acts.length && npc.stage < 1 && npc.attraction >= 10) npc.stage = 1;
        let dll = dl;
        const passion = s.skills.passion ?? 1;
        if (dll > 0 && passion !== 1) dll = Math.round(dll * (1 + 0.1 * (passion - 1)));
        if (acts.length && dll <= 0) dll = 15;
        npc.lust = clamp(npc.lust + dll, 0, 100);
        const orgasms = clamp(Math.round(Number(n.her_orgasm) || 0), 0, 3);
        if (orgasms) {
            npc.orgasms += orgasms;
            npc.lust = clamp(npc.lust - 35 * orgasms, 5, 100); // release
            dop += hasPerk(s, 'tireless') ? 2 : 1;
            if (hasPerk(s, 'tireless')) npc.affection = clamp(npc.affection + 1, 0, 100);
            notes.push({ kind: 'orgasm', name: npc.name, n: orgasms });
        }
        // what this character does with someone other than the player (their own life, enemies, rivals)
        for (const w of (Array.isArray(n.with_others) ? n.with_others : []).slice(0, 3)) {
            const who = String(w?.partner || '').trim().slice(0, 40);
            const oacts = [...new Set((Array.isArray(w?.acts) ? w.acts : [w?.acts]).map(normAct).filter(Boolean))];
            if (!who || !oacts.length || sameName(who, userName || '')) continue;
            const o = npc.other;
            if (!o.sess || s.turn - o.sess.turn > 6 || (o.sess.scene !== s.scene && s.turn - o.sess.turn > 1)) o.sess = { scene: s.scene, turn: s.turn, by: {} };
            o.sess.turn = s.turn;
            const pk = nameTokens(who).join(' ') || who.toLowerCase();
            const done = o.sess.by[pk] ??= [];
            for (const act of oacts) if (!done.includes(act)) { done.push(act); o.counts[act] = (o.counts[act] || 0) + 1; }
            if (!o.partners.some(x => sameName(x, who))) { o.partners.push(who); if (o.partners.length > 20) o.partners.shift(); }
            o.last = { act: oacts.at(-1), time: s.time, who };
            notes.push({ kind: 'other', name: npc.name, who });
        }
        const mine = clamp(Math.round(Number(n.user_orgasm) || 0), 0, 3);
        if (mine) npc.userOrgasms += mine;
        if (dop) npc.openness = clamp(npc.openness + dop, 0, 100);
        if (dll >= 10 || dll <= -10) notes.push({ kind: 'lust', name: npc.name, delta: dll });
        const addTo = (list, items, max, kind) => {
            for (const raw of Array.isArray(items) ? items : []) {
                const t = String(raw || '').trim().slice(0, 40);
                if (!t || list.some(x => x.toLowerCase() === t.toLowerCase())) continue;
                list.push(t);
                if (list.length > max) list.shift();
                notes.push({ kind, name: npc.name, text: t });
            }
        };
        addTo(npc.likes, n.likes_ru, 10, 'like');
        addTo(npc.spots, n.weak_spots_ru, 6, 'spot');
        addTo(npc.limits, n.limits_ru, 6, 'limit');
    }
    // Arousal cools down when nothing keeps it up.
    for (const [key, npc] of Object.entries(s.npcs)) {
        ensureNpc(npc);
        if (touched.has(key)) continue;
        npc.lust = clamp(npc.lust - (npc.seen === s.turn ? 6 : 20), 0, 100);
    }
    for (const npc of Object.values(s.npcs)) if (npc.seen !== s.turn) npc.present = false;

    // body & mind outside of checks (rest, healing, an unanswered blow)
    const dh = clamp(Math.round(Number(report.harm) || 0), -1, 1);
    if (dh > 0) applyHarm(s, 1, events, notes);
    else if (dh < 0 && s.harm > 0) { notes.push({ kind: 'harm', from: s.harm, to: s.harm - 1 }); s.harm -= 1; }
    const ds = clamp(Math.round(Number(report.stress) || 0), -3, 2);
    if (ds) strain(s, ds, notes);

    // money & items
    // every movement needs a kind and a reason; purchases the shop already charged are skipped
    const countedPrices = (state.pending || []).map(x => /(?:bought|sold) .* for (\d+) /.exec(x)?.[1]).filter(Boolean).map(Number);
    const moneyOps = (Array.isArray(report.money_ops) ? report.money_ops : []).slice(0, 3);
    for (const op of moneyOps) {
        const i = countedPrices.indexOf(Math.abs(Math.round(Number(op?.amount) || 0)));
        if (i >= 0 && ['purchase', 'sale'].includes(op?.kind)) { countedPrices.splice(i, 1); continue; }
        if (op?.kind === 'reward') continue; // settled below, once we know whether a quest paid out
        moneyOp(s, op, notes);
    }
    for (const it of (report.items_gained || []).slice(0, 4)) addItem(s, it, notes);
    for (const it of (report.items_lost || []).slice(0, 4)) useItem(s, typeof it === 'string' ? it : it?.name_ru || it?.name || '', 99, notes);
    for (const it of (report.items_used || []).slice(0, 4)) useItem(s, typeof it === 'string' ? it : it?.name_ru || it?.name || '', Math.max(1, Math.round(Number(it?.qty) || 1)), notes);

    // goals
    let questPaid = false;
    for (const g of (report.goals || []).slice(0, 4)) {
        const title = String(g?.title_ru || '').trim().slice(0, 70);
        if (!title) continue;
        const key = title.toLowerCase();
        let goal = s.goals.find(x => x.title.toLowerCase() === key || similar(x.title, title));
        if (!goal && g.status === 'new' && s.goals.filter(x => x.status === 'active').length < MAX_GOALS) {
            goal = { id: uid(), title, status: 'active', since: s.turn };
            const offer = (s.offers || []).find(o => o.status === 'offered' && (o.title.toLowerCase() === key || similar(o.title, title)));
            if (offer) { offer.status = 'taken'; goal.offer = offer.id; goal.title = offer.title; }
            s.goals.push(goal);
            notes.push({ kind: 'goal_new', title: goal.title, quest: Boolean(offer) });
        } else if (goal && goal.status === 'active' && (g.status === 'done' || g.status === 'failed')) {
            goal.status = g.status;
            goal.closed = s.turn;
            if (g.status === 'done') {
                notes.push({ kind: 'goal_done', title: goal.title });
                const offer = goal.offer && (s.offers || []).find(o => o.id === goal.offer);
                if (offer) {
                    offer.status = 'done';
                    if (offer.reward_money) { moneyOp(s, { amount: offer.reward_money, kind: 'reward', who: offer.giver, why_ru: offer.title }, notes); questPaid = true; }
                    xp(offer.reward_xp + learner, 'задание');
                } else xp(4 + learner);
            }
            else { notes.push({ kind: 'goal_failed', title: goal.title }); const offer = goal.offer && (s.offers || []).find(o => o.id === goal.offer); if (offer) offer.status = 'failed'; }
        }
    }
    s.goals = [...s.goals.filter(g => g.status === 'active'), ...s.goals.filter(g => g.status !== 'active').slice(-8)];
    // a reward the story hands out counts, unless a quest of the game has just paid its own
    if (!questPaid) for (const op of moneyOps) if (op?.kind === 'reward') moneyOp(s, op, notes);

    // progress clocks moved by the story
    for (const c of (report.clocks || []).slice(0, 3)) {
        const name = String(c?.name || '').trim();
        const tick = clamp(Math.round(Number(c?.tick) || 0), 0, 2);
        if (!name || !tick) continue;
        const clock = upsertClock(s, name, c.kind === 'threat' ? 'threat' : 'progress', Number(c.size) || 6);
        const before = clock.filled;
        clock.filled = clamp(clock.filled + tick, 0, clock.size);
        notes.push({ kind: 'clock', name: clock.name, from: before, to: clock.filled, size: clock.size });
        if (clock.filled >= clock.size && before < clock.size) { events.push({ kind: 'clock_full', clock: clone(clock) }); if (clock.kind === 'progress') xp(3); }
    }

    levelUp(s, notes);
    return { state: s, notes, events };
}

function similar(a, b) {
    const wa = new Set(String(a).toLowerCase().split(/\s+/).filter(w => w.length > 3));
    const wb = String(b).toLowerCase().split(/\s+/).filter(w => w.length > 3);
    if (!wa.size || !wb.length) return false;
    const common = wb.filter(w => wa.has(w)).length;
    return common / Math.max(wa.size, wb.length) >= 0.6;
}

// ------------------------------------------------------------------ narrator injection

/** The block the narrator sees at depth 0. Compact on purpose. */
const band = (v, steps) => { let out = steps[0][1]; for (const [min, txt] of steps) if (v >= min) out = txt; return out; };

/** Options readiness() needs from the game state. */
export const readyOpts = (state) => ({ pace: state.pace || 'medium', scene: state.scene || 0, passion: (state.skills?.passion ?? 1) + (hasPerk(state, 'seducer') ? 3 : 0) });

/** The intimacy line: how far they've gone, how far they'll go now, what holds them back. */
export function intimacyLine(n0, state, userName = '{{user}}') {
    const n = ensureNpc(JSON.parse(JSON.stringify(n0)));
    const r = readiness(n, readyOpts(state));
    if (r.ready === 0 && r.reached === 0 && n.attraction < 10) return '';
    const sub = (t) => t.replaceAll('{{user}}', userName);
    const parts = [`intimacy so far: ${r.reached ? STAGES[r.reached].en : 'nothing'}`];
    if (r.next == null) {
        parts.push('ready for anything with ' + userName);
    } else {
        parts.push(`ready right now for up to: ${STAGES[r.ready].en}`);
        const why = r.sceneLimited
            ? 'it is too soon, too fast for one evening; they want to savour this step first'
            : r.missing.map(m => sub(REQ_EN[m.key])).join(', ') || 'more time';
        parts.push(`NOT YET: ${STAGES[r.next].en}. If ${userName} goes further than this, ${n.name} slows ${userName} down in their own way (teasing, flustered, playful "not so fast", a promise of later, or firm), keeps what is allowed going warmly, and does not cross the line this reply. What would change it: ${why}`);
    }
    return parts.join('; ');
}

/** What the narrator needs to know about one character's feelings and body. */
export function npcLine(n0, userName = '{{user}}', state = null) {
    const n = ensureNpc(JSON.parse(JSON.stringify(n0)));
    const parts = [`${n.name}: ${tierOf(n.trust).en}`];
    parts.push(band(n.affection, [[0, 'no attachment yet'], [25, 'fond of ' + userName], [50, 'attached, cares, gets jealous'], [75, 'in love with ' + userName + ', shows it in small ways']]));
    parts.push(band(n.attraction, [[0, 'not attracted'], [20, 'noticing ' + userName], [40, 'attracted'], [65, 'wants ' + userName + ' badly'], [85, 'can barely keep their hands off ' + userName]]));
    if (n.lust >= 20) parts.push(band(n.lust, [[20, 'warm, a little flushed'], [45, 'aroused: flushed, distracted, looks for touch'], [70, 'very aroused: breathless, initiates, hard to refuse'], [90, 'desperate with need: it shows in body and voice']]));
    parts.push(band(n.openness, [[0, 'shy and inexperienced with ' + userName + ': hesitant about new things, needs warming up, embarrassed'], [35, 'getting comfortable: will try things they trust'], [60, 'uninhibited: bold, suggests and asks for what they want'], [85, 'shameless: eager to explore anything']]));
    if (n.experience === 'virgin') parts.push('a virgin');
    const done = ACTS.filter(x => n.counts[x.id]).map(x => `${x.id} ×${n.counts[x.id]}`);
    if (done.length) parts.push(`done with ${userName}: ${done.join(', ')}${n.orgasms ? `; ${n.orgasms} orgasms so far` : ''}`);
    if (state) {
        const il = intimacyLine(n, state, userName); if (il) parts.push(il);
        const r = readiness(n, readyOpts(state));
        if (n.lust >= 60 && r.ready >= 5) parts.push(`may make the first move herself when it fits: propose it outright, or — if it is in her nature (dominant, predatory, a succubus, starved or desperate with need) — simply take ${userName} without asking, within her ladder`);
    }
    if (n.likes.length) parts.push(`known turn-ons: ${n.likes.join(', ')}`);
    if (n.spots.length) parts.push(`weak spots (strong reaction when touched): ${n.spots.join(', ')}`);
    if (n.limits.length) parts.push(`limits they have set: ${n.limits.join(', ')}`);
    if (state) {
        const act = activityAt(n, state.time);
        if (act) parts.push(`by their routine they should be ${act.doing_en || act.doing_ru}${act.where_ru ? ` (${act.where_ru})` : ''} now${act.busy ? ' — busy, with obligations' : ''}`);
        const known = Object.entries(n.knows || {}).filter(([k, st]) => st >= 2 && state.npcs?.[k]).map(([k, st]) => `${state.npcs[k].name} (${STAGES[st].en})`);
        if (known.length && (n.attraction >= 30 || n.affection >= 30 || n.stage >= 2)) parts.push(`KNOWS ${userName} has been intimate with ${known.join(', ')}: reacts in character — jealous, hurt, possessive, competitive, curious or fine with it, depending on who they are and what they feel for ${userName}`);
        const recent = (n.diary || []).slice(-3).map(d => d.en || d.ru);
        if (recent.length) parts.push(`shared history: ${recent.join(' / ')}`);
    }
    return `${parts.join('; ')}; #${n.color}`;
}

export function erogeDirection(u = '{{user}}') {
    return P.render('eroge_direction', { user: u });
}
/** The note every helper prompt gets when eroge mode is on. */
export const erogeHelperNote = () => P.render('eroge_helper');

export function narratorBlock(state0, { record = null, events = [], userName = '{{user}}' } = {}) {
    const state = ensureState(clone(state0));
    const lines = [P.render('narrator_head', { user: userName })];
    const threats = state.clocks.filter(c => c.kind === 'threat' && c.filled < c.size).map(c => `${c.name} ${c.filled}/${c.size}`);
    const progress = state.clocks.filter(c => c.kind === 'progress' && c.filled < c.size).map(c => `${c.name} ${c.filled}/${c.size}`);
    const goals = state.goals.filter(g => g.status === 'active').map(g => g.title).slice(0, 3);
    const harm = state.harm ? `${HARM[state.harm].ru === 'Ушибы' ? 'bruised' : state.harm === 2 ? 'wounded' : 'badly wounded'}` : 'unhurt';
    const parts = [`${timeEn(state.time)}${state.era ? ` (${state.era})` : ''}`];
    if (state.location) parts.push(state.location);
    parts.push(`${userName}: ${harm}${state.spent ? ', completely spent: slower, clumsier, short of breath and patience (show it)' : state.stress >= STRESS_MAX - 1 ? ', running on the last of his strength' : ''}`);
    if (threats.length) parts.push(`Looming: ${threats.join(', ')}`);
    if (progress.length) parts.push(`Progress: ${progress.join(', ')}`);
    lines.push(`STATE: ${parts.join(' · ')}`);
    if (goals.length) lines.push(`${userName}'s goals: ${goals.join('; ')}`);
    const inv = itemsLine(state);
    lines.push(`${userName} carries: ${inv || 'nothing of note'}${hasCondoms(state) ? '' : ' (no condoms)'}`);
    const moneyRule = P.render('narrator_money', { user: userName, money: state.money, currency: state.currency, scale: state.econ ? ` (a simple meal costs about ${state.econ.meal}, a day of ordinary work pays about ${state.econ.day})` : '' }).trim();
    if (moneyRule) lines.push(moneyRule);
    if (state.pending?.length) lines.push(`Since the last reply: ${state.pending.join('; ')}.`);
    const hook = (state.offers || []).find(o => o.status === 'offered' && o.hooks <= 3);
    if (hook) lines.push(`SIDE QUEST HOOK (weave it in naturally within the next reply or two, through ${hook.giver || 'someone or something in the scene'}; ${userName} decides whether to take it): ${hook.hook_en}`);
    const traits = traitsBlock(state, userName);
    if (traits) lines.push(traits);
    if (state.eroge) lines.push(erogeDirection(userName));
    const present = Object.values(state.npcs).filter(n => n.present);
    if (present.length) {
        lines.push(`Characters present (how they feel about ${userName} right now; let it drive their behaviour; dialogue colour):`);
        for (const n of present.slice(0, 4)) lines.push(`- ${npcLine(n, userName, state)}`);
    }
    if (record) {
        const o = OUTCOMES[record.outcome];
        const consequence = {
            crit: record.success_en ? `${record.success_en} — and more than hoped: add an extra advantage.` : 'It works better than hoped: add an extra advantage.',
            success: record.success_en || 'It works.',
            near: `It works, but at a cost: ${record.cost_en || 'a complication arises'}. Show the cost clearly.`,
            fail: `It fails: ${record.fail_en || 'the situation turns against them'}. Fail forward — the story moves, not stalls.`,
            disaster: `It goes badly wrong: ${record.fail_en || 'the worst plausible consequence'} — make it hurt and raise the stakes.`,
        }[record.outcome];
        lines.push(`OUTCOME of ${userName}'s attempt to ${record.action_en || 'act'} (${record.position}): ${o.en} — ${consequence.charAt(0).toUpperCase()}${consequence.slice(1)}${/[.!?]$/.test(consequence) ? '' : '.'}`);
        if (record.intimacy_push) lines.push(['crit', 'success', 'near'].includes(record.outcome)
            ? `${record.target} gives in to ${userName}'s push this time: they let it go one step further than they meant to.`
            : `${record.target} does not give in: they stop ${userName} and cool off a little (in character, not cruel).`);
        const harmNote = record.notes.find(n => n.kind === 'harm');
        if (harmNote) lines.push(`${userName} is hurt by this (${HARM[harmNote.to].ru === 'Тяжело ранен' ? 'seriously' : 'noticeably'}).`);
    }
    for (const ev of events) {
        if (ev.kind === 'clock_full' && ev.clock.kind === 'threat') lines.push(`THREAT ARRIVES NOW: "${ev.clock.name}" comes to pass in this reply.`);
        if (ev.kind === 'clock_full' && ev.clock.kind === 'progress') lines.push(`MILESTONE REACHED: "${ev.clock.name}" is achieved — let it land.`);
        if (ev.kind === 'breakdown') lines.push(`${userName}'s nerves snap — show a brief loss of composure (do not dictate their words).`);
    }
    const cond = conditionsLine(state, userName);
    if (cond) lines.push(`${cond} Show each condition in how they move, speak and look.`);
    const extra = P.render('narrator_extra', { user: userName }).trim();
    if (extra) lines.push(extra);
    return lines.join('\n');
}

// ------------------------------------------------------------------ referee / extractor prompts

/** "CONDITIONS: Igor is POISONED…; Mara is BOUND…" for every prompt that must respect them. */
export function conditionsLine(state, userName = '{{user}}') {
    const parts = [ST.describe(userName, state), ...Object.values(state.npcs || {}).filter(n => n.present !== false || ST.listOf(n).length).map(n => ST.describe(n.name, n))].filter(Boolean);
    return parts.length ? `CONDITIONS (binding): ${parts.join('; ')}. Nobody does what their condition forbids until it ends or they are cured or freed.` : '';
}

export function stateSummary(state0) {
    const state = ensureState(clone(state0));
    const skills = Object.entries(state.skills).map(([k, v]) => `${k} ${v}`).join(', ');
    const clocks = state.clocks.map(c => `${c.name} (${c.kind}) ${c.filled}/${c.size}`).join('; ') || 'none';
    const goals = state.goals.filter(g => g.status === 'active').map(g => g.title).join('; ') || 'none';
    const ro = readyOpts(state);
    const npcs = Object.values(state.npcs).slice(-8).map(n => {
        const r = readiness(n, ro);
        return `${n.name} (${tierOf(n.trust).en}, trust ${n.trust}, affection ${n.affection}, attraction ${n.attraction}, arousal ${n.lust}, openness ${n.openness}, intimacy reached: ${STAGE_IDS[r.reached]}, willing now up to: ${STAGE_IDS[r.ready]}${n.experience ? `, ${n.experience}` : ''})`;
    }).join('; ') || 'none';
    return `Time: ${timeEn(state.time)}${state.era ? ` (${state.era})` : ''}. Location: ${state.location || '?'}. Level ${state.level}. Harm ${state.harm}/3, energy ${energyOf(state)}/${STRESS_MAX}${state.spent ? ' (spent)' : ''}.${conditionsLine(state, '{{user}}') ? ` ${conditionsLine(state, '{{user}}')}` : ''} Skills (0-6): ${skills}. Money: ${state.money} ${state.currency} (price scale: ${scaleLine(state)}). Items: ${itemsLine(state) || 'none'}.\nClocks: ${clocks}\nGoals: ${goals}${(state.offers || []).some(o => o.status === 'offered') ? `\nOffered side quests (not taken yet): ${state.offers.filter(o => o.status === 'offered').map(o => o.title).join('; ')}` : ''}\nNPCs: ${npcs}`;
}

export function refereePrompt({ state, lastNarration, action, user, char }) {
    return P.render('referee', {
        user, char, state: stateSummary(state),
        narration: String(lastNarration || '').slice(-1800), action: String(action || '').slice(0, 1200),
        eroge: state.eroge ? erogeHelperNote() + '\n' : '', format: P.render('referee_format', { user }),
    });
}

export function extractorPrompt({ state, userText, reply, user, char, memoryState = '' }) {
    return P.render('extractor', {
        user, char, state: stateSummary(state),
        memory: memoryState ? `\nStory state card:\n${memoryState.slice(0, 2000)}\n` : '',
        player: String(userText || '').slice(0, 1200), reply: String(reply || '').slice(0, 3500),
        eroge: state.eroge ? erogeHelperNote() + '\n' : '', format: P.render('extractor_format', { user }),
        currency: state.currency, scale: scaleLine(state),
        counted: [...(state.pending || []), 'rewards of side quests listed in the game state (the game pays them itself when the goal is done)'].join('; '),
    });
}

export function parseJsonLine(text) {
    if (!text) return null;
    const m = String(text).match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch {
        try { return JSON.parse(m[0].replace(/,\s*([}\]])/g, '$1')); } catch { return null; }
    }
}

export { ST as status };
