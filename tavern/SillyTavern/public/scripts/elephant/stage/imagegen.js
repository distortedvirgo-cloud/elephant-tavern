/*
 * Elephant Stage — automatic illustrations through NanoGPT.
 *
 * The cheap helper model writes the image prompt from the character's
 * "visual DNA", Elephant Memory's state card and the last messages.
 * Two framings:
 *   portrait — {{char}} in focus: face/upper body, expression, outfit;
 *   pov      — first person through {{user}}'s eyes, {{char}} in front of the camera.
 * Images go through SillyTavern's own /api/sd/nanogpt endpoint (it reads the
 * NanoGPT key you already saved for chat) and are attached to the message.
 */
import { saveBase64AsFile } from '../../utils.js';
import { power_user } from '../../power-user.js';
import { user_avatar } from '../../personas.js';
import { ctx, callHelper, memoryState, currentCharacter, recentMessages, clampWords, log } from './helper.js';

export const SIZES = {
    portrait: { width: 832, height: 1216, label: 'Вертикально 832×1216' },
    square: { width: 1024, height: 1024, label: 'Квадрат 1024×1024' },
    landscape: { width: 1216, height: 832, label: 'Горизонтально 1216×832' },
};

import { DNA_VERSION, DNA_SYSTEM, DNA_PROMPT, PROMPT_SYSTEM, PROMPT_TEMPLATES, extractFrame, fixTags, extractPrompt, fill, negativeFor, styleNegative, stylePrefixFor, parseDna, enforceCharTag, firstPerson, viewerBody } from './imageprompt.js';
export * from './imageprompt.js';

export async function loadModels() {
    const res = await fetch('/api/sd/nanogpt/models', { method: 'POST', headers: ctx().getRequestHeaders() });
    if (!res.ok) throw new Error(res.status === 400 ? 'Нет ключа NanoGPT: сохраните его в API Connections' : `NanoGPT: ${res.status}`);
    return res.json();
}

/** Appearance tags for the current character, generated once and cached in settings. */
export async function visualDna(settings, { force = false } = {}) {
    const ch = currentCharacter();
    if (!ch || ch.group) return '';
    settings.dna ??= {};
    // v2 of the DNA prompt knows about feral / anthro bodies: old cached lines are regenerated once.
    // Mutate in place: callers pass a shallow copy of the settings that shares this object.
    if (settings.dna.__v !== DNA_VERSION) {
        for (const k of Object.keys(settings.dna)) delete settings.dna[k];
        settings.dna.__v = DNA_VERSION;
    }
    if (!force && settings.dna[ch.key]) return settings.dna[ch.key];
    const description = [ch.description, ch.personality].filter(Boolean).join('\n\n').slice(0, 6000);
    if (!description.trim()) return '';
    const out = await callHelper(settings, DNA_SYSTEM, fill(DNA_PROMPT, { name: ch.name, description }), 260);
    const parsed = parseDna(out);
    const dna = clampWords(parsed.look, 70);
    settings.dna[ch.key] = dna;
    settings.dnaTag ??= {};
    settings.dnaTag[ch.key] = parsed.tag;
    ctx().saveSettingsDebounced();
    return dna;
}

/** The player's look (current persona), from the persona generator or made once from its description. */
export async function personaLook(settings, { force = false, generate = true } = {}) {
    const id = user_avatar;
    if (!id) return '';
    settings.personaLook ??= {};
    if (!force && settings.personaLook[id]) return settings.personaLook[id];
    const desc = String(power_user.persona_descriptions?.[id]?.description || power_user.persona_description || '').trim();
    if (!generate || !desc) return settings.personaLook[id] || '';
    const name = power_user.personas?.[id] || ctx().name1;
    const out = await callHelper(settings, DNA_SYSTEM, fill(DNA_PROMPT, { name, description: desc.replaceAll('{{user}}', name).slice(0, 4000) }), 260);
    const look = clampWords(parseDna(out).look, 50);
    settings.personaLook[id] = look;
    ctx().saveSettingsDebounced();
    return look;
}
export const personaKey = () => user_avatar;

