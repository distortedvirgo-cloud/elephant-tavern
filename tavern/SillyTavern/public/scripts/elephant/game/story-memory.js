const PLAYER = '@player';
const MASK = '[private detail withheld]';
const clean = (value, length) => typeof value === 'string' ? value.trim().slice(0, length) : '';
const normalize = value => String(value ?? '').toLowerCase().replaceAll('ё', 'е').replace(/\s+/gu, ' ').trim();

function npcKey(state, name) {
    const wanted = normalize(name);
    if (!wanted) return '';
    if (wanted === PLAYER) return PLAYER;
    const matches = Object.entries(state.npcs).filter(([, npc]) =>
        [npc.name, ...(npc.aliases || [])].some(alias => normalize(alias) === wanted));
    return matches.length === 1 ? matches[0][0] : '';
}

const words = value => normalize(value).split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(' ');
const containsName = (state, key, evidence) => key === PLAYER || Boolean(state.npcs[key]
    && [state.npcs[key].name, ...(state.npcs[key].aliases || [])].some(name =>
        ` ${words(evidence)} `.includes(` ${words(name)} `)));
const nameOf = (state, key, player) => key === PLAYER ? player : state.npcs[key]?.name || '';
const additions = (value, max) => Array.isArray(value) ? value.slice(0, max) : [];

function evidenceOf(change, { playerText, reply }) {
    const quote = clean(change?.evidence, 750);
    const q = normalize(quote);
    return q.length >= 8 && [playerText, reply].some(line => normalize(line).includes(q)) ? quote : '';
}

export function recordStoryMemory(state, report, exchange) {
    state.obligations ??= [];
    state.secrets ??= [];
    for (const change of additions(report.obligations, 3)) {
        const evidence = evidenceOf(change, exchange);
        if (!evidence) continue;
        if (change.op === 'record') {
            const from = npcKey(state, change.from);
            const to = npcKey(state, change.to);
            const text = clean(change.text_ru, 200);
            const kind = change.kind;
            if (!from || !to || from === to || !text || !['promise', 'debt'].includes(kind)) continue;
            if (!containsName(state, from, evidence) || !containsName(state, to, evidence)) continue;
            if (state.obligations.some(entry => entry.from === from && entry.to === to
                && entry.status === 'open' && entry.kind === kind && normalize(entry.text) === normalize(text))) continue;
            const id = `obligation-${state.turn}-${state.obligations.length}`;
            state.obligations.push({ id, kind, text, from, to, status: 'open', updated: state.turn });
        } else if (['kept', 'broken', 'released'].includes(change.op)) {
            const entry = state.obligations.find(item => item.id === change.id && item.status === 'open');
            if (entry && containsName(state, entry.from, evidence) && containsName(state, entry.to, evidence)) {
                entry.status = change.op;
                entry.updated = state.turn;
            }
        }
    }
    for (const change of additions(report.secrets, 3)) {
        const evidence = evidenceOf(change, exchange);
        if (!evidence) continue;
        const literal = clean(change.literal, 240);
        if (literal.length < 3 || !normalize(evidence).includes(normalize(literal))) continue;
        if (change.op === 'record') {
            const fact = clean(change.fact_ru, 240);
            const source = npcKey(state, change.from);
            if (!fact || !source || !containsName(state, source, evidence)) continue;
            // Duplicate facts must go through the same disclosure checks as any other update.
            if (state.secrets.some(secret => [secret.fact, ...secret.literals]
                .some(text => [normalize(fact), normalize(literal)].includes(normalize(text))))) continue;
            const knownBy = [source];
            for (const name of additions(change.learners, 6)) {
                const key = npcKey(state, name);
                if (key && containsName(state, key, evidence) && !knownBy.includes(key)) knownBy.push(key);
            }
            const id = `secret-${state.turn}-${state.secrets.length}`;
            state.secrets.push({ id, fact, literals: [literal], knownBy });
            continue;
        }
        const secret = state.secrets.find(entry => entry.id === change.id);
        if (!secret || !['mention', 'learn'].includes(change.op)) continue;
        if (change.op === 'learn') {
            const to = npcKey(state, change.to);
            const from = npcKey(state, change.from);
            if (!to || !containsName(state, to, evidence)) continue;
            if (change.via === 'told') {
                if (!secret.knownBy.includes(from) || !containsName(state, from, evidence)) continue;
            } else if (change.via !== 'witnessed') continue;
            if (!secret.knownBy.includes(to)) secret.knownBy.push(to);
        }
        if (!secret.literals.some(text => normalize(text) === normalize(literal))) secret.literals.push(literal);
    }
}

