/*
 * Elephant Core — character forge.
 *
 * "Asuka from Evangelion, but she runs a night-shift ramen stand" or
 * "an original vampire librarian" → a complete character card (description,
 * personality, scenario, an opening scene, two alternate openings, example
 * dialogue, tags) written by the narrator model, plus an avatar from Anima
 * using Danbooru tags. Known characters stay faithful to canon; the image
 * model gets their exact character/copyright tags.
 */
import { oai_settings } from '../../openai.js';
import { ctx, toast, haptic, log } from '../stage/helper.js';
import { power_user } from '../../power-user.js';
import { initPersona, setUserAvatar, getUserAvatars } from '../../personas.js';
import { DNA_VERSION, stylePrefixFor, negativeFor, styleNegative } from '../stage/imagegen.js';

const $ = (...a) => globalThis.jQuery(...a);

const SYSTEM = 'You are a master character designer for interactive roleplay fiction. You know anime, manga, games, novels, films, comics and vtubers in depth. You output only JSON.';

const PROMPT = `Create a SillyTavern character card with an opening scene from this request:
<request>
{{request}}
</request>
{{extra}}
Rules:
- First decide: is this an EXISTING character from a franchise (anime, manga, game, light novel, film, series, comic, vtuber…)? If yes, be faithful to canon — appearance, personality, speech patterns, abilities, relationships, world — and change only what the request asks (an AU, a role, a setting); mention such changes in the scenario. If not, invent a vivid, specific original character that fits the request.
- All characters are adults (18+).
- Write the card in English. Refer to the character as {{char}} and to the player as {{user}} (literally these macros).
- description: 250–450 words — appearance; background; abilities; current situation; how {{char}} talks (2–3 sample lines); likes, dislikes; a secret or hidden motive.
- personality: one line of comma-separated traits.
- scenario: 2–4 sentences — where and when the story starts and who {{user}} is to {{char}}.
- first_mes: the opening scene. Close third person, present tense, 120–220 words, dialogue-driven, starts in the middle of a moment, ends on {{char}}'s own move or line, not on a question or an instruction to {{user}}. Never write {{user}}'s actions, words or thoughts.
- alternate_greetings: two different opening scenes with the same rules, 80–160 words each.
- mes_example: two short example exchanges, each starting with <START>, lines prefixed with {{user}}: and {{char}}:.
- abilities: 4–8 signature abilities, powers, tricks, resources or social weapons {{char}} can really use, each as "Name: what it does; when it makes a good scene (deception, seduction, protection, humor, escape, pressure…)". Faithful to canon for existing characters; no powers they don't have.
- agenda: 2–3 of {{char}}'s own motives or plans they would pursue without being asked, one sentence each.
- tags: 4–8 short lowercase tags (genre, mood, and the franchise if any).
- danbooru_tags: appearance tags for an anime image model, lowercase, spaces not underscores. For an existing character START with their exact Danbooru character tag and copyright tag (e.g. "souryuu asuka langley, neon genesis evangelion"), then the outfit/look of this version. For an original character: body type first, then hair (or mane), eyes, build, outfit, accessories. Body type: a human or human-looking character gets a count tag (1girl / 1boy / 1other); a feral, animal-bodied character (pony, dragon, cat, changeling…) gets "feral, no humans, <species>, quadruped, hooves/paws, tail" and never 1girl/1boy; an anthro gets "anthro, furry female/male". Canon characters keep their canon body type. Max 45 words.
- summary_ru: two sentences in Russian — who this is and how the story begins.

Reply with ONE JSON object:
{"name":"","is_canon":true,"franchise":"","danbooru_tags":"","description":"","personality":"","scenario":"","first_mes":"","alternate_greetings":["",""],"mes_example":"","abilities":[""],"agenda":[""],"tags":[],"summary_ru":""}`;

let draft = null;

function textModel() {
    const stage = ctx().extensionSettings?.elephant_stage ?? {};
    if (oai_settings.chat_completion_source === 'nanogpt' && oai_settings.nanogpt_model) return oai_settings.nanogpt_model;
    return stage.helperModel || '';
}

