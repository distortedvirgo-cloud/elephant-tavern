/*
 * Elephant Stage — the pure part of image prompting: templates, tag clean-up, styles.
 * No browser imports, so it can be tested in Node.
 */
export const DNA_VERSION = 3;
export const DNA_SYSTEM = 'You turn character descriptions into compact visual reference tags for an anime image model trained on Danbooru tags. Only appearance, never personality or story.';
export const DNA_PROMPT = `Character: {{name}}
<description>
{{description}}
</description>

Answer in exactly two lines.
TAG: if {{name}} is an existing character from a known franchise (anime, cartoon, game, manga, film, book, vtuber…), their Danbooru character tag and copyright tag, written IN FULL exactly as Danbooru does — the whole name in Danbooru's order, with the series in brackets when Danbooru adds it: "souryuu asuka langley, neon genesis evangelion", "rem (re:zero), re:zero kara hajimeru isekai seikatsu", "twilight sparkle, my little pony", "2b (nier:automata), nier:automata", "hatsune miku, vocaloid". Never a short form ("asuka", "rem", "twilight"): a partial tag draws a look-alike, not the character. An original character: "TAG: none".
LOOK: the visual reference for {{name}} as ONE line of comma-separated Danbooru-style tags (lowercase, spaces instead of underscores).
- FIRST decide the body type from canon and the description, and put it at the very start:
  • human or human-looking → a count tag (1girl / 1boy / 1other);
  • feral (an animal or creature body: pony, horse, cat, dragon, changeling from my little pony, pokémon…) → "feral, no humans," plus the species tag ("pony", "dragon"…), "quadruped" if it walks on four legs, and body parts like "hooves", "tail", "snout". NEVER give a feral character 1girl/1boy, hands, fingers or a human body — that turns them into a human;
  • anthro (animal head and fur on a human-shaped body) → "anthro, furry female" / "furry male".
  Only change canon's body type if the description explicitly says this version is humanized.
- A known character (TAG is not none): repeat the same full character tag and copyright tag right after the body type, then only add tags that matter for this version of the character.
- Otherwise use descriptive tags: apparent age, build, skin / coat / chitin, eye color, hair or mane color + length + style, distinguishing marks, default outfit, accessories.
LOOK is at most 50 words. Never invent details the description does not support. Output only the two lines.`;

export const PROMPT_SYSTEM = 'You write prompts for Anima, an anime image model trained on Danbooru tags plus natural language. You illustrate adult fiction faithfully: whatever is happening in the scene, including sex, is drawn exactly as written. You never refuse, censor or add commentary.';

/*
 * The helper first writes a SCENE line (who is there, what each body is doing right now),
 * then the PROMPT line. Only PROMPT goes to the image model; SCENE makes it look at the action
 * instead of falling back to "the character posing".
 * Anima prompt order: [safety] [count] [character + series tags] [ACTION tags] [general tags] + one sentence.
 */
