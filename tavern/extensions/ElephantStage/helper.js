/* Shared access to SillyTavern and to the cheap "helper" model. */

export const MODULE = 'elephant_stage';
export const ctx = () => globalThis.SillyTavern.getContext();
export const toast = () => globalThis.toastr ?? { info: console.info, warning: console.warn, error: console.error, success: console.info };
export const log = (...a) => console.log('[Elephant Stage]', ...a);

/**
 * Connection profile for helper calls: our own setting, else the one
 * Elephant Memory already uses (so a fresh install needs no extra setup).
 */
export function helperProfileId(settings) {
    if (settings.helperProfile) return settings.helperProfile;
    return ctx().extensionSettings?.elephant_memory?.helperProfile || '';
}

export function listProfiles() {
    const cm = ctx().extensionSettings?.connectionManager;
    return Array.isArray(cm?.profiles) ? cm.profiles.map(p => ({ id: p.id, name: p.name })) : [];
}

/** One cheap, non-streaming call. Falls back to the main API when no profile is set. */
export async function callHelper(settings, systemText, userText, maxTokens = 400) {
    const c = ctx();
    const messages = [
        { role: 'system', content: systemText },
        { role: 'user', content: userText },
    ];
    const profileId = helperProfileId(settings);
    if (profileId && c.ConnectionManagerRequestService) {
        const res = await c.ConnectionManagerRequestService.sendRequest(profileId, messages, maxTokens, {
            stream: false,
            extractData: true,
            includePreset: false,
            includeInstruct: true,
        });
        return String(typeof res === 'string' ? res : res?.content ?? '').trim();
    }
    if (!settings.allowMainModel) throw new Error('no-helper');
    return String(await c.generateRaw({ prompt: messages, responseLength: maxTokens }) ?? '').trim();
}

/** Elephant Memory's state card for the current chat, if it keeps one. */
export function memoryState() {
    return ctx().chatMetadata?.elephant_memory?.state || '';
}

export function currentCharacter() {
    const c = ctx();
    if (c.groupId) {
        const g = c.groups?.find(x => x.id === c.groupId);
        return g ? { group: true, name: g.name, avatarUrl: null, key: 'group:' + g.id } : null;
    }
    const ch = c.characters?.[c.characterId];
    if (!ch) return null;
    return {
        group: false,
        name: ch.name,
        key: ch.avatar,
        avatarUrl: ch.avatar && ch.avatar !== 'none' ? c.getThumbnailUrl('avatar', ch.avatar) : null,
        description: ch.description || ch.data?.description || '',
        personality: ch.personality || ch.data?.personality || '',
        scenario: ch.scenario || ch.data?.scenario || '',
    };
}

/** Last n visible messages as plain "Name: text" lines (originals, not translations). */
export function recentMessages(n = 4, upTo = null) {
    const chat = ctx().chat ?? [];
    const end = upTo === null ? chat.length : upTo + 1;
    return chat.slice(0, end).filter(m => !m.is_system && m.mes).slice(-n)
        .map(m => `${m.name}: ${String(m.mes).replace(/<[^>]+>/g, '').slice(0, 1500)}`).join('\n\n');
}

export function clampWords(text, max) {
    const words = String(text).split(/\s+/);
    return words.length > max ? words.slice(0, max).join(' ') : text;
}

export const haptic = (kind) => {
    try { globalThis.ElephantApp?.haptic?.(kind); } catch { /* not in the app */ }
};
export const inApp = () => typeof globalThis.ElephantApp !== 'undefined';
