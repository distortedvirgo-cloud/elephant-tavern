/*
 * Elephant Game — the rules engine. Pure functions, no DOM, no LLM.
 *
 * The engine owns the numbers: skills, harm, stress, clocks, relationships,
 * money, time. The LLM only classifies (referee) and reports what happened
 * (extractor); the engine validates, clamps and applies. The narrator receives
 * the result as ground truth.
 */
import { MOOD_IDS } from '../stage/scene.js';

export const SKILLS = {
    might:   { ru: 'Сила',     icon: '💪', en: 'Might' },
    finesse: { ru: 'Ловкость', icon: '🗝️', en: 'Finesse' },
    insight: { ru: 'Чутьё',    icon: '👁️', en: 'Insight' },
    charm:   { ru: 'Обаяние',  icon: '🎭', en: 'Charm' },
    resolve: { ru: 'Воля',     icon: '🔥', en: 'Resolve' },
    lore:    { ru: 'Знание',   icon: '📜', en: 'Lore' },
};

/*
 * Living traits: skills shape every reply, not only dice. Level 1 is ordinary and stays silent;
 * the narrator gets a line for every skill that stands out (0, 2, 3, 4).
 * `hint` is what the setup screen tells the player.
 */
export const TRAITS = {
    might: {
        hint: 'сила тела: драки, тяжёлое, выносливость; мир видит, насколько ты крепкий',
        0: 'physically weak and out of shape: heavy things, fights and long exertion go badly, and others see it',
        2: 'strong: doors give, loads are easy, people think twice before shoving {{user}}',
        3: 'powerfully built: an imposing body that others notice, size up and react to, wary or impressed',
        4: 'exceptionally strong, almost frighteningly so: feats of strength come easily and people react with awe or fear',
    },
    finesse: {
        hint: 'ловкость рук и тела: тихо, быстро, точно; руки, которые знают, что делают',
        0: 'clumsy: things get dropped, noise gets made, quiet and delicate tasks go wrong',
        2: 'quick and light on their feet: quiet, precise hands, easy balance',
        3: 'nimble and deft: moves silently, hands are sure and skilled, in a fight or in bed',
        4: 'uncannily graceful and precise: others notice how effortlessly {{user}} moves',
    },
    insight: {
        hint: 'чутьё: замечать ложь, маски, скрытые чувства — рассказ покажет тебе подсказки',
        0: 'misses subtle tells: lies, hidden motives and disguises that are not obvious slip past {{user}}, so the prose does not point them out',
        2: 'sharp-eyed: when someone lies, hides something or wears a disguise, the prose lets {{user}} catch one small tell',
        3: 'reads people: hidden intent, lies, disguises and unspoken feelings show through to {{user}} as clear tells in the prose',
        4: 'sees through almost anything: no mask, lie or hidden mood stays hidden from {{user}} for long',
    },
    charm: {
        hint: 'обаяние: как к тебе тянутся, насколько легко флиртовать, уговаривать и нравиться',
        0: 'awkward company: people warm to {{user}} slowly, flirting and persuasion tend to land wrong',
        2: 'likeable: people open up a little faster and enjoy {{user}}\'s company',
        3: 'magnetic: characters find {{user}} attractive and easy to like; flirting lands, warmth comes quickly (within each character\'s nature)',
        4: 'irresistible presence: even guarded or hostile characters feel the pull of {{user}}\'s charm, whether they like it or not',
    },
    resolve: {
        hint: 'воля: страх, боль, соблазн, внушение и магия разума берут тебя меньше',
        0: 'easily rattled: fear, pain, temptation and manipulation hit {{user}} hard and show',
        2: 'steady nerves: pressure and fear get less grip on {{user}}',
        3: 'iron will: intimidation, seduction used as a weapon and mind-affecting magic get little grip; characters notice that {{user}} does not bend easily',
        4: 'unshakable: almost nothing can force {{user}}\'s mind or nerve',
    },
    lore: {
        hint: 'знание: узнавать существ, магию, историю, лечить; рассказ подскажет, что ты знаешь',
        0: 'knows little of this world: strange creatures, magic and customs stay strange to {{user}}',
        2: 'well-read: the prose can let {{user}} recognize common creatures, magic and customs',
        3: 'deeply learned: the prose can let {{user}} recognize rare creatures, spells, history and weaknesses',
        4: 'a true scholar: {{user}} understands nearly anything uncanny that appears',
    },
};