async function complete(model, user, maxTokens) {
    const res = await fetch('/api/elephant/complete', {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify({ model, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }], max_tokens: maxTokens, temperature: 0.9, json: true }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || `Ошибка модели (${res.status})`);
    return String(data.content || '');
}

function parseCard(text) {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('Модель не вернула карточку — попробуйте ещё раз');
    const o = JSON.parse(m[0]);
    if (!o.name || !o.description || !o.first_mes) throw new Error('Карточка неполная — попробуйте ещё раз');
    o.alternate_greetings = (Array.isArray(o.alternate_greetings) ? o.alternate_greetings : []).filter(x => typeof x === 'string' && x.trim()).slice(0, 3);
    o.tags = (Array.isArray(o.tags) ? o.tags : String(o.tags || '').split(',')).map(x => String(x).trim().toLowerCase()).filter(Boolean).slice(0, 8);
    o.danbooru_tags = String(o.danbooru_tags || '').replace(/_/g, ' ').trim();
    const lines = (v) => (Array.isArray(v) ? v : String(v || '').split('\n')).map(x => String(x).replace(/^[-*\s]+/, '').trim()).filter(Boolean);
    o.abilities = lines(o.abilities).slice(0, 8);
    o.agenda = lines(o.agenda).slice(0, 3);
    return o;
}

async function drawAvatar(card) {
    const stage = ctx().extensionSettings?.elephant_stage ?? {};
    const model = stage.images?.model || 'anima/text-to-image';
    const prefix = stylePrefixFor(stage.images ?? { style: 'glossy' });
    const prompt = `${prefix}, safe, ${card.danbooru_tags}, upper body, looking at viewer, portrait, detailed face, simple background`;
    const hires = stage.images?.hires !== false;
    const res = await fetch('/api/sd/nanogpt/generate', {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify({
            model, prompt,
            negative_prompt: [negativeFor(prompt, stage.images?.negative || 'worst quality, low quality, artist name, blurry, bad anatomy, bad hands, 3d, photorealistic'), styleNegative(stage.images)].filter(Boolean).join(', '),
            width: hires ? 1080 : 832, height: hires ? 1584 : 1216, resolution: hires ? '1080x1584' : '832x1216', nImages: 1, showExplicitContent: true,
        }),
    });
    if (!res.ok) {
        if (res.status === 400) throw new Error('Нет ключа NanoGPT');
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `NanoGPT вернул ошибку (${res.status})`);
    }
    const data = await res.json();
    if (!data?.image) throw new Error('Картинка не получилась');
    return data.image;
}

async function createCharacter(card, avatarB64) {
    const c = ctx();
    const fd = new FormData();
    fd.append('ch_name', card.name);
    fd.append('description', card.description);
    fd.append('personality', card.personality || '');
    fd.append('scenario', card.scenario || '');
    fd.append('first_mes', card.first_mes);
    fd.append('mes_example', card.mes_example || '');
    fd.append('creator_notes', `${card.summary_ru || ''}\n\nСоздано в Elephant Tavern${card.franchise ? ` · ${card.franchise}` : ''}.`);
    fd.append('creator', 'Elephant Tavern');
    fd.append('tags', card.tags.join(','));
    fd.append('talkativeness', '0.5');
    fd.append('fav', 'false');
    for (const g of card.alternate_greetings) fd.append('alternate_greetings', g);
    // The Director reads arsenal/agenda as the character's toolbox.
    fd.append('extensions', JSON.stringify({ elephant: {
        danbooru_tags: card.danbooru_tags, canon: Boolean(card.is_canon), franchise: card.franchise || '',
        arsenal: card.abilities.map(x => `- ${x}`).join('\n'), agenda: card.agenda.map(x => `- ${x}`).join('\n'),
    } }));
    if (avatarB64) {
        const bin = Uint8Array.from(atob(avatarB64), ch => ch.charCodeAt(0));
        fd.append('avatar', new File([bin], 'avatar.png', { type: avatarB64.startsWith('/9j/') ? 'image/jpeg' : 'image/png' }));
    }
    const res = await fetch('/api/characters/create', { method: 'POST', headers: c.getRequestHeaders({ omitContentType: true }), body: fd });
    if (!res.ok) throw new Error(`Не удалось сохранить персонажа (${res.status})`);
    const avatar = await res.text();
    await c.getCharacters();
    // The image model learns this character's look once — Stage keeps it consistent later.
    const stage = c.extensionSettings.elephant_stage;
    if (stage && card.danbooru_tags) {
        stage.dna ??= {};
        // Same cache versioning as stage/imagegen.js (DNA v2 knows feral/anthro bodies).
        if (stage.dna.__v !== DNA_VERSION) { for (const k of Object.keys(stage.dna)) delete stage.dna[k]; stage.dna.__v = DNA_VERSION; }
        stage.dna[avatar] = card.danbooru_tags;
        c.saveSettingsDebounced();
    }
    const idx = c.characters.findIndex(x => x.avatar === avatar);
    if (idx >= 0) await c.selectCharacterById(idx);
    return avatar;
}

