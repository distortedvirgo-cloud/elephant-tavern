import { cannotLeave } from './status.js';

const clean = (value, length) => typeof value === 'string' ? value.trim().slice(0, length) : '';
const placeKey = value => clean(value, 40).toLowerCase().replaceAll('ё', 'е');
const stamp = value => typeof value === 'string' ? Date.parse(`${value.slice(0, 16)}Z`) : NaN;

export function updateNpcPlan(npc, change, time) {
    if (change?.op === 'close') {
        delete npc.plan;
        return;
    }
    if (!['set', 'reschedule'].includes(change?.op)) return;
    const previous = npc.plan;
    const reschedule = change.op === 'reschedule';
    if (reschedule && (!previous || previous.completedAt)) return;
    const goal = clean(change.goal_ru ?? (reschedule ? previous.goal : ''), 120);
    const step = clean(change.step_ru ?? (reschedule ? previous.step : ''), 140);
    if (!goal || !step) return;
    const sameStep = previous?.goal === goal && previous.step === step;
    if (sameStep && !reschedule) {
        if (change.known === true) previous.known = true;
        return;
    }

    const minutes = Number(change.after_minutes);
    if (reschedule && !(Number.isFinite(minutes) && minutes > 0)) return;
    const now = stamp(time);
    const dueAt = Number.isFinite(now) && Number.isFinite(minutes) && minutes > 0
        ? new Date(now + Math.min(43_200, Math.ceil(minutes)) * 60_000).toISOString().slice(0, 16)
        : '';
    const destination = dueAt ? clean(change.destination_ru ?? (reschedule ? previous.destination : ''), 40) : '';
    npc.plan = {
        goal, step, dueAt, destination,
        leaves: Boolean(dueAt && (destination || (change.leaves ?? (reschedule && previous.leaves)) === true)),
        notice: dueAt ? clean(change.notice_ru ?? (reschedule ? previous.notice : ''), 180) : '',
        noticePlace: dueAt ? clean(change.notice_place_ru ?? (reschedule ? previous.noticePlace : ''), 40) : '',
        known: change.known === true || (sameStep && previous.known === true),
    };
}

export function advanceNpcPlans(state) {
    const now = stamp(state.time);
    if (!Number.isFinite(now)) return;
    for (const npc of Object.values(state.npcs)) {
        const plan = npc.plan;
        if (!plan?.dueAt || plan.completedAt || !(stamp(plan.dueAt) <= now)) continue;
        if (cannotLeave(npc) || (npc.present && state.enc?.status === 'active')) continue;
        plan.completedAt = state.time;
        if (plan.notice && plan.noticePlace) {
            const earlier = (npc.planNotices || []).filter(entry => placeKey(entry.place) !== placeKey(plan.noticePlace));
            npc.planNotices = [...earlier, { at: state.time, place: plan.noticePlace, text: plan.notice }].slice(-3);
        }
        if (plan.leaves && (!plan.destination || placeKey(plan.destination) !== placeKey(state.location))) npc.present = false;
    }
}

export function npcPlanSummary(plan) {
    if (!plan) return '';
    if (plan.completedAt) return `carried out at ${plan.completedAt}: ${plan.step}${plan.destination ? ` (went to ${plan.destination})` : ''}`;
    return `goal: ${plan.goal}; next: ${plan.step}${plan.dueAt ? ` if unchanged, at ${plan.dueAt}` : ''}`;
}

export function localPlanConsequences(state) {
    const here = placeKey(state.location);
    if (!here) return [];
    return Object.values(state.npcs)
        .flatMap(npc => npc.planNotices || [])
        .filter(entry => placeKey(entry.place) === here)
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, 3)
        .map(entry => entry.text);
}