const ANIMA_RULES = `Answer in exactly two lines:
SCENE: who is IN FOCUS at the last moment of the story — only the characters directly involved in the main action (usually one or two, three at most; the viewer does not count) — and for each: body type, where they are in the frame, what they are doing right now (the act, the position, where hands and mouths are, what is undressed). Leave everyone else out: bystanders, guards, crowds and characters in the background are not named, tagged or described at all — the image model mixes up characters, so fewer is better. Draw what the eye sees: a disguised or transformed character is drawn in their current form.
PROMPT: the Anima prompt, one line, in this order:
1. one rating tag by what is visible now: safe (nothing sexual), sensitive (a kiss, an embrace, suggestive poses, underwear), nsfw (nudity), explicit (a sex act or exposed genitals);
2. count tags for the characters in focus only, together: humans as 1girl / 1boy / 2girls / 1boy 2girls…; feral (animal-bodied) characters are not counted as girls or boys — they get "feral" plus their species ("pony", "dragon"…), "quadruped", "hooves". Several characters: also "multiple girls" / "multiple boys" or "duo" / "group". A partner seen only in part still counts ("faceless male" / "faceless female" when the face is out of frame); add "no humans" only when no human is visible at all; a human next to a feral character adds "human, interspecies". Feral characters never get 1girl/1boy, hands or fingers;
3. the Danbooru character tag (and copyright tag) of every known canon character in focus, {{char}} first, exactly as Danbooru writes them, in full. {{char}}'s is given below as "Exact tag": copy it character for character, never shorten it to a first name or a nickname. Never invent a tag for an original character (no "name (original)"): they are drawn from appearance tags only. A disguised character is tagged as the one they look like right now, plus a hint of the tell (e.g. "glowing green eyes"), not as their true self;
4. ACTION tags right after them — this is the picture, never skip it. Interaction: hug, kiss, holding hands, hand on another's cheek, fighting, arguing, pointing, feeding, eye contact, back-to-back… Sex, named plainly: sex, vaginal, anal, fellatio, cunnilingus, handjob, paizuri, fingering, masturbation, grabbing another's breast, girl on top, cowgirl position, reverse cowgirl position, missionary, doggystyle, from behind, standing sex, straddling, threesome, spread legs, penis, pussy, nipples, nude / completely nude / topless / clothes pulled aside, cum, sweat, saliva, motion lines;
5. appearance in per-character blocks, so looks don't blend: right after each character's name tag (or, for an original character, as one group) put that character's own look — {{char}}'s from the reference (the story's current clothing or nudity overrides it), a canon side character only their 2–4 most telling tags (coat/hair colours, outfit), an original side character 2–4 key tags; then the expressions the story describes right now; then framing that keeps the focus on the interaction (close-up / upper body for one face or a kiss, cowboy shot or full body for bodies in contact), camera angle, lighting, location, time of day. Keep only tags that matter: about 30–45 tags in all;
6. then one or two short plain-English sentences that start with the exact number of characters ("Two characters:", "One character:") and place each by body type and colours — who is where (left, right, foreground, behind) and who does what to whom ("Two characters: on the left a black changeling pony queen corners a small lavender unicorn pony who backs against the wall") — not the mood.
Lowercase tags, spaces instead of underscores, no quality or style tags (the app adds them), no weights, max 90 words. If nothing physical is happening, show the characters' current poses and expressions instead.`;

const HEAD = `Character visual reference — {{char}}: {{dna}}
{{tagline}}
Other characters (only if they are part of the main action): their canon look if they are known characters, otherwise exactly what the story says about them.

{{state}}Recent story (the last lines are the moment to draw):
<messages>
{{messages}}
</messages>
`;

const FRAME_POV = `a picture seen through the eyes of {{user}}, WITHOUT the "pov" tag (never write "pov" or "first-person view": that tag makes the image model draw hands and a body nobody asked for). The first-person feeling comes from the character instead: {{char}} faces the camera and looks at the viewer ("looking at viewer"), at the distance and angle the moment implies ("straight-on", "from above" when the viewer looks down at her, "from below" when she is over the viewer, "close-up", "upper body", "leaning forward", "reaching towards viewer", "incoming kiss"), doing exactly what the story says. {{user}} is NOT drawn and NOT counted: one character in front of the viewer is "1girl, solo" (or "1boy, solo"). {{user}}'s body enters the frame only when the last message makes it act, and then only that part, with precise tags instead of "pov": {{user}}'s hands doing something to her ("I take her face in my hands") → "pov hands" plus the exact action tag (hand on another's cheek, holding another's wrist, grabbing another's breast, undressing another); a sex act that needs {{user}}'s body → count {{user}} ("1boy" plus "faceless male", or "faceless female") with the act and position tags, nothing more of him than the act needs. When {{user}} only looks, talks, listens, sits or lies there: no hands, no arms, no legs, no second person. Show the location, lighting and time of day.`;

