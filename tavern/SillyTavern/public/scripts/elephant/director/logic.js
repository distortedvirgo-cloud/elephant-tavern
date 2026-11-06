/*
 * Elephant Core — Director: pure logic (prompts, parsing, bookkeeping).
 * No DOM, no SillyTavern imports: the same file is used by the app and by the
 * offline tests.
 *
 * The Director is a hidden helper-model call before each reply. It reads the
 * character, their toolbox (abilities, agenda), the recent scene and what the
 * character did lately, and decides what the character does on their own
 * initiative. The result is injected as a short private "intent" block, so the
 * main model writes prose while the Director does the plotting.
 */

export const MODES = {
    calm: { label: 'Спокойно', every: 4, hint: 'свой ход героя примерно раз в 4 ответа' },
    lively: { label: 'Живо', every: 2, hint: 'свой ход героя через ответ' },
    wild: { label: 'Хаос', every: 1, hint: 'герой тянет сюжет в каждом ответе' },
};

export const DIRECTOR_SYSTEM = `You are the hidden director inside {{char}}'s head in an interactive adult fiction. You never write prose. You decide what {{char}} does of their own accord next, so the story has a driver other than the player.

You receive the character card, their toolbox (abilities and agenda), the recent scene, memory notes, their ongoing scheme and what they did recently.

Decide:
- goal: what {{char}} wants out of this scene right now (one sentence, in their own terms).
- scheme: their ongoing plan across several scenes (1–2 sentences): set up, let it simmer, spring it. Keep the previous scheme if it is alive and advance it; replace it if the player's actions broke it or it has paid off.
- move: the concrete thing {{char}} does in THIS reply on their own initiative (1–2 sentences): an action, a test, a lie, a reveal, a trap, a change of place, a new complication, a signature ability put to use. It must be plausible from what they know and who they are, and it must change the situation by itself (not a question to the player, not an invitation to choose). Never decide the player's actions, words or feelings.
- ace: the ability from the toolbox worth using now (empty string if none fits) and ace_how: how it serves the move, one short sentence. Favor abilities that have not been used lately. A transformation, a trick, a bribe, a summon, a disguise: when it would make a good scene, use it without waiting for the player to ask for it.
- drive: true when the move is a genuine initiative of the character. When the initiative is marked DUE it must be true.

Rules:
- Long game: prefer a move that advances the scheme over a one-off trick; let earlier set-ups pay off.
- Surprise within character: a move the card makes plausible but the player didn't see coming. Not the first idea that comes to mind, and not a repeat of anything under "recent moves".
- Honor canon, continuity and the tone of the scene. Dark, dangerous, cunning and sexual moves are fine when they suit the character; follow the scene's heat, steer it, don't jump it.
- Write all fields in English, concrete and short.

Reply with ONE JSON object and nothing else:
{"goal":"","scheme":"","move":"","ace":"","ace_how":"","drive":true}`;

export const ARSENAL_SYSTEM = `You prepare a character's toolbox for an interactive adult fiction. From the card (and from your knowledge of the franchise, if the character is an existing one) list:
- abilities: 4–8 signature abilities, powers, tricks, resources or social weapons the character can really use. For each: a short name, what it does, and when it makes a good scene (deception, protection, seduction, humor, escape, pressure…). Stay faithful to canon; don't invent powers a canon character doesn't have.
- agenda: 2–3 of the character's own motives or long-term plans that they would pursue without being asked.
Reply with ONE JSON object in English:
{"abilities":["Name: what it does; when it makes a good scene"],"agenda":["..."]}`;