// ------------------------------------------------------------------ persona for the open card
const PERSONA_PROMPT = `Create the PLAYER's persona for a roleplay with this character card. The persona is who {{user}} is in this story.
<card name="{{name}}">
{{card}}
</card>
<request>
{{request}}
</request>
Rules:
- The persona must fit THIS card: its world, era, tone and opening scene. If the card's scenario already says who {{user}} is to {{char}} (a role, a job, a relation), keep that and build on it. For a character from an existing franchise the persona fits the canon world: an original person in it, or the canon character the request names.
- Follow the request where it speaks (gender, role, look, personality, a canon character). Where it is silent or empty, invent a specific, playable protagonist who makes this story more interesting: a reason to be in the opening scene and a tie or tension with {{char}}.
- An adult (18+).
- Write in English. Refer to the player as {{user}} and to the card's character as {{char}} (literally these macros).
- name: a name that fits the setting{{name_rule}}.
- title: 2–5 words, the role in this story ("ship's new navigator").
- description: 120–200 words of plain facts the storyteller can use: gender and age; appearance and clothes; background and occupation; what {{user}} is good at and bad at; manner of speaking; who {{user}} is to {{char}} and what they want from each other. Only who {{user}} is: no events of the story, no lines of dialogue, nothing {{user}} will do or feel later.
- danbooru_tags: appearance tags for an anime image model, lowercase, spaces not underscores: count tag first (1boy / 1girl / 1other), then hair, eyes, build, outfit, accessories. For an existing franchise character start with their exact Danbooru character tag and copyright tag. Max 35 words.
- summary_ru: one or two sentences in Russian — who this is and what ties them to the character.

Reply with ONE JSON object:
{"name":"","title":"","description":"","danbooru_tags":"","summary_ru":""}`;

let pdraft = null;

function openCard() {
    const c = ctx();
    if (c.groupId) return null;
    const ch = c.characters?.[Number(c.characterId)];
    return ch?.avatar ? ch : null;
}

function cardText(ch) {
    const d = ch.data ?? ch;
    const cut = (s, n) => String(s || '').trim().slice(0, n);
    return [
        cut(d.description, 3500) && `Description:\n${cut(d.description, 3500)}`,
        cut(d.personality, 500) && `Personality: ${cut(d.personality, 500)}`,
        cut(d.scenario, 1200) && `Scenario: ${cut(d.scenario, 1200)}`,
        cut(d.first_mes, 1800) && `Opening scene:\n${cut(d.first_mes, 1800)}`,
    ].filter(Boolean).join('\n\n');
}

function parsePersona(text) {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('Модель не вернула персону — попробуйте ещё раз');
    const o = JSON.parse(m[0]);
    if (!o.name || !o.description) throw new Error('Персона неполная — попробуйте ещё раз');
    o.name = String(o.name).trim().slice(0, 40);
    o.title = String(o.title || '').trim().slice(0, 60);
    o.description = String(o.description).trim();
    o.danbooru_tags = String(o.danbooru_tags || '').replace(/_/g, ' ').trim();
    o.summary_ru = String(o.summary_ru || '').trim();
    return o;
}

