// Only the active swipe contributes a location to the current chat branch.
export function* placeVisits(initial, chat, state) {
    function* label(location) {
        if (typeof location === 'string' && location.trim()) yield location.trim().replace(/\s+/g, ' ');
    }
    yield* label(initial?.location);
    for (const message of chat) yield* label(message.extra?.elephant_game?.state?.location);
    yield* label(state.location);
}

export function hasExit(initial, chat, state) {
    const current = state.location?.trim().replace(/\s+/g, ' ').toLowerCase();
    if (!current) return false;
    let previous;
    for (const label of placeVisits(initial, chat, state)) {
        const key = label.toLowerCase();
        if (previous === current && key !== current) return true;
        previous = key;
    }
    return false;
}