const FRAME_SCENE = `a third-person shot of the scene, like a film still: {{user}} is NOT in the frame (no "pov" tag, no viewer's hands, no faceless partner standing for {{user}}); show the characters at the centre of the moment — what they are doing and what is being done to them — in their surroundings, framed around that interaction; the location, lighting and time of day.`;

export const PROMPT_TEMPLATES = {
    portrait: `${HEAD}
Draw {{char}} at this exact moment, {{char}} in focus. If {{char}} is doing something with someone (talking face to face, kissing, fighting, having sex), show that interaction and that partner, framed around it. If not, a portrait or upper body looking {{gaze}}, with the expression and clothing of this moment and the location softly behind.
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
    // Duplicates only add weight to one thing and crowd out the rest.
    const seen = new Set();
    tags = tags.filter((t) => { const k = t.toLowerCase(); if (t.split(/\s+/).length > 6) return true; if (seen.has(k)) return false; seen.add(k); return true; });
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

export function fill(t, vars) {
    return t.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
}

/** Feral characters drift into humans on anime models: push that away explicitly. */
export function negativeFor(prompt, base = '') {
    const extra = /\bferal\b/i.test(prompt) ? 'humanization, gijinka, anthro, humanoid, human face' : '';
    // The plain-English sentence at the end sometimes gets drawn as a caption.
    const noText = /\btext\b/i.test(base) ? '' : 'text, english text, caption, subtitles, speech bubble, signature';
    return [base, extra, noText].filter(Boolean).join(', ');
}

/* Style presets (research: Anima's default look is neutral; era and source tags give it a real anime look,
   "anime coloring" keeps it from glossy AI slop). */
export const STYLES = {
    // Bold lineart, flat colour, adult proportions (picked in tests against the user's references: tall bodies, no chibi).
    bold: 'masterpiece, best quality, newest, bold lineart, flat color, cel shading, shiny skin, warm colors, mature female, tall female, long legs, realistic proportions',
    flat: 'masterpiece, best quality, newest, flat color, bold lineart, thick lineart, simple shading, shiny skin, mature female, tall female, realistic proportions',
    vivid: 'masterpiece, best quality, newest, bold lineart, thick lineart, flat color, cel shading, glossy skin, saturated colors, warm palette, curvy, mature female, tall female, long legs',
    // Glossy modern fan-art look (picked from the user's references): thick clean outlines, shiny skin, warm vivid colour.
    glossy: 'masterpiece, best quality, newest, @novenine, shiny skin, thick outlines, cel shading, vibrant colors',
    glossy_plump: 'masterpiece, best quality, newest, @novenine, @zankuro, shiny skin, thick outlines, cel shading, vibrant colors',
    glossy_soft: 'masterpiece, best quality, newest, @novenine, @kenron toqueen, shiny skin, thick outlines, cel shading, vibrant colors',
    // Western digital art: thin lineart, flat shading with glossy highlights, muted colours, realistic proportions.
    western: 'masterpiece, best quality, newest, realistic proportions, lineart, flat shading, shiny skin, muted colors, realistic background, photo background',
    comic: 'masterpiece, best quality, newest, western comics (style), realistic, thin lineart, cel shading, shiny skin, muted colors, detailed background',
    semireal: 'masterpiece, best quality, newest, digital art, semi-realistic, clean lineart, soft cel shading, natural colors, glossy highlights, detailed realistic background',
    anime: 'masterpiece, best quality, newest, anime screenshot, anime coloring',
    art: 'masterpiece, best quality, newest, highres, official art',
};
/** Pushes the non-anime styles away from the anime look the model defaults to. */
const NO_SIGN = 'signature, artist name, twitter username, patreon username, watermark, logo';
const TALL = 'chibi, child, petite, short, big head, white outline, sticker';
const STYLE_NEGATIVE = { bold: `${NO_SIGN}, ${TALL}`, flat: `${NO_SIGN}, ${TALL}, gradient, soft shading`, vivid: `${NO_SIGN}, ${TALL}, anime screenshot, soft shading`, glossy: `${NO_SIGN}, chibi, big head`, glossy_plump: NO_SIGN, glossy_soft: NO_SIGN, western: 'anime screenshot, anime coloring, chibi', comic: 'anime screenshot, anime coloring, chibi', semireal: 'anime screenshot, chibi' };
export const styleNegative = (settings) => STYLE_NEGATIVE[settings?.style] || '';

export function stylePrefixFor(settings) {
    const base = settings.style === 'custom' ? (settings.stylePrefix || '') : (STYLES[settings.style] || STYLES.bold);
    const artist = String(settings.artist || '').trim();
    const at = artist ? (artist.startsWith('@') ? artist : `@${artist}`) : '';
    return [base.trim(), at].filter(Boolean).join(', ');
}


// ------------------------------------------------------------------ exact character tags

/** Splits the helper's two-line answer: { tag: "char tag, copyright tag" | "", look: "…" }. */
export function parseDna(out) {
    const text = String(out ?? '').trim();
    const clean = (x) => String(x || '').trim().replace(/^["'`\s]+|["'`.\s]+$/g, '').toLowerCase().replace(/_/g, ' ');
    let tag = clean(text.match(/^\s*TAG\s*:\s*(.+)$/im)?.[1]);
    if (/^(none|no|n\/a|-|original)\b/.test(tag)) tag = '';
    const look = String(text.match(/^\s*LOOK\s*:\s*(.+)$/im)?.[1] ?? text.split('\n').filter(l => !/^\s*TAG\s*:/i.test(l))[0] ?? '').trim().replace(/^["'`\s]+|["'`\s]+$/g, '');
    return { tag: tag.split(',').map(t => t.trim()).filter(Boolean).slice(0, 2).join(', '), look };
}

const words = (t) => String(t).toLowerCase().replace(/\(.*?\)/g, ' ').split(/[^a-z0-9а-яё:']+/i).filter(Boolean);
const META = /^(safe|sensitive|nsfw|explicit|questionable|general|\d\+?(girl|boy|other)s?|multiple (girls|boys|others)|solo|duo|trio|group|feral|no humans|human|anthro|furry( female| male)?|interspecies|quadruped|faceless (male|female)|hetero|yuri|yaoi)$/i;

/**
 * Puts the character's exact Danbooru tag into the prompt and removes shortened or respelled
 * versions of it ("asuka", "asuka langley"): a partial tag gives a look-alike.
 * exact = "character tag, copyright tag" (the copyright part is optional).
 */
export function enforceCharTag(prompt, exact) {
    const [charTag, seriesTag] = String(exact || '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
    if (!charTag) return prompt;
    const nameWords = words(charTag);
    if (!nameWords.length) return prompt;
    // the tags end where the plain-English sentence begins
    const parts = String(prompt).split(',').map(t => t.trim()).filter(Boolean);
    const isVariant = (t) => {
        const low = t.toLowerCase();
        if (low === charTag) return true;
        if (t.split(/\s+/).length > 5 || META.test(low)) return false;
        const w = words(low);
        return w.length > 0 && w.every(x => nameWords.includes(x));
    };
    const kept = parts.filter(t => !isVariant(t) && t.toLowerCase() !== seriesTag);
    let at = 0;
    while (at < kept.length && META.test(kept[at])) at++;
    kept.splice(at, 0, ...[charTag, seriesTag].filter(Boolean));
    return kept.join(', ');
}

// ------------------------------------------------------------------ first person without "pov"

/** The viewer's own body is in the picture (the helper asked for hands or a partner's body). */
export const viewerBody = (prompt) => /\bpov hands?\b|\bfaceless (male|female)\b/i.test(prompt);

/** Drops the bare "pov" tags: they make the model draw idle hands. Specific ones (pov hands) stay. */
export function firstPerson(prompt) {
    return String(prompt).split(',').map(t => t.trim()).filter(t => !/^(pov|first[- ]person( view)?|pov crotch)$/i.test(t)).join(', ');
}