async function savePersona(p, avatarB64, ch, link) {
    const c = ctx();
    const avatarId = `${Date.now()}-${p.name.replace(/[^a-zA-Z0-9]/g, '') || 'persona'}.png`;
    let file;
    if (avatarB64) {
        const bin = Uint8Array.from(atob(avatarB64), x => x.charCodeAt(0));
        file = new File([bin], 'avatar.png', { type: avatarB64.startsWith('/9j/') ? 'image/jpeg' : 'image/png' });
    } else {
        file = new File([await (await fetch('img/user-default.png')).blob()], 'avatar.png', { type: 'image/png' });
    }
    const fd = new FormData();
    fd.append('avatar', file);
    fd.append('overwrite_name', avatarId);
    const res = await fetch('/api/avatars/upload', { method: 'POST', headers: c.getRequestHeaders({ omitContentType: true }), cache: 'no-cache', body: fd });
    if (!res.ok) throw new Error(`Не удалось сохранить аватар персоны (${res.status})`);
    await initPersona(avatarId, p.name, p.description, p.title);
    if (link && ch?.avatar) {
        // one persona per card: the new one replaces an older link to this card
        for (const d of Object.values(power_user.persona_descriptions)) if (Array.isArray(d.connections)) d.connections = d.connections.filter(x => !(x.type === 'character' && x.id === ch.avatar));
        power_user.persona_descriptions[avatarId].connections = [{ type: 'character', id: ch.avatar }];
    }
    // the image model keeps the player's look for shots where both are in the frame
    const stage = c.extensionSettings.elephant_stage;
    if (stage && p.danbooru_tags) { stage.personaLook ??= {}; stage.personaLook[avatarId] = p.danbooru_tags; }
    c.saveSettingsDebounced();
    await getUserAvatars(true, avatarId);
    await setUserAvatar(avatarId, { toastPersonaNameChange: false });
    return avatarId;
}

function openPersona() {
    const ch = openCard();
    if (!ch) { toast().info('Откройте чат с персонажем — персона создаётся под конкретную карточку'); return; }
    ensureSheet();
    renderPersonaForm();
    $('#ef-sheet').addClass('ef-open');
    $('body').addClass('ef-sheet-open');
}

function renderPersonaForm(prev = {}) {
    const ch = openCard();
    $('#ef-sheet .ef-body').html(`
        <h3 class="ef-title">🧑 Персона для «${escapeHtml(ch?.name || '')}»</h3>
        <p class="ef-note">Кем ты будешь в этой истории? Модель прочитает карточку и придумает героя под её мир и первую сцену. Поле можно оставить пустым — тогда она выберет сама.</p>
        <textarea id="ef_p_request" class="text_pole" rows="4" placeholder="Например: «парень, наёмник с тёмным прошлым, её старый знакомый» или «новенькая в команде, наивная, но упрямая»">${escapeHtml(prev.request || '')}</textarea>
        <input id="ef_p_name" class="text_pole" type="text" maxlength="40" placeholder="Имя (необязательно)" value="${escapeHtml(prev.name || '')}">
        <label class="ef-check"><input type="checkbox" id="ef_p_avatar" ${prev.withAvatar === false ? '' : 'checked'}><span>Нарисовать аватар</span></label>
        <label class="ef-check"><input type="checkbox" id="ef_p_link" ${prev.link === false ? '' : 'checked'}><span>Привязать к этой карточке — будет включаться сама</span></label>
        <div class="ef-model">Модель текста: <b>${escapeHtml(textModel() || 'не выбрана')}</b></div>
        <button class="ef-btn" id="ef_p_go"><i class="fa-solid fa-wand-magic-sparkles"></i> Создать персону</button>`);
    $('#ef_p_go').on('click', generatePersona);
}

