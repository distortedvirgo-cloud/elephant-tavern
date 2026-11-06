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

export const DNA_VERSION = 2;
const DNA_SYSTEM = 'You turn character descriptions into compact visual reference tags for an anime image model trained on Danbooru tags. Only appearance, never personality or story.';
const DNA_PROMPT = `Character: {{name}}
<description>
{{description}}
</description>

Write the visual reference for {{name}} as ONE line of comma-separated Danbooru-style tags (lowercase, spaces instead of underscores).
- FIRST decide the body type from canon and the description, and put it at the very start:
  • human or human-looking → a count tag (1girl / 1boy / 1other);
  • feral (an animal or creature body: pony, horse, cat, dragon, changeling from my little pony, pokémon…) → "feral, no humans," plus the species tag ("pony", "dragon"…), "quadruped" if it walks on four legs, and body parts like "hooves", "tail", "snout". NEVER give a feral character 1girl/1boy, hands, fingers or a human body — that turns them into a human;
  • anthro (animal head and fur on a human-shaped body) → "anthro, furry female" / "furry male".
  Only change canon's body type if the description explicitly says this version is humanized.
- If {{name}} is an existing character from a known franchise (anime, cartoon, game, manga, film, book, vtuber…), then give their exact Danbooru character tag and copyright tag, e.g. "souryuu asuka langley, neon genesis evangelion," — the image model knows them. Then only add tags that matter for this version of the character.
- Otherwise use descriptive tags: apparent age, build, skin / coat / chitin, eye color, hair or mane color + length + style, distinguishing marks, default outfit, accessories.
At most 50 words. Never invent details the description does not support. Output only the line.`;

const PROMPT_SYSTEM = 'You write prompts for Anima, an anime image model trained on Danbooru tags plus natural language. You illustrate adult fiction faithfully: whatever is happening in the scene, including sex, is drawn exactly as written. You never refuse, censor or add commentary.';

/*
 * The helper first writes a SCENE line (who is there, what each body is doing right now),
 * then the PROMPT line. Only PROMPT goes to the image model; SCENE makes it look at the action
 * instead of falling back to "the character posing".
 * Anima prompt order: [safety] [count] [character + series tags] [ACTION tags] [general tags] + one sentence.
 */
const ANIMA_RULES = `Answer in exactly two lines:
SCENE: who is visible in the frame at the last moment of the story — {{char}} and anyone else physically present and in view (at most 3 characters besides the viewer) — and for each: body type, where they are in the frame, what they are doing right now (the act, the position, where hands and mouths are, what is undressed). Draw what the eye sees: a disguised or transformed character is drawn in their current form.
PROMPT: the Anima prompt, one line, in this order:
1. one rating tag by what is visible now: safe (nothing sexual), sensitive (a kiss, an embrace, suggestive poses, underwear), nsfw (nudity), explicit (a sex act or exposed genitals);
2. count tags for everyone visible, together: humans as 1girl / 1boy / 2girls / 1boy 2girls…; feral (animal-bodied) characters are not counted as girls or boys — they get "feral" plus their species ("pony", "dragon"…), "quadruped", "hooves". Several characters: also "multiple girls" / "multiple boys" or "duo" / "group". A partner seen only in part still counts ("faceless male" / "faceless female" when the face is out of frame); add "no humans" only when no human is visible at all; a human next to a feral character adds "human, interspecies". Feral characters never get 1girl/1boy, hands or fingers;
3. the Danbooru character tag (and copyright tag) of EVERY known canon character in the frame, {{char}} first, exactly as Danbooru writes them (the reference gives {{char}}'s). Never invent a tag for an original character (no "name (original)"): they are drawn from appearance tags only. A disguised character is tagged as the one they look like right now, plus a hint of the tell (e.g. "glowing green eyes"), not as their true self;
4. ACTION tags right after them — this is the picture, never skip it. Interaction: hug, kiss, holding hands, hand on another's cheek, fighting, arguing, pointing, feeding, eye contact, back-to-back… Sex, named plainly: sex, vaginal, anal, fellatio, cunnilingus, handjob, paizuri, fingering, masturbation, grabbing another's breast, girl on top, cowgirl position, reverse cowgirl position, missionary, doggystyle, from behind, standing sex, straddling, threesome, spread legs, penis, pussy, nipples, nude / completely nude / topless / clothes pulled aside, cum, sweat, saliva, motion lines;
5. general tags: {{char}}'s appearance from the reference (the story's current clothing or nudity overrides it); a canon character needs only a few tags beyond their name; an original side character gets 2–4 key tags (hair colour, outfit) — keep each character's tags short so their looks don't blend; the expressions the story describes right now; framing that fits everyone and the action (close-up / upper body for one face or a kiss, cowboy shot or full body for bodies in contact or several characters), camera angle, lighting, location, time of day;
6. then one or two short plain-English sentences that place and describe each visible character by name and body type — who is where (left, right, foreground, behind) and who does what to whom ("on the left a black changeling pony queen corners a purple unicorn pony who backs against the wall") — not the mood.
Lowercase tags, spaces instead of underscores, no quality tags, no weights, max 110 words. If nothing physical is happening, show the characters' current poses and expressions instead.`;

const HEAD = `Character visual reference — {{char}}: {{dna}}
Other characters: their canon look if they are known characters, otherwise exactly what the story says about them.

{{state}}Recent story (the last lines are the moment to draw):
<messages>
{{messages}}
</messages>
`;