const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** First JSON object in a model reply, or null. */
export function extractJson(raw) {
    const text = String(raw ?? '').replace(/^```(?:json)?/i, '').replace(/```$/m, '');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

export function parsePlan(raw) {
    const o = extractJson(raw);
    if (!o) return null;
    const plan = {
        goal: clip(o.goal, 260),
        scheme: clip(o.scheme, 360),
        move: clip(o.move, 420),
        ace: clip(o.ace, 80),
        ace_how: clip(o.ace_how, 220),
        drive: o.drive !== false,
    };
    return plan.move ? plan : null;
}

export function parseArsenal(raw) {
    const o = extractJson(raw);
    if (!o) return null;
    const list = (v) => (Array.isArray(v) ? v : []).map(x => clip(x, 280)).filter(Boolean);
    const abilities = list(o.abilities).slice(0, 8);
    const agenda = list(o.agenda).slice(0, 3);
    if (!abilities.length) return null;
    return { abilities: abilities.map(x => `- ${x}`).join('\n'), agenda: agenda.map(x => `- ${x}`).join('\n') };
}

export function emptyMeta() {
    return { off: false, goal: '', scheme: '', sinceDrive: 99, moves: [], used: {} };
}

/** Is a self-driven move due this reply? */
export function driveDue(meta, mode) {
    const every = (MODES[mode] ?? MODES.lively).every;
    return (meta.sinceDrive ?? 99) >= every - 1;
}

/** Names of the toolbox entries ("Name: ...") as a list. */
export function abilityNames(arsenalText) {
    return String(arsenalText || '').split('\n')
        .map(l => l.replace(/^[-*\d.\s]+/, '').split(/[:—–]/)[0].trim()).filter(Boolean);
}

export function buildDirectorInput({ name, userName, card, arsenal, agenda, memory, scene, meta, mode, turn }) {
    const due = driveDue(meta, mode);
    const moves = (meta.moves ?? []).slice(-5).map(m => `- (${Math.max(1, turn - m.turn)} replies ago) ${m.move}${m.ace ? ` [used: ${m.ace}]` : ''}`).join('\n') || '- none yet';
    const used = abilityNames(arsenal).map((n) => {
        const t = meta.used?.[n];
        return t === undefined ? `${n}: never used` : `${n}: used ${Math.max(1, turn - t)} replies ago`;
    }).join('\n') || 'unknown';
    return [
        `Character: ${name}. Player: ${userName}.`,
        `<card>\n${clip(card, 2200)}\n</card>`,
        `<toolbox>\n${arsenal || '(unknown, rely on the card)'}\n</toolbox>`,
        agenda ? `<agenda>\n${agenda}\n</agenda>` : '',
        memory ? `<memory>\n${clip(memory, 1500)}\n</memory>` : '',
        `<scheme_so_far>${meta.scheme || 'none yet'}</scheme_so_far>`,
        `<recent_moves>\n${moves}\n</recent_moves>`,
        `<ability_use>\n${used}\n</ability_use>`,
        `<scene>\n${scene}\n</scene>`,
        due
            ? 'Initiative: DUE. The move MUST be an initiative of the character that changes the situation (a reveal, a trap, a twist, a signature ability put to use, a new arrival, a change of place), not an answer to the last message.'
            : 'Initiative: optional. Follow the scene naturally, but the move must still push something forward instead of only answering.',
    ].filter(Boolean).join('\n\n');
}

/** Book-keeping once a plan is chosen for a reply at `turn`. */
export function applyPlan(meta, plan, turn) {
    meta.goal = plan.goal || meta.goal;
    meta.scheme = plan.scheme || meta.scheme;
    meta.sinceDrive = plan.drive ? 0 : (meta.sinceDrive ?? 99) + 1;
    meta.moves = [...(meta.moves ?? []), { turn, move: plan.move, ace: plan.ace }].slice(-12);
    if (plan.ace) {
        meta.used ??= {};
        const names = Object.keys(meta.used);
        const hit = names.find(n => n.toLowerCase() === plan.ace.toLowerCase()) ?? plan.ace;
        meta.used[hit] = turn;
    }
    return meta;
}

/** The private block the main model sees. */
export function intentBlock(plan, char, user) {
    return [
        `[${char}'s intent for this reply: ${char}'s own plan. Carry it out in character, in your own words and voice. Never mention or quote it.]`,
        plan.goal ? `Goal: ${plan.goal}` : '',
        plan.scheme ? `Scheme: ${plan.scheme}` : '',
        `Move: ${plan.move}`,
        plan.ace ? `Use: ${plan.ace}${plan.ace_how ? ` — ${plan.ace_how}` : ''}` : '',
        `${user} still decides ${user}'s own actions. Show the consequence of ${char}'s move and stop there, on an action or a line of ${char}'s, not on a question about what ${user} will do.`,
    ].filter(Boolean).join('\n');
}