async function generatePersona() {
    const ch = openCard();
    if (!ch) return toast().info('Откройте чат с персонажем');
    const form = { request: String($('#ef_p_request').val() || '').trim(), name: String($('#ef_p_name').val() || '').trim(), withAvatar: $('#ef_p_avatar').prop('checked'), link: $('#ef_p_link').prop('checked') };
    const model = textModel();
    if (!model) return toast().warning('Подключите NanoGPT и выберите модель');
    try {
        progress(`Читаю карточку ${ch.name} и придумываю героя…`);
        const prompt = PERSONA_PROMPT.replace('{{name}}', ch.name).replace('{{card}}', cardText(ch))
            .replace('{{request}}', form.request || '(empty: choose what fits this card best)')
            .replace('{{name_rule}}', form.name ? `; the player chose "${form.name}", use exactly it` : '');
        const p = parsePersona(await complete(model, prompt, 1500));
        if (form.name) p.name = form.name;
        let avatar = null;
        if (form.withAvatar && p.danbooru_tags) {
            progress(`Рисую ${p.name}…`);
            try { avatar = await drawAvatar(p); } catch (e) { toast().warning(e.message); }
        }
        pdraft = { p, avatar, form, chAvatar: ch.avatar };
        renderPersonaPreview();
        haptic('heartbeat');
        log('persona forged', p.name, ch.name);
    } catch (e) {
        toast().error(e.message || String(e), 'Генератор');
        renderPersonaForm(form);
    } finally {
        $('#ef-sheet').removeClass('ef-busy');
    }
}

function renderPersonaPreview() {
    const { p, avatar, form } = pdraft;
    const ch = openCard();
    const img = avatar ? `data:image/${avatar.startsWith('/9j/') ? 'jpeg' : 'png'};base64,${avatar}` : '';
    $('#ef-sheet .ef-body').html(`
        <div class="ef-hero">
            ${img ? `<img src="${img}" alt="">` : '<div class="ef-noimg">🧑</div>'}
            <div><h3>${escapeHtml(p.name)}</h3>${p.title ? `<span class="ef-chip">${escapeHtml(p.title)}</span>` : ''}
            <p>${escapeHtml(p.summary_ru)}</p></div>
        </div>
        <label class="ef-lbl">Описание — можно поправить</label>
        <textarea id="ef_p_desc" class="text_pole" rows="9">${escapeHtml(p.description)}</textarea>
        <details class="ef-sec"><summary>Теги для картинок</summary><div class="ef-text">${escapeHtml(p.danbooru_tags)}</div></details>
        <button class="ef-btn" id="ef_p_save"><i class="fa-solid fa-check"></i> Сохранить и играть за ${escapeHtml(p.name)}</button>
        <div class="ef-row">
            <button class="ef-btn ef-ghost" id="ef_p_again"><i class="fa-solid fa-rotate"></i> Другой вариант</button>
            <button class="ef-btn ef-ghost" id="ef_p_redraw"><i class="fa-solid fa-image"></i> ${avatar ? 'Перерисовать' : 'Нарисовать'}</button>
        </div>
        <button class="ef-link" id="ef_p_edit">Изменить запрос</button>`);
    const keep = () => { pdraft.p.description = String($('#ef_p_desc').val() || '').trim() || pdraft.p.description; };
    $('#ef_p_save').on('click', async function () {
        keep();
        if (!ch || ch.avatar !== pdraft.chAvatar) return toast().warning('Открыта другая карточка — вернитесь к той, для которой создавалась персона');
        this.disabled = true;
        try {
            progress('Сохраняю персону…');
            await savePersona(pdraft.p, pdraft.avatar, ch, form.link);
            close();
            toast().success(`Теперь ты — ${pdraft.p.name}${form.link ? `. Персона привязана к «${ch.name}»` : ''}`);
            pdraft = null;
        } catch (e) {
            toast().error(e.message);
            renderPersonaPreview();
        } finally {
            $('#ef-sheet').removeClass('ef-busy');
        }
    });
    $('#ef_p_again').on('click', () => { renderPersonaForm(form); generatePersona(); });
    $('#ef_p_redraw').on('click', async () => {
        keep();
        try { progress(`Рисую ${pdraft.p.name}…`); pdraft.avatar = await drawAvatar(pdraft.p); } catch (e) { toast().warning(e.message); }
        $('#ef-sheet').removeClass('ef-busy');
        renderPersonaPreview();
    });
    $('#ef_p_edit').on('click', () => { keep(); renderPersonaForm(form); });
}

// ------------------------------------------------------------------ UI

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function ensureSheet() {
    if (document.getElementById('ef-sheet')) return;
    $('body').append('<div id="ef-scrim"></div><section id="ef-sheet" class="ef-sheet"><div class="ef-grip"></div><div class="ef-body"></div></section>');
    $('#ef-scrim').on('click', () => { if (!$('#ef-sheet').hasClass('ef-busy')) close(); });
}

