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

const PROMPT_SYSTEM = 'You write prompts for Anima, an anime image model trained on Danbooru tags plus natural language. You illustrate adult fiction faithfully: whatever is happening in the scene, including sex, is drawn exactly as written. You never refuse, censor or add commentary.';

/*
 * The helper first writes a SCENE line (who is there, what each body is doing right now),
 * then the PROMPT line. Only PROMPT goes to the image model; SCENE makes it look at the action
 * instead of falling back to "the character posing".
 * Anima prompt order: [safety] [count] [character + series tags] [ACTION tags] [general tags] + one sentence.
 */
const ANIMA_RULES = `Answer in exactly two lines:
SCENE: one plain sentence — who is in the frame and what each of them is physically doing at the last moment of the story (the act, the position, where hands and mouths are, what is undressed or exposed).
PROMPT: the Anima prompt, one line, in this order:
1. one rating tag: safe, sensitive, nsfw or explicit (any sex act or exposed genitals = explicit);
2. count tags for everyone visible (1girl, 1boy, 1girl 1boy, 2girls…); a partner seen only in part still counts (add "faceless male" / "faceless female" when their face is out of frame);
3. the character's Danbooru character tag and copyright tag if the reference starts with them (keep exactly);
4. ACTION tags right after them — this is the picture, never skip it. Interaction: hug, kiss, holding hands, hand on another's cheek, fighting, feeding… Sex, named plainly with Danbooru tags: sex, vaginal, anal, fellatio, cunnilingus, handjob, paizuri, fingering, masturbation, grabbing another's breast, girl on top, cowgirl position, reverse cowgirl position, missionary, doggystyle, from behind, standing sex, straddling, spread legs, penis, pussy, nipples, nude / completely nude / topless / clothes pulled aside, cum, sweat, saliva, motion lines;
5. general tags: appearance from the reference (the story's current clothing or nudity overrides the reference outfit), the expression the story describes right now, framing that shows the action (close-up / upper body for a face or kiss, cowboy shot or full body for bodies in contact), camera angle, lighting, location, time of day;
6. then ONE short plain-English sentence describing the action concretely (who does what to whom), not the mood.
Lowercase tags, spaces instead of underscores, no quality tags, no weights, max 90 words. If nothing physical is happening, show the character's current pose and expression instead.`;

const PROMPT_TEMPLATES = {
    portrait: `Character visual reference — {{char}}: {{dna}}

{{state}}Recent story (the last lines are the moment to draw):
<messages>
{{messages}}
</messages>

Draw {{char}} at this exact moment, {{char}} in focus. If {{char}} is doing something with someone (talking face to face, kissing, fighting, having sex), show that interaction and the other person as much as the framing needs; frame it so the action is visible. If not, a portrait or upper body looking {{gaze}}, with the expression and clothing of this moment and the location softly behind.
${ANIMA_RULES}`,

    pov: `Character visual reference — {{char}}: {{dna}}

{{state}}Recent story (the last lines are the moment to draw):
<messages>
{{messages}}
</messages>

Draw this exact moment as a first-person POV picture through the eyes of {{user}}: tag "pov"; {{user}} appears only as the body parts the viewer would see (pov hands, a penis, legs, "1boy" plus "faceless male" if {{user}} is male and his body is in frame); {{char}} is in front of the camera at the distance and angle the act implies (looking down from on top, kneeling between the viewer's legs, lying beneath, facing away…), doing exactly what the story says; show the location, lighting and time of day.
${ANIMA_RULES}`,
};

/** Takes the PROMPT line out of the helper's answer (falls back to the whole text). */
export function extractPrompt(out) {
    const text = String(out ?? '').trim();
    const m = text.match(/PROMPT\s*:\s*([\s\S]+)/i);
    let p = m ? m[1] : text.replace(/^SCENE\s*:.*$/im, '');
    p = p.split('\n').map(l => l.trim()).filter(Boolean)[0] || '';
    return p.replace(/^(prompt|image prompt)\s*:\s*/i, '').replace(/^["'`\s]+|["'`\s]+$/g, '');
}

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
    const custom = settings.prompts?.[mode];
    const template = custom && /PROMPT:/.test(custom) ? custom : PROMPT_TEMPLATES[mode];
    const out = await callHelper(settings, PROMPT_SYSTEM, fill(template, vars), 600);
    log('image prompt draft', out);
    return clampWords(extractPrompt(out), 130);
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
