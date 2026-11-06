/*
 * Elephant Core — one colour per speaking character.
 *
 * The narrator picks the colours (one card can hold many characters, only the
 * model knows who is who) and registers each new voice with an invisible
 * <!--voice Name=#hex--> comment. The app remembers them per chat and reminds
 * the narrator before every reply, so a voice never changes colour and two
 * voices never share one. The game engine reuses the same table.
 */
import { ctx, log } from '../stage/helper.js';

const META = 'elephant_voices';
const PROMPT_KEY = 'elephant_voices';

/** Distinct colours readable on a dark background, in the order they are handed out. */
export const PALETTE = ['e8a75c', '7ec8e3', 'c3a6ff', '8fe3a8', 'ff9fb2', 'e3e07e', '7ee3d4', 'ffb38a', 'a6c8ff', 'd9a6ff', 'b4e37e', 'ff8f8f'];
const VOICE_RE = /<!--\s*voice\s+([^=<>]{1,40}?)\s*=\s*#?([0-9a-f]{6})\s*-->/gi;

const norm = (name) => String(name || '').trim().toLowerCase();

function table() {
    const md = ctx().chatMetadata;
    if (!md) return null;
    md[META] ??= {};
    return md[META];
}

function used(t) { return new Set(Object.values(t).map(v => v.color)); }

/** Colour of a character, assigning a free one if they have none yet. */
export function colorFor(name, { assign = true } = {}) {
    const t = table();
    const key = norm(name);
    if (!t || !key) return null;
    if (t[key]) return t[key].color;
    if (!assign) return null;
    const taken = used(t);
    const color = PALETTE.find(c => !taken.has(c)) || PALETTE[Object.keys(t).length % PALETTE.length];
    t[key] = { name: String(name).trim(), color };
    ctx().saveMetadataDebounced?.();
    return color;
}

/** Called with colours the game engine already uses, so both stay in sync. */
export function adopt(name, color) {
    const t = table();
    const key = norm(name);
    if (!t || !key || !/^[0-9a-f]{6}$/i.test(color || '')) return;
    if (t[key]?.color === color) return;
    if (t[key]) return; // the table wins: the reader already knows this colour
    t[key] = { name: String(name).trim(), color: color.toLowerCase() };
    ctx().saveMetadataDebounced?.();
}

function freeColors(n = 3) {
    const t = table();
    const taken = t ? used(t) : new Set();
    return PALETTE.filter(c => !taken.has(c)).slice(0, n);
}

function promptText() {
    const c = ctx();
    const t = table();
    if (!t) return '';
    const known = Object.values(t).map(v => `${v.name} #${v.color}`).join('; ');
    return `[Speech colours: every line a character speaks goes in <font color=#hex>"…"</font> in that character's own colour, so the reader can tell voices apart. ${known ? `Voices so far (keep them exactly): ${known}.` : 'No voices yet.'} Anyone who already spoke earlier in this chat keeps the colour they had there. Narration and ${c.name1}'s words stay uncoloured. When a character speaks for the first time, choose a colour for them yourself — readable on a dark background, clearly different from every colour above — and add <!--voice Name=#hex--> on its own line once. Never give two characters the same colour.]`;
}

export function updatePrompt() {
    try {
        ctx().setExtensionPrompt(PROMPT_KEY, promptText(), 1 /* IN_CHAT */, 1, false, 0 /* SYSTEM */);
    } catch (e) { log('voices prompt failed', e); }
}

/** Reads <!--voice Name=#hex--> registrations from a reply. */
export function readVoices(text) {
    const t = table();
    if (!t) return 0;
    let n = 0;
    for (const m of String(text || '').matchAll(VOICE_RE)) {
        const key = norm(m[1]);
        if (!key || t[key]) continue;
        const color = m[2].toLowerCase();
        // If the model reused a colour someone already has, give the newcomer a free one.
        t[key] = { name: m[1].trim(), color: used(t).has(color) ? (freeColors(1)[0] || color) : color };
        n++;
    }
    if (n) ctx().saveMetadataDebounced?.();
    return n;
}

export async function init() {
    const c = ctx();
    const ev = c.eventSource;
    const et = c.eventTypes ?? c.event_types;
    globalThis.ElephantCore = { ...(globalThis.ElephantCore || {}), voices: { colorFor, adopt, readVoices, updatePrompt, PALETTE } };
    ev.on(et.CHAT_CHANGED, () => setTimeout(updatePrompt, 0));
    ev.on(et.GENERATION_STARTED, (_t, _o, dry) => { if (!dry) updatePrompt(); });
    ev.on(et.MESSAGE_RECEIVED, (id) => {
        const m = ctx().chat?.[Number(id)];
        if (m && !m.is_user && readVoices(m.mes)) updatePrompt();
    });
    updatePrompt();
}