/** Narrator line about the player's standout traits ('' when everything is ordinary). */
export function traitsBlock(state, userName = '{{user}}') {
    const items = Object.keys(SKILLS).map((k) => {
        const lvl = clamp(Number(state.skills?.[k] ?? 1), 0, 4);
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

export const NPC_COLORS = ['7ec8e3', 'e3b77e', 'c3a6ff', '8fe3a8', 'ff9fb2', 'e3e07e', '7ee3d4', 'ffb38a', 'a6c8ff', 'd9a6ff', 'b4e37e', 'ff8f8f'];

export const STRESS_MAX = 9;
export const XP_PER_LEVEL = 8;
export const MAX_GOALS = 6;
export const MAX_CLOCKS = 6;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const uid = () => Math.random().toString(36).slice(2, 9);
export const clone = (o) => JSON.parse(JSON.stringify(o));

// ------------------------------------------------------------------ state

export function newState(setup = {}) {
    const skills = {};
    for (const k of Object.keys(SKILLS)) skills[k] = clamp(Number(setup.skills?.[k] ?? 1), 0, 3);
    return {
        v: 1,
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
        time: setup.time || '2026-03-12T19:00',
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
    return (state.skills[skill] ?? 0) + HARM[clamp(state.harm, 0, 3)].penalty;
}

export function effectiveDc(state, dc) {
    return clamp(Math.round(Number(dc) || 8), 4, 14) + DIFFICULTY[state.difficulty].dc;
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

/** Exact odds over the 36 outcomes of 2d6. */
export function odds(mod, dc, position) {
    const r = { crit: 0, success: 0, near: 0, fail: 0, disaster: 0 };
    for (let a = 1; a <= 6; a++) for (let b = 1; b <= 6; b++) r[classify(a, b, mod, dc, position)]++;
    for (const k in r) r[k] /= 36;
    r.atLeastSuccess = r.crit + r.success;
    r.atLeastNear = r.atLeastSuccess + r.near;
    return r;
}

export function rollDice(rng = Math.random) {
    return [1 + Math.floor(rng() * 6), 1 + Math.floor(rng() * 6)];
}

/**
 * Resolves a referee verdict into an outcome and the state after it.
 * check: { skill, action_en, label_ru, position, effect, dc, success_en, cost_en, fail_en, threat, threat_size }
 * opts: { push: bool, dice: [d1,d2] }
 */
export function resolveCheck(state, check, opts = {}) {
    const s = clone(state);
    const skill = SKILLS[check.skill] ? check.skill : 'insight';
    const position = POSITIONS[check.position] ? check.position : 'risky';
    const effect = EFFECTS[check.effect] ? check.effect : 'standard';
    const dc = effectiveDc(s, check.dc);
    let mod = modifier(s, skill);
    const notes = [];
    if (opts.push) {
        if (s.stress < STRESS_MAX) {
            s.stress += 1;
            mod += 1;
            notes.push({ kind: 'stress', delta: 1, why: 'Надавить' });
        }
    }
    const dice = opts.dice || rollDice(opts.rng);
    const outcome = classify(dice[0], dice[1], mod, dc, position);
    const events = [];

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
    switch (outcome) {
        case 'crit':
            events.push({ kind: 'crit' });
            break;
        case 'success':
            break;
        case 'near':
            if (threat) tickThreat(1);
            else { s.stress = clamp(s.stress + 1, 0, STRESS_MAX); notes.push({ kind: 'stress', delta: 1, why: 'цена' }); }
            break;
        case 'fail':
            tickThreat(pos.tick);
            if (pos.harm && !threat) applyHarm(s, 1, events, notes);
            if (position !== 'controlled') { s.stress = clamp(s.stress + 1, 0, STRESS_MAX); notes.push({ kind: 'stress', delta: 1, why: 'провал' }); }
            s.xp += 1;
            notes.push({ kind: 'xp', delta: 1 });
            break;
        case 'disaster':
            tickThreat(pos.tick + 1);
            applyHarm(s, position === 'desperate' ? 2 : 1, events, notes);
            s.xp += 2;
            notes.push({ kind: 'xp', delta: 2 });
            break;
        default:
    }
    levelUp(s, notes);
    if (s.stress >= STRESS_MAX) {
        events.push({ kind: 'breakdown' });
        s.stress = 4;
    }

    const record = {
        id: uid(),
        turn: s.turn,
        skill, position, effect, dc,
        mod, dice, total: dice[0] + dice[1] + mod,
        outcome,
        push: Boolean(opts.push),
        label_ru: String(check.label_ru || check.action_en || '').slice(0, 80),
        action_en: String(check.action_en || '').slice(0, 120),
        success_en: String(check.success_en || '').slice(0, 160),
        cost_en: String(check.cost_en || '').slice(0, 160),
        fail_en: String(check.fail_en || '').slice(0, 160),
        notes,
        events,
    };
    s.log = [record, ...s.log].slice(0, 30);
    return { state: s, record };
}

function applyHarm(s, n, events, notes) {
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
    while (s.xp >= XP_PER_LEVEL) {
        s.xp -= XP_PER_LEVEL;
        s.level += 1;
        s.unspent += 1;
        notes.push({ kind: 'level', level: s.level });
    }
}

export function spendPoint(state, skill) {
    const s = clone(state);
    if (s.unspent <= 0 || !SKILLS[skill] || s.skills[skill] >= 4) return state;
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
export function applyReport(state, report, { trackerLine = null } = {}) {
    const s = clone(state);
    const notes = [];
    const events = [];
    s.turn += 1;
    sweepClocks(s);

    if (trackerLine?.time) s.time = trackerLine.time;
    else s.time = advanceTime(s.time, report?.minutes ?? 5);
    if (trackerLine?.location) s.location = trackerLine.location;
    else if (report?.location_ru) s.location = String(report.location_ru).slice(0, 40);
    if (trackerLine?.weather) s.weather = trackerLine.weather;
    else if (report?.weather) s.weather = report.weather;

    if (!report) return { state: s, notes, events };

    // relationships
    for (const n of Array.isArray(report.npcs) ? report.npcs.slice(0, 6) : []) {
        const name = String(n?.name || '').trim();
        if (!name || name.length > 40) continue;
        const key = name.toLowerCase();
        let npc = s.npcs[key];
        if (!npc) {
            const used = new Set(Object.values(s.npcs).map(x => x.color));
            npc = s.npcs[key] = {
                name,
                trust: clamp(Number(n.start_trust ?? 0) || 0, -30, 30),
                attraction: 0,
                color: NPC_COLORS.find(c => !used.has(c)) || NPC_COLORS[Object.keys(s.npcs).length % NPC_COLORS.length],
                met: s.turn,
            };
            notes.push({ kind: 'npc_new', name });
        }
        npc.present = n.present !== false;
        npc.seen = s.turn;
        const dt = clamp(Math.round(Number(n.trust) || 0), -6, 6);
        const da = clamp(Math.round(Number(n.attraction) || 0), -5, 5);
        if (dt || da) {
            const beforeTier = tierOf(npc.trust).id;
            npc.trust = clamp(npc.trust + dt, -100, 100);
            npc.attraction = clamp(npc.attraction + da, 0, 100);
            notes.push({ kind: 'rel', name: npc.name, trust: dt, attraction: da, why: String(n.why_ru || '').slice(0, 60) });
            const afterTier = tierOf(npc.trust).id;
            if (afterTier !== beforeTier) notes.push({ kind: 'tier', name: npc.name, from: beforeTier, to: afterTier });
        }
    }
    for (const npc of Object.values(s.npcs)) if (npc.seen !== s.turn) npc.present = false;

    // body & mind outside of checks (rest, healing, an unanswered blow)
    const dh = clamp(Math.round(Number(report.harm) || 0), -1, 1);
    if (dh > 0) applyHarm(s, 1, events, notes);
    else if (dh < 0 && s.harm > 0) { notes.push({ kind: 'harm', from: s.harm, to: s.harm - 1 }); s.harm -= 1; }
    const ds = clamp(Math.round(Number(report.stress) || 0), -3, 2);
    if (ds) { s.stress = clamp(s.stress + ds, 0, STRESS_MAX); notes.push({ kind: 'stress', delta: ds }); }

    // money & items
    const dm = clamp(Math.round(Number(report.money) || 0), -100000, 100000);
    if (dm) { s.money = Math.max(0, s.money + dm); notes.push({ kind: 'money', delta: dm }); }
    for (const it of (report.items_gained || []).slice(0, 4)) {
        const name = String(it).trim().slice(0, 40);
        if (name && !s.items.some(x => x.toLowerCase() === name.toLowerCase())) { s.items.push(name); notes.push({ kind: 'item', name, delta: 1 }); }
    }
    for (const it of (report.items_lost || []).slice(0, 4)) {
        const i = s.items.findIndex(x => x.toLowerCase() === String(it).trim().toLowerCase());
        if (i >= 0) { notes.push({ kind: 'item', name: s.items[i], delta: -1 }); s.items.splice(i, 1); }
    }

    // goals
    for (const g of (report.goals || []).slice(0, 4)) {
        const title = String(g?.title_ru || '').trim().slice(0, 70);
        if (!title) continue;
        const key = title.toLowerCase();
        let goal = s.goals.find(x => x.title.toLowerCase() === key || similar(x.title, title));
        if (!goal && g.status === 'new' && s.goals.filter(x => x.status === 'active').length < MAX_GOALS) {
            goal = { id: uid(), title, status: 'active', since: s.turn };
            s.goals.push(goal);
            notes.push({ kind: 'goal_new', title });
        } else if (goal && goal.status === 'active' && (g.status === 'done' || g.status === 'failed')) {
            goal.status = g.status;
            goal.closed = s.turn;
            if (g.status === 'done') { s.xp += 2; notes.push({ kind: 'goal_done', title: goal.title }, { kind: 'xp', delta: 2 }); }
            else notes.push({ kind: 'goal_failed', title: goal.title });
        }
    }
    s.goals = [...s.goals.filter(g => g.status === 'active'), ...s.goals.filter(g => g.status !== 'active').slice(-8)];

    // progress clocks moved by the story
    for (const c of (report.clocks || []).slice(0, 3)) {
        const name = String(c?.name || '').trim();
        const tick = clamp(Math.round(Number(c?.tick) || 0), 0, 2);
        if (!name || !tick) continue;
        const clock = upsertClock(s, name, c.kind === 'threat' ? 'threat' : 'progress', Number(c.size) || 6);
        const before = clock.filled;
        clock.filled = clamp(clock.filled + tick, 0, clock.size);
        notes.push({ kind: 'clock', name: clock.name, from: before, to: clock.filled, size: clock.size });
        if (clock.filled >= clock.size && before < clock.size) events.push({ kind: 'clock_full', clock: clone(clock) });
    }

    levelUp(s, notes);
    if (s.stress >= STRESS_MAX) { events.push({ kind: 'breakdown' }); s.stress = 4; }
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
export function narratorBlock(state, { record = null, events = [], userName = '{{user}}' } = {}) {
    const lines = ['[GAME ENGINE — ground truth for this reply. Never mention dice, numbers, clocks, stats or any mechanics in prose; show them only through the fiction.]'];
    const threats = state.clocks.filter(c => c.kind === 'threat' && c.filled < c.size).map(c => `${c.name} ${c.filled}/${c.size}`);
    const progress = state.clocks.filter(c => c.kind === 'progress' && c.filled < c.size).map(c => `${c.name} ${c.filled}/${c.size}`);
    const goals = state.goals.filter(g => g.status === 'active').map(g => g.title).slice(0, 3);
    const harm = state.harm ? `${HARM[state.harm].ru === 'Ушибы' ? 'bruised' : state.harm === 2 ? 'wounded' : 'badly wounded'}` : 'unhurt';
    const parts = [`${timeEn(state.time)}`];
    if (state.location) parts.push(state.location);
    parts.push(`${userName}: ${harm}${state.stress >= 6 ? ', frayed nerves' : ''}`);
    if (threats.length) parts.push(`Looming: ${threats.join(', ')}`);
    if (progress.length) parts.push(`Progress: ${progress.join(', ')}`);
    lines.push(`STATE: ${parts.join(' · ')}`);
    if (goals.length) lines.push(`${userName}'s goals: ${goals.join('; ')}`);
    const traits = traitsBlock(state, userName);
    if (traits) lines.push(traits);
    const present = Object.values(state.npcs).filter(n => n.present);
    if (present.length) {
        lines.push('NPCs present (relationship tier gates closeness; dialogue colour): ' + present.slice(0, 5)
            .map(n => `${n.name} — ${tierOf(n.trust).en}${n.attraction >= 40 ? ', attracted' : ''}, #${n.color}`).join('; '));
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
        const harmNote = record.notes.find(n => n.kind === 'harm');
        if (harmNote) lines.push(`${userName} is hurt by this (${HARM[harmNote.to].ru === 'Тяжело ранен' ? 'seriously' : 'noticeably'}).`);
    }
    for (const ev of events) {
        if (ev.kind === 'clock_full' && ev.clock.kind === 'threat') lines.push(`THREAT ARRIVES NOW: "${ev.clock.name}" comes to pass in this reply.`);
        if (ev.kind === 'clock_full' && ev.clock.kind === 'progress') lines.push(`MILESTONE REACHED: "${ev.clock.name}" is achieved — let it land.`);
        if (ev.kind === 'breakdown') lines.push(`${userName}'s nerves snap — show a brief loss of composure (do not dictate their words).`);
    }
    return lines.join('\n');
}

// ------------------------------------------------------------------ referee / extractor prompts

export function stateSummary(state) {
    const skills = Object.entries(state.skills).map(([k, v]) => `${k} ${v}`).join(', ');
    const clocks = state.clocks.map(c => `${c.name} (${c.kind}) ${c.filled}/${c.size}`).join('; ') || 'none';
    const goals = state.goals.filter(g => g.status === 'active').map(g => g.title).join('; ') || 'none';
    const npcs = Object.values(state.npcs).slice(-8).map(n => `${n.name} (${tierOf(n.trust).en}, trust ${n.trust}, attraction ${n.attraction})`).join('; ') || 'none';
    return `Time: ${timeEn(state.time)}. Location: ${state.location || '?'}. Harm ${state.harm}/3, stress ${state.stress}/9. Skills: ${skills}. Money: ${state.money}. Items: ${state.items.join(', ') || 'none'}.\nClocks: ${clocks}\nGoals: ${goals}\nNPCs: ${npcs}`;
}

export function refereePrompt({ state, lastNarration, action, user, char }) {
    return `You are the referee of a narrative RPG between ${user} (the player) and the world run by ${char}'s narrator. Decide whether ${user}'s latest action needs a skill check.

Skills: might (force, brawling, endurance, intimidation by force), finesse (stealth, agility, lockpicking, sleight of hand, shooting), insight (noticing, reading people, sensing lies, intuition), charm (persuasion, deception, seduction, haggling, performance), resolve (willpower, resisting fear/pain/temptation/magic), lore (knowledge, medicine, magic, tech, investigation).

A check is needed ONLY when the outcome is genuinely uncertain AND both success and failure would be interesting: attacks, sneaking, lying, persuading someone unwilling, dangerous climbing, picking locks; also the social and intimate contests that drive this kind of story: seducing or charming someone reluctant, guarded or hostile (charm); resisting seduction used as a weapon, fear, pain, a supernatural pull, feeding or mind-affecting magic (resolve); seeing through a lie, an act or a disguise when ${user} looks for it or something is at stake (insight); recognizing a creature, spell or weakness (lore); keeping up, holding out or overpowering in a physical contest (might/finesse). NO check for: ordinary talk, questions, looking around, walking, routine tasks, emotional moments, willing intimacy between people who both want it, anything trivial or impossible.

Game state:
${stateSummary(state)}

Last narration:
<narration>
${String(lastNarration || '').slice(-1800)}
</narration>

${user}'s action:
<action>
${String(action || '').slice(0, 1200)}
</action>

Reply with ONE line of minified JSON and nothing else.
If no check: {"check":false}
If a check: {"check":true,"skill":"might|finesse|insight|charm|resolve|lore","action_en":"verb phrase, e.g. pick the lock","label_ru":"короткое название по-русски","position":"controlled|risky|desperate","effect":"limited|standard|great","dc":6-12,"success_en":"what success gives","cost_en":"what a near miss costs","fail_en":"what failure brings","threat":"name of the danger clock this feeds, e.g. Guards alerted (or empty)","threat_size":4|6|8}
dc: 6 easy, 8 standard, 10 hard, 12 very hard. Position: controlled = safe retry possible, risky = default, desperate = serious danger. Reuse existing clock names when they fit.`;
}

export function extractorPrompt({ state, userText, reply, user, char, memoryState = '' }) {
    return `You track the game state of a narrative RPG. Read the latest exchange and report ONLY what actually happened in it.

Current game state:
${stateSummary(state)}
${memoryState ? `\nStory state card:\n${memoryState.slice(0, 2000)}\n` : ''}
${user}:
<player>
${String(userText || '').slice(0, 1200)}
</player>

Narrator (${char}):
<reply>
${String(reply || '').slice(0, 3500)}
</reply>

Reply with ONE line of minified JSON, nothing else:
{"minutes":int (in-story time this exchange took: talk 5-15, local travel 10-45, long tasks hours),"location_ru":"place in 2-4 Russian words","weather":"clear|rain|storm|snow|fog|ash","time_of_day":"day|night|dusk|dawn","indoor":bool,"mood":"${MOOD_IDS.join('|')}","intensity":0-1,"events":["hit"|"blood"|"explosion"|"lightning"|"kiss"|"magic"|"heartbeat"],"scene_changed":bool,
"npcs":[{"name":"","present":bool,"trust":-6..6,"attraction":-5..5,"why_ru":"коротко"}],
"harm":-1|0|1,"stress":-3..2,"money":int,"items_gained":[],"items_lost":[],
"goals":[{"title_ru":"","status":"new|done|failed"}],
"clocks":[{"name":"","kind":"progress|threat","tick":1|2,"size":4|6|8}]}

Rules: trust/attraction deltas are SMALL (most turns 0, ±1-2 for a nice or rude moment, ±4-6 only for big betrayals or sacrifices) and only for named NPCs in the scene. harm only for injuries NOT already resolved by a dice check this turn (or -1 for real rest/treatment). New goals only when ${user} clearly commits to an objective; done/failed only when it clearly resolves. Clocks: tick an existing progress clock when the story clearly advances it; create a threat clock only for a new looming danger. Use empty arrays when nothing applies.`;
}

export function parseJsonLine(text) {
    if (!text) return null;
    const m = String(text).match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch {
        try { return JSON.parse(m[0].replace(/,\s*([}\]])/g, '$1')); } catch { return null; }
    }
}
