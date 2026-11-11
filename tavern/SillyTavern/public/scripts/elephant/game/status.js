/*
 * Elephant Game — conditions (statuses): stunned, bound, poisoned, hypnotised…
 *
 * One catalogue for the hero, for characters in the story and for fighters in an encounter.
 * A condition says what its holder CANNOT do, and the engine and the narrator both obey it:
 * a stunned foe does not strike, a bound one does not walk away, a poisoned hero rolls worse.
 * Pure functions; holders are any object with a `statuses` array of { id, left, by }.
 *
 * `left` counts rounds inside an encounter and story turns outside it (one round = one turn).
 */

/*
 * block: 'act'    — cannot do anything physical (no attack, no defence, no leaving)
 *        'move'   — cannot use arms or go anywhere, but can speak
 *        'attack' — will not attack (charmed, terrified)
 * mod:   penalty to every roll of the hero / to an enemy's blows
 * dot:   damage per round to a fighter's bar; for the hero it drains energy every few turns
 * open:  blows against the holder come easier and land harder
 */
export const STATUSES = {
    stunned:    { noun: 'оглушение', ru: 'оглушён', fem: 'оглушена', icon: '💫', block: 'act', open: true, left: 2, can: 'nothing for a moment: reeling, cannot strike, defend or run', cure: 'проходит само' },
    paralyzed:  { noun: 'паралич', ru: 'парализован', fem: 'парализована', icon: '🧊', block: 'act', open: true, left: 3, can: 'nothing physical: cannot move a limb; can breathe, see and barely speak', cure: 'проходит само, лечится' },
    asleep:     { noun: 'сон', ru: 'спит', fem: 'спит', icon: '💤', block: 'act', open: true, left: 4, wake: true, can: 'nothing: unaware until woken; a blow or a loud noise wakes them', cure: 'удар или шум будит' },
    bound:      { noun: 'путы', ru: 'связан', fem: 'связана', icon: '⛓', block: 'move', open: true, left: 5, can: 'only talk, look and strain against the bonds: cannot use the arms, strike, or go anywhere', cure: 'вырваться или развязать' },
    charmed:    { noun: 'гипноз', ru: 'под гипнозом', fem: 'под гипнозом', icon: '🌀', block: 'attack', left: 4, can: 'act only in a daze: does not attack, follows simple suggestions from whoever holds the charm, cannot plan or leave on their own', cure: 'встряхнуть, развеять, проходит само' },
    frightened: { noun: 'страх', ru: 'напуган', fem: 'напугана', icon: '😱', block: 'attack', left: 3, can: 'back away, cower, plead or bolt if there is a way out: cannot bring themselves to attack', cure: 'проходит само' },
    blinded:    { noun: 'слепота', ru: 'ослеплён', fem: 'ослеплена', icon: '🙈', mod: -2, open: true, left: 2, can: 'act, but blindly: swings wild, cannot aim or follow movement', cure: 'проходит само' },
    weakened:   { noun: 'слабость', ru: 'ослаблен', fem: 'ослаблена', icon: '🥀', mod: -1, left: 5, can: 'act, but slowly and without strength', cure: 'отдых' },
    poisoned:   { noun: 'яд', ru: 'отравлен', fem: 'отравлена', icon: '☠️', mod: -1, dot: 6, left: 12, can: 'act, but sick and getting worse: sweat, cramps, blurred sight', cure: 'лечение или противоядие' },
    bleeding:   { noun: 'кровотечение', ru: 'кровоточит', fem: 'кровоточит', icon: '🩸', dot: 8, left: 8, can: 'act, but losing blood: weaker every minute until the wound is bound', cure: 'перевязать' },
    drunk:      { noun: 'опьянение', ru: 'пьян', fem: 'пьяна', icon: '🍺', mod: -1, left: 10, can: 'act, but clumsy, loud and careless', cure: 'время, сон' },
    aroused:    { noun: 'возбуждение', ru: 'возбуждён', fem: 'возбуждена', icon: '💗', mod: -1, left: 4, can: 'act, but flushed, distracted and short of breath', cure: 'проходит само' },
};
export const STATUS_IDS = Object.keys(STATUSES);
/** Loose words a model may use → catalogue ids. */
const ALIASES = { stun: 'stunned', dazed: 'stunned', knocked: 'stunned', paralysed: 'paralyzed', paralysis: 'paralyzed', frozen: 'paralyzed', sleep: 'asleep', sleeping: 'asleep', unconscious: 'asleep', tied: 'bound', restrained: 'bound', webbed: 'bound', pinned: 'bound', grappled: 'bound', hypnotized: 'charmed', hypnotised: 'charmed', hypnosis: 'charmed', charm: 'charmed', mind_control: 'charmed', fear: 'frightened', scared: 'frightened', terrified: 'frightened', blind: 'blinded', weak: 'weakened', cursed: 'weakened', poison: 'poisoned', venom: 'poisoned', bleed: 'bleeding', intoxicated: 'drunk', lust: 'aroused', aphrodisiac: 'aroused' };
export const statusId = (x) => { const k = String(x || '').trim().toLowerCase().replace(/[\s-]+/g, '_'); return STATUSES[k] ? k : (ALIASES[k] || null); };