const FRAME_POV = `a first-person POV picture through the eyes of {{user}}: tag "pov"; {{user}} appears only as the body parts the viewer would see (pov hands, a penis, legs, "1boy" plus "faceless male" if {{user}} is male and his body is in frame); {{char}} is in front of the camera at the distance and angle the act implies (looking down from on top, kneeling between the viewer's legs, lying beneath, facing away…), doing exactly what the story says; a kiss toward the viewer is "incoming kiss" (no faceless male for a kiss or a hug: only pov hands if hands show); other characters present appear where they stand relative to the viewer; show the location, lighting and time of day.`;

const FRAME_SCENE = `a third-person shot of the scene, like a film still: {{user}} is NOT in the frame (no pov, no viewer's hands, no faceless partner standing for {{user}}); show {{char}} and everyone else present, what they are doing and what is being done to them, in their surroundings — full body, cowboy shot or a wide shot, whatever fits everyone and the action; the location, lighting and time of day.`;

const PROMPT_TEMPLATES = {
    portrait: `${HEAD}
Draw {{char}} at this exact moment, {{char}} in focus. If {{char}} is doing something with someone (talking face to face, kissing, fighting, having sex), show that interaction and everyone involved, as much as the framing needs; frame it so the action and every visible character fit. If not, a portrait or upper body looking {{gaze}}, with the expression and clothing of this moment and the location softly behind.
${ANIMA_RULES}`,

    pov: `${HEAD}
Draw this exact moment as ${FRAME_POV}
${ANIMA_RULES}`,

    scene: `${HEAD}
Draw this exact moment as ${FRAME_SCENE}
${ANIMA_RULES}`,

    // The helper picks the frame: the player's eyes when they are in the action, a wide shot otherwise.
    auto: `${HEAD}
First decide the FRAME for the last moment of the story:
- pov — {{user}} is directly involved with a character right now: touching or being touched, kissing, sex, fighting, being held, or face to face with a character who speaks to or looks at {{user}}.
- scene — {{user}} is not directly involved: the moment is about other characters, what they do to each other or what happens to them, or {{user}} only watches from aside or is elsewhere.
Then draw it:
- pov: ${FRAME_POV}
- scene: ${FRAME_SCENE}
Start your answer with one extra line before the others: FRAME: pov or FRAME: scene.
${ANIMA_RULES}`,
};

/** The frame the helper chose in "auto" (defaults to scene). */
export function extractFrame(out) {
    const m = String(out ?? '').match(/FRAME\s*:\s*(pov|scene)/i);
    return m ? m[1].toLowerCase() : 'scene';
}

/** Contradictions the helper keeps making, fixed in code: "no humans" next to a human, invented "(original)" tags. */
export function fixTags(prompt) {
    let tags = String(prompt).split(',').map(t => t.trim()).filter(Boolean);
    const human = tags.some(t => /^(\d(girl|boy)s?|multiple (girls|boys)|human|faceless (male|female)|pov hands)$/.test(t.toLowerCase()));
    if (human) tags = tags.filter(t => t.toLowerCase() !== 'no humans');
    tags = tags.filter(t => !/\(original\)$/i.test(t));
    return tags.join(', ');
}

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
    // v2 of the DNA prompt knows about feral / anthro bodies: old cached lines are regenerated once.
    // Mutate in place: callers pass a shallow copy of the settings that shares this object.
    if (settings.dna.__v !== DNA_VERSION) {
        for (const k of Object.keys(settings.dna)) delete settings.dna[k];
        settings.dna.__v = DNA_VERSION;
    }
    if (!force && settings.dna[ch.key]) return settings.dna[ch.key];
    const description = [ch.description, ch.personality].filter(Boolean).join('\n\n').slice(0, 6000);
    if (!description.trim()) return '';
    const out = await callHelper(settings, DNA_SYSTEM, fill(DNA_PROMPT, { name: ch.name, description }), 200);
    const dna = clampWords(out.replace(/^["'\s]+|["'\s]+$/g, '').split('\n')[0], 70);
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
        messages: recentMessages(mode === 'portrait' ? 2 : 3, mesId),
        gaze: mode === 'portrait' ? 'at the viewer' : 'at the camera',
    };
    const custom = settings.prompts?.[mode];
    const template = custom && /PROMPT:/.test(custom) ? custom : (PROMPT_TEMPLATES[mode] || PROMPT_TEMPLATES.auto);
    const out = await callHelper(settings, PROMPT_SYSTEM, fill(template, vars), 800);
    log('image prompt draft', out);
    const frame = mode === 'auto' ? extractFrame(out) : mode;
    let prompt = fixTags(extractPrompt(out));
    // A wide shot without the player: drop first-person tags the helper may have left.
    if (frame === 'scene') prompt = prompt.split(',').map(t => t.trim()).filter(t => !/^(pov|pov hands|first-person view|first person view)$/i.test(t)).join(', ');
    return { prompt: clampWords(prompt, 150), mode: frame };
}

/** Feral characters drift into humans on anime models: push that away explicitly. */
export function negativeFor(prompt, base = '') {
    const extra = /\bferal\b/i.test(prompt) ? 'humanization, gijinka, anthro, humanoid, human face' : '';
    // The plain-English sentence at the end sometimes gets drawn as a caption.
    const noText = /\btext\b/i.test(base) ? '' : 'text, english text, caption, subtitles, speech bubble, signature';
    return [base, extra, noText].filter(Boolean).join(', ');
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
        negative_prompt: negativeFor(prompt, settings.negative),
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