function open() {
    ensureSheet();
    renderForm();
    $('#ef-sheet').addClass('ef-open');
    $('body').addClass('ef-sheet-open');
}

function close() {
    const was = $('#ef-sheet').hasClass('ef-open');
    $('#ef-sheet').removeClass('ef-open');
    $('body').removeClass('ef-sheet-open');
    return was;
}

function renderForm(prev = '') {
    $('#ef-sheet .ef-body').html(`
        <h3 class="ef-title">✨ Новый персонаж</h3>
        <p class="ef-note">Опиши, кого создать. Персонажей из аниме, игр, книг и фильмов модель знает — они останутся каноничными, а картинка подхватит их теги.</p>
        <textarea id="ef_request" class="text_pole" rows="4" placeholder="Например: «Рем из Re:Zero, но она капитан пиратского корабля» или «оригинальная вампирша-библиотекарь в дождливом Лондоне 1890-х»">${escapeHtml(prev)}</textarea>
        <textarea id="ef_scene" class="text_pole" rows="2" placeholder="С чего начать историю? (необязательно)"></textarea>
        <label class="ef-check"><input type="checkbox" id="ef_avatar" checked><span>Нарисовать аватар (${escapeHtml(ctx().extensionSettings?.elephant_stage?.images?.model || 'anima/text-to-image')})</span></label>
        <div class="ef-model">Модель текста: <b>${escapeHtml(textModel() || 'не выбрана')}</b></div>
        <button class="ef-btn" id="ef_go"><i class="fa-solid fa-wand-magic-sparkles"></i> Создать</button>`);
    $('#ef_go').on('click', generate);
}

function progress(text) {
    $('#ef-sheet').addClass('ef-busy');
    $('#ef-sheet .ef-body').html(`<div class="ef-progress"><div class="ef-orb"></div><b>${escapeHtml(text)}</b><small>Обычно 20–60 секунд</small></div>`);
}

async function generate() {
    const request = String($('#ef_request').val() || '').trim();
    const scene = String($('#ef_scene').val() || '').trim();
    const withAvatar = $('#ef_avatar').prop('checked');
    if (!request) return toast().info('Опиши персонажа');
    const model = textModel();
    if (!model) return toast().warning('Подключите NanoGPT и выберите модель');
    try {
        progress('Пишу карточку и первую сцену…');
        const c = ctx();
        const extra = scene ? `Opening scene wish: ${scene}\n` : '';
        const prompt = PROMPT.replace('{{request}}', request).replace('{{extra}}', extra);
        const card = parseCard(await complete(model, prompt, 4000));
        let avatar = null;
        if (withAvatar) {
            progress(`Рисую ${card.name}…`);
            try { avatar = await drawAvatar(card); } catch (e) { toast().warning(e.message); }
        }
        draft = { card, avatar, request, scene, withAvatar };
        renderPreview();
        haptic('heartbeat');
        log('forged', card.name, c.name1);
    } catch (e) {
        toast().error(e.message || String(e), 'Генератор');
        renderForm(request);
    } finally {
        $('#ef-sheet').removeClass('ef-busy');
    }
}

