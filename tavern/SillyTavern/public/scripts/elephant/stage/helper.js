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

/** Is there any way to reach a helper model? */
export function hasHelper(settings) {
    return Boolean(settings.helperModel || helperProfileId(settings) || settings.allowMainModel);
}

/** NanoGPT models with prices, through the Elephant Core server endpoint. */
export async function loadHelperModels() {
    const res = await fetch('/api/elephant/models', { method: 'POST', headers: ctx().getRequestHeaders() });
    if (!res.ok) throw new Error(`models: ${res.status}`);
    return res.json();
}

/**
 * One cheap, non-streaming call. Order of preference:
 *   1. helperModel — straight to NanoGPT from the Elephant Core server (no profile needed);
 *   2. a Connection Manager profile (ours, else Elephant Memory's);
 *   3. the main model, if allowed.
 */
export async function callHelper(settings, systemText, userText, maxTokens = 400, { json = false } = {}) {
    const c = ctx();
    const messages = [
        { role: 'system', content: systemText },
        { role: 'user', content: userText },
    ];
    if (settings.helperModel) {
        const res = await fetch('/api/elephant/complete', {
            method: 'POST',
            headers: c.getRequestHeaders(),
            body: JSON.stringify({ model: settings.helperModel, messages, max_tokens: maxTokens, temperature: 0.3, json }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.message || `helper: ${res.status}`);
        return String(data.content ?? '').trim();
    }
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

/** Last n visible messages as plain "Name: text" lines (originals, not translations). Long ones keep their end: that is "now". */
export function recentMessages(n = 4, upTo = null) {
    const chat = ctx().chat ?? [];
    const end = upTo === null ? chat.length : upTo + 1;
    return chat.slice(0, end).filter(m => !m.is_system && m.mes).slice(-n)
        .map(m => { const t = String(m.mes).replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, '').trim(); return `${m.name}: ${t.length > 2200 ? '…' + t.slice(-2200) : t}`; }).join('\n\n');
}

export function clampWords(text, max) {
    const words = String(text).split(/\s+/);
    return words.length > max ? words.slice(0, max).join(' ') : text;
}

export const haptic = (kind) => {
    try { globalThis.ElephantApp?.haptic?.(kind); } catch { /* not in the app */ }
};
/**
 * Resolves once the reader can see the reply: Elephant Memory hides it behind a veil while
 * the translation is made. Scene changes, effects, banners and haptics wait for this, so they
 * land together with the text instead of before it.
 */
export function whenRevealed(timeout = 120_000) {
    const veiled = () => document.body.classList.contains('em-tr-veil');
    if (!veiled()) return Promise.resolve();
    return new Promise((resolve) => {
        const done = () => { mo.disconnect(); clearTimeout(t); resolve(); };
        const mo = new MutationObserver(() => { if (!veiled()) done(); });
        mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
        const t = setTimeout(done, timeout);
    });
}

export const inApp = () => typeof globalThis.ElephantApp !== 'undefined';