export const listOf = (holder) => (Array.isArray(holder?.statuses) ? holder.statuses : []);
export const has = (holder, id) => listOf(holder).some(s => s.id === id);
/** The strongest restriction on the holder: 'act' > 'move' > 'attack' > null. */
export function blockOf(holder) {
    const b = listOf(holder).map(s => STATUSES[s.id]?.block).filter(Boolean);
    return b.includes('act') ? 'act' : b.includes('move') ? 'move' : b.includes('attack') ? 'attack' : null;
}
/** Cannot strike this round (any block stops a blow). */
export const cannotStrike = (holder) => Boolean(blockOf(holder));
/** Cannot leave, surrender-and-walk, or end the scene by their own body. */
export const cannotLeave = (holder) => ['act', 'move'].includes(blockOf(holder)) || has(holder, 'charmed');
export const isOpen = (holder) => listOf(holder).some(s => STATUSES[s.id]?.open);
export const modOf = (holder) => listOf(holder).reduce((a, s) => a + (STATUSES[s.id]?.mod || 0), 0);
export const dotOf = (holder) => listOf(holder).reduce((a, s) => a + (STATUSES[s.id]?.dot || 0), 0);

/** Adds (or refreshes) a condition. Returns the entry, or null for an unknown id. */
export function add(holder, id0, { left = null, by = '' } = {}) {
    const id = statusId(id0);
    if (!id || !holder) return null;
    holder.statuses = listOf(holder);
    const dur = Math.max(1, Math.round(Number(left) || STATUSES[id].left));
    const ex = holder.statuses.find(s => s.id === id);
    if (ex) { ex.left = Math.max(ex.left, dur); if (by) ex.by = by; return ex; }
    const entry = { id, left: dur, by: String(by || '').slice(0, 40) };
    holder.statuses.push(entry);
    if (holder.statuses.length > 4) holder.statuses.shift();
    return entry;
}
export function remove(holder, id0) {
    const id = statusId(id0);
    const before = listOf(holder).length;
    if (holder) holder.statuses = listOf(holder).filter(s => s.id !== id);
    return before !== listOf(holder).length;
}
/** Removes whatever holds the holder in place (breaking free, being rescued). Returns removed ids. */
export function free(holder) {
    const gone = listOf(holder).filter(s => STATUSES[s.id]?.block).map(s => s.id);
    if (gone.length) holder.statuses = listOf(holder).filter(s => !STATUSES[s.id]?.block);
    return gone;
}
/** One round / one story turn passes. Returns the ids that ran out. */
export function tick(holder, n = 1) {
    const ended = [];
    if (!listOf(holder).length) return ended;
    holder.statuses = holder.statuses.filter((s) => { s.left -= n; if (s.left <= 0) { ended.push(s.id); return false; } return true; });
    return ended;
}

const label = (id, fem) => (fem ? STATUSES[id].fem : STATUSES[id].ru);
/** "💫 оглушён (2)" chips for the UI. */
export const chips = (holder, { fem = false } = {}) => listOf(holder).map(s => ({ id: s.id, icon: STATUSES[s.id].icon, ru: label(s.id, fem), left: s.left, cure: STATUSES[s.id].cure }));
/** For prompts: "Mara is bound (5 more turns): can only talk…". */
export function describe(name, holder) {
    return listOf(holder).map(s => `${name} is ${s.id.toUpperCase()}${s.by ? ` (by ${s.by})` : ''}, ${s.left} more ${s.left === 1 ? 'turn' : 'turns'}: can ${STATUSES[s.id].can}`).join('; ');
}