function renderPreview() {
    const { card, avatar } = draft;
    const img = avatar ? `data:image/${avatar.startsWith('/9j/') ? 'jpeg' : 'png'};base64,${avatar}` : '';
    $('#ef-sheet .ef-body').html(`
        <div class="ef-hero">
            ${img ? `<img src="${img}" alt="">` : '<div class="ef-noimg">🎭</div>'}
            <div><h3>${escapeHtml(card.name)}</h3>${card.franchise ? `<span class="ef-chip">${escapeHtml(card.franchise)}</span>` : '<span class="ef-chip">оригинальный</span>'}
            <p>${escapeHtml(card.summary_ru || '')}</p></div>
        </div>
        <div class="ef-tags">${card.tags.map(t => `<span>${escapeHtml(t)}</span>`).join('')}</div>
        <details class="ef-sec" open><summary>Первая сцена</summary><div class="ef-text">${escapeHtml(card.first_mes)}</div></details>
        <details class="ef-sec"><summary>Описание</summary><div class="ef-text">${escapeHtml(card.description)}</div></details>
        ${card.abilities.length ? `<details class="ef-sec"><summary>Способности и цели</summary><div class="ef-text">${card.abilities.map(x => '• ' + escapeHtml(x)).join('\n')}${card.agenda.length ? '\n\n<b>Цели:</b>\n' + card.agenda.map(x => '• ' + escapeHtml(x)).join('\n') : ''}</div></details>` : ''}
        <details class="ef-sec"><summary>Сценарий и характер</summary><div class="ef-text"><b>Сценарий:</b> ${escapeHtml(card.scenario)}\n\n<b>Характер:</b> ${escapeHtml(card.personality)}</div></details>
        ${card.alternate_greetings.length ? `<details class="ef-sec"><summary>Другие начала (${card.alternate_greetings.length})</summary><div class="ef-text">${card.alternate_greetings.map(escapeHtml).join('\n\n———\n\n')}</div></details>` : ''}
        <details class="ef-sec"><summary>Теги для картинок</summary><div class="ef-text">${escapeHtml(card.danbooru_tags)}</div></details>
        <button class="ef-btn" id="ef_create"><i class="fa-solid fa-play"></i> Создать и начать</button>
        <div class="ef-row">
            <button class="ef-btn ef-ghost" id="ef_again"><i class="fa-solid fa-rotate"></i> Другой вариант</button>
            <button class="ef-btn ef-ghost" id="ef_redraw"><i class="fa-solid fa-image"></i> Перерисовать</button>
        </div>
        <button class="ef-link" id="ef_edit">Изменить запрос</button>`);
    $('#ef_create').on('click', async function () {
        this.disabled = true;
        try {
            progress('Сохраняю персонажа…');
            await createCharacter(draft.card, draft.avatar);
            close();
            toast().success(`${draft.card.name} готов(а) — история начинается`);
            draft = null;
        } catch (e) {
            toast().error(e.message);
            renderPreview();
        } finally {
            $('#ef-sheet').removeClass('ef-busy');
        }
    });
    $('#ef_again').on('click', () => { renderForm(draft.request); $('#ef_scene').val(draft.scene); generate(); });
    $('#ef_redraw').on('click', async () => {
        try { progress(`Рисую ${draft.card.name}…`); draft.avatar = await drawAvatar(draft.card); } catch (e) { toast().warning(e.message); }
        $('#ef-sheet').removeClass('ef-busy');
        renderPreview();
    });
    $('#ef_edit').on('click', () => renderForm(draft.request));
}

function addHubTile() {
    const $tiles = $('#et-sheet-hub .et-tiles');
    if (!$tiles.length || $tiles.find('[data-ef-tile]').length) return;
    const $t = $('<button class="et-tile" data-ef-tile><i class="fa-solid fa-user-plus"></i><span>Создать персонажа</span></button>');
    $t.on('click', () => { globalThis.ElephantStage?.closeSheets?.(true); open(); });
    $tiles.prepend($t);
    const $p = $('<button class="et-tile" data-ef-tile="persona"><i class="fa-solid fa-user-pen"></i><span>Персона для карточки</span></button>');
    $p.on('click', () => { globalThis.ElephantStage?.closeSheets?.(true); openPersona(); });
    $t.after($p);
}

export async function init() {
    addHubTile();
    setTimeout(addHubTile, 1500);
    const c = ctx();
    if (c.SlashCommandParser && c.SlashCommand) {
        c.SlashCommandParser.addCommandObject(c.SlashCommand.fromProps({ name: 'forge', helpString: 'Elephant: генератор персонажей.', callback: async () => { open(); return ''; } }));
        c.SlashCommandParser.addCommandObject(c.SlashCommand.fromProps({ name: 'forge-persona', helpString: 'Elephant: персона игрока для открытой карточки.', callback: async () => { openPersona(); return ''; } }));
    }
    const st = globalThis.ElephantStage;
    if (st && !st.__efBack) {
        const original = st.handleBack;
        st.handleBack = () => ($('#ef-sheet').hasClass('ef-busy') ? true : close()) || original();
        st.__efBack = true;
    }
    globalThis.ElephantCore = { ...(globalThis.ElephantCore || {}), forge: { open, parseCard, openPersona, parsePersona } };
}