export async function buildPrompt(settings, mode, mesId) {
    const c = ctx();
    const dna = await visualDna(settings).catch(() => '');
    const state = memoryState();
    const exact = String(settings.dnaTag?.[currentCharacter()?.key] || '').trim();
    // the player can be in the frame only when the app knows what they look like
    const look = settings.duo === false ? '' : await personaLook(settings, { generate: ['duo', 'auto'].includes(mode) }).catch(() => '');
    if (mode === 'duo' && !look) mode = 'pov';
    const vars = {
        userline: look ? `{{user}}'s look (only when {{user}} is drawn): ${look}\n` : '',
        tagline: exact ? `Exact tag — ${c.name2}: ${exact}\n` : '',
        char: c.name2,
        user: c.name1,
        dna: dna || '(see story)',
        state: state ? `Story state:\n<state>\n${state.slice(0, 3000)}\n</state>\n\n` : '',
        messages: recentMessages(mode === 'portrait' ? 2 : 3, mesId),
        gaze: mode === 'portrait' ? 'at the viewer' : 'at the camera',
    };
    const custom = settings.prompts?.[mode];
    const key = mode === 'auto' && look ? 'auto_duo' : mode;
    const template = custom && /PROMPT:/.test(custom) ? custom : (PROMPT_TEMPLATES[key] || PROMPT_TEMPLATES.auto);
    const out = await callHelper(settings, PROMPT_SYSTEM, fill(template, vars), 800);
    log('image prompt draft', out);
    const frame = mode === 'auto' ? extractFrame(out) : mode;
    let prompt = fixTags(extractPrompt(out));
    // An original character has no Danbooru tag: a bare name tag would only confuse the image model.
    const nameTag = String(c.name2 || '').trim().toLowerCase();
    if (nameTag && dna && !dna.toLowerCase().includes(nameTag)) prompt = prompt.split(',').map(t => t.trim()).filter(t => t.toLowerCase() !== nameTag).join(', ');
    // The exact Danbooru tag from the character's settings replaces whatever short form the helper wrote.
    if (exact) prompt = enforceCharTag(prompt, exact);
    // "pov" is never sent (it draws idle hands); a wide shot also loses the viewer's hands.
    prompt = firstPerson(prompt);
    if (frame === 'duo') prompt = prompt.split(',').map(t => t.trim()).filter(t => !/^(pov hands?|faceless (male|female)|solo)$/i.test(t)).join(', ');
    if (frame === 'scene') prompt = prompt.split(',').map(t => t.trim()).filter(t => !/^pov hands?$/i.test(t)).join(', ');
    return { prompt: clampWords(prompt, 120), mode: frame };
}

export async function generateImage(settings, prompt, mode, signal) {
    const base = SIZES[settings.size] || (mode === 'pov' ? SIZES.landscape : SIZES.portrait);
    // 1.5K: the server picks NanoGPT's "1.5k" resolution for sizes over ~1300 px.
    const k = settings.hires ? 1.3 : 1;
    const size = { width: Math.round(base.width * k / 8) * 8, height: Math.round(base.height * k / 8) * 8 };
    const style = stylePrefixFor(settings);
    // Anima reads "[quality] [safety] [count] [character] [series] [general]": the style prefix carries the quality tags.
    const fullPrompt = [style, prompt].filter(Boolean).join(', ');
    const body = {
        model: settings.model,
        prompt: fullPrompt,
        // First person without the viewer's body: keep the model from adding hands and a second person on its own.
        negative_prompt: [negativeFor(prompt, settings.negative), styleNegative(settings), mode === 'pov' && !viewerBody(prompt) ? 'pov, pov hands, disembodied limb, multiple views' : mode === 'duo' ? 'pov, pov hands, faceless male, faceless female, solo' : 'pov'].filter(Boolean).join(', '),
        width: size.width,
        height: size.height,
        resolution: `${size.width}x${size.height}`,
        showExplicitContent: true,
        nImages: 1,
    };
    if (settings.steps) body.num_steps = Number(settings.steps);
    if (settings.scale) body.scale = Number(settings.scale);
    const res = await fetch('/api/sd/nanogpt/generate', {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify(body),
        signal,
    });
    if (!res.ok) {
        if (res.status === 400) throw new Error('Нет ключа NanoGPT');
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `NanoGPT вернул ошибку (${res.status})`);
    }
    const data = await res.json();
    if (!data?.image) throw new Error('NanoGPT не вернул картинку');
    return { base64: data.image, prompt: fullPrompt };
}

/** Saves the image under the character's folder and attaches it to the message. */
export async function attachToMessage(mesId, base64, prompt, mode) {
    const c = ctx();
    const message = c.chat[mesId];
    if (!message) return null;
    const folder = c.name2 || 'elephant-stage';
    const name = `${mode}_${Date.now()}`;
    const url = await saveBase64AsFile(base64, folder, name, 'jpg');

    message.extra ??= {};
    if (!Array.isArray(message.extra.media)) message.extra.media = [];
    if (!message.extra.media.length) message.extra.media_display = 'gallery';
    message.extra.media.push({ url, type: 'image', title: prompt, generation_type: mode === 'pov' ? 'elephant_pov' : 'elephant_portrait', source: 'generated' });
    message.extra.media_index = message.extra.media.length - 1;
    message.extra.inline_image = true;

    const $mes = globalThis.jQuery(`#chat .mes[mesid="${mesId}"]`);
    if ($mes.length) {
        c.appendMediaToMessage(message, $mes, 'keep');
        if (mesId === c.chat.length - 1) c.scrollOnMediaLoad?.();
    }
    await c.saveChat();
    log('image attached', mesId, url);
    return url;
}
