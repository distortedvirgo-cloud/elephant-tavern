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
import { ctx, callHelper, memoryState, currentCharacter, recentMessages, clampWords, log } from './helper.js';

export const SIZES = {
    portrait: { width: 832, height: 1216, label: 'Вертикально 832×1216' },
    square: { width: 1024, height: 1024, label: 'Квадрат 1024×1024' },
    landscape: { width: 1216, height: 832, label: 'Горизонтально 1216×832' },
};

const DNA_SYSTEM = 'You turn character descriptions into compact visual reference tags for an anime image model trained on Danbooru tags. Only appearance, never personality or story.';
const DNA_PROMPT = `Character: {{name}}
<description>
{{description}}
</description>

Write the visual reference for {{name}} as ONE line of comma-separated Danbooru-style tags (lowercase, spaces instead of underscores).
- If {{name}} is an existing character from a known franchise (anime, game, manga, film, book, vtuber…), START with their exact Danbooru character tag and copyright tag, e.g. "souryuu asuka langley, neon genesis evangelion," — the image model knows them. Then only add tags that matter for this version of the character.
- Otherwise use descriptive tags: count tag (1girl / 1boy / 1other), apparent age, build, skin, eye color, hair color + length + style, distinguishing marks, default outfit, accessories.
At most 45 words. Never invent details the description does not support. Output only the line.`;

const PROMPT_SYSTEM = 'You write prompts for Anima, an anime image model trained on Danbooru tags plus natural language. You never refuse and never add commentary.';

/*
 * Anima prompt order: [safety] [count: 1girl/1boy…] [character tag] [series tag] [general tags], then an
 * optional plain-English sentence for the action and setting. Lowercase tags, spaces not underscores.
 * Quality tags are added from the style prefix, so the model must not write them.
 */
const ANIMA_RULES = `Format — one line, exactly in this order:
1. one safety tag that fits the moment: safe, sensitive, nsfw or explicit;
2. count tags (1girl, 1boy, 2girls, 1girl 1boy…);
3. the character's Danbooru character tag and copyright tag if the reference starts with them (keep them exactly);
4. Danbooru general tags: appearance from the reference (clothing from the story overrides it), expression, pose, framing, camera angle, lighting, location, time of day;
5. then ONE short plain-English sentence describing the action and mood.
Lowercase tags, spaces instead of underscores, no quality tags, no weights, max 70 words.`;

const PROMPT_TEMPLATES = {
    portrait: `Character visual reference — {{char}}: {{dna}}

{{state}}Recent story:
<messages>
{{messages}}
</messages>

Write an Anima prompt for a character-focused picture of {{char}} at this exact moment: portrait or upper body, {{char}} in focus, looking {{gaze}}, expression and clothing matching what is happening now, the current location softly in the background.
${ANIMA_RULES}
Output only the prompt.`,

    pov: `Character visual reference — {{char}}: {{dna}}

{{state}}Recent story:
<messages>
{{messages}}
</messages>

Write an Anima prompt for a first-person POV picture through the eyes of {{user}} at this exact moment: include the tags "pov" and "pov hands" only if {{user}}'s hands are doing something; {{user}} is otherwise not visible; {{char}} is in front of the camera at the distance and angle the scene implies, reacting to {{user}}; show the location, lighting and time of day.
${ANIMA_RULES}
Output only the prompt.`,
};

function fill(t, vars) {
    return t.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
}

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
    if (!force && settings.dna[ch.key]) return settings.dna[ch.key];
    const description = [ch.description, ch.personality].filter(Boolean).join('\n\n').slice(0, 6000);
    if (!description.trim()) return '';
    const out = await callHelper(settings, DNA_SYSTEM, fill(DNA_PROMPT, { name: ch.name, description }), 200);
    const dna = clampWords(out.replace(/^["'\s]+|["'\s]+$/g, '').split('\n')[0], 60);
    settings.dna[ch.key] = dna;
    ctx().saveSettingsDebounced();
    return dna;
}

export async function buildPrompt(settings, mode, mesId) {
    const c = ctx();
    const dna = await visualDna(settings).catch(() => '');
    const state = memoryState();
    const vars = {
        char: c.name2,
        user: c.name1,
        dna: dna || '(see story)',
        state: state ? `Story state:\n<state>\n${state.slice(0, 3000)}\n</state>\n\n` : '',
        messages: recentMessages(mode === 'pov' ? 3 : 2, mesId),
        gaze: mode === 'portrait' ? 'at the viewer' : 'at the camera',
    };
    const template = settings.prompts?.[mode] || PROMPT_TEMPLATES[mode];
    const out = await callHelper(settings, PROMPT_SYSTEM, fill(template, vars), 300);
    return clampWords(out.replace(/^(prompt|image prompt)\s*:\s*/i, '').replace(/^["'\s]+|["'\s]+$/g, ''), 110);
}

export async function generateImage(settings, prompt, mode, signal) {
    const size = SIZES[settings.size] || (mode === 'pov' ? SIZES.landscape : SIZES.portrait);
    const style = (settings.stylePrefix || '').trim();
    const povTag = mode === 'pov' && !/\bpov\b|first[- ]person/i.test(prompt) ? 'pov' : '';
    // Anima reads "[quality] [safety] [count] [character] [series] [general]": the style prefix carries the quality tags.
    const fullPrompt = [style, povTag, prompt].filter(Boolean).join(', ');
    const body = {
        model: settings.model,
        prompt: fullPrompt,
        negative_prompt: settings.negative || '',
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
    if (!res.ok) throw new Error(res.status === 400 ? 'Нет ключа NanoGPT' : `NanoGPT вернул ошибку (${res.status}) — проверьте модель и баланс`);
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