export function remapStoryMemory(state, previous, current) {
    for (const obligation of state.obligations || []) {
        if (obligation.from === previous) obligation.from = current;
        if (obligation.to === previous) obligation.to = current;
    }
    for (const secret of state.secrets || []) {
        secret.knownBy = [...new Set(secret.knownBy.map(key => key === previous ? current : key))];
    }
}

export function obligationSummary(state, npc, player) {
    return (state.obligations || [])
        .filter(entry => entry.from === npc || entry.to === npc)
        .sort((a, b) => b.updated - a.updated)
        .slice(0, 2)
        .map(entry => `${entry.kind} ${entry.status}: ${nameOf(state, entry.from, player)} to ${nameOf(state, entry.to, player)} — ${entry.text}`);
}

export function storyMemoryForTracker(state, player) {
    return {
        obligations: (state.obligations || []).slice(-16).map(entry =>
            ({ ...entry, from: nameOf(state, entry.from, player), to: nameOf(state, entry.to, player) })),
        secrets: (state.secrets || []).slice(-16).map(({ id, fact, knownBy }) =>
            ({ id, fact, known_by: knownBy.map(key => nameOf(state, key, PLAYER)).filter(Boolean) })),
    };
}

const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function secretRedactor(state) {
    const terms = [...new Set((state?.secrets || []).flatMap(secret => [secret.fact, ...secret.literals]))]
        .filter(Boolean).sort((a, b) => b.length - a.length);
    if (!terms.length) return null;
    const fragments = terms.map(term => term.trim().split(/\s+/u).map(part =>
        escapeRegex(part).replace(/[её]/giu, '[её]')).join('\\s+'));
    const pattern = new RegExp(fragments.join('|'), 'giu');
    return text => typeof text === 'string' ? text.replace(pattern, () => MASK) : text;
}

export function privateKnowledge(state, move) {
    const audience = Object.entries(state.npcs).filter(([, npc]) => npc.present === true);
    if (audience.length !== 1) return '';
    const [key, npc] = audience[0];
    // Require a direct exchange with the only confirmed NPC. A new scene or
    // an ambiguous audience gets no private facts in the shared prompt.
    const text = String(move || '').trim();
    if (!text || /[\n*]/u.test(text)) return '';
    if (Object.keys(state.npcs).some(other => other !== key && containsName(state, other, text))) return '';
    const name = [npc.name, ...(npc.aliases || [])].find(value =>
        new RegExp(`^["«“]?\\s*${escapeRegex(value)},`, 'iu').test(text));
    if (!name) return '';
    const facts = (state.secrets || []).filter(secret => secret.knownBy.includes(key)).slice(-3);
    return facts.length ? `PRIVATE KNOWLEDGE FOR ${npc.name} ONLY. Only this NPC may use these facts in the current exchange. If anyone else enters, keep the facts concealed unless a genuine in-story disclosure takes place. Keep this out of public narration unless the NPC chooses to disclose it to the player.\n${facts.map(secret => secret.fact).join('\n')}` : '';
}

export function redactStoryForSummary(chat) {
    const state = chat.findLast(message => message?.extra?.elephant_game?.state)?.extra.elephant_game.state;
    return secretRedactor(state) ?? (text => text);
}
