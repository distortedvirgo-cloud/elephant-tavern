/*
 * Elephant Core — take a story with you.
 *
 * "Выгрузить чат" packs the current chat into one file: the character card
 * (PNG with all its data), the whole chat file (messages, translations, game
 * state, voice colours, memory — everything SillyTavern keeps in the .jsonl)
 * and what the app knows about the character (image look, director toolbox,
 * power level). "Загрузить чат" brings such a file back on any install: the
 * character is created (or reused) and the chat opens where it stopped.
 */
import { ctx, toast, log } from '../stage/helper.js';

const $ = (...a) => globalThis.jQuery(...a);
const FORMAT = 'elephant-chat';

const toBase64 = (buf) => {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
};
const fromBase64 = (b64) => Uint8Array.from(atob(b64), ch => ch.charCodeAt(0));
const utf8ToBase64 = (text) => toBase64(new TextEncoder().encode(text));
const safeName = (s) => String(s || 'chat').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 60);

function post(url, body) {
    return fetch(url, { method: 'POST', headers: ctx().getRequestHeaders(), body: JSON.stringify(body) });
}

function extrasFor(avatar) {
    const es = ctx().extensionSettings;
    return {
        dna: es.elephant_stage?.dna?.[avatar] ?? null,
        arsenal: es.elephant_director?.arsenal?.[avatar] ?? null,
        power: es.elephant_power?.perChar?.[avatar] ?? null,
    };
}

function restoreExtras(avatar, extras = {}) {
    const es = ctx().extensionSettings;
    if (extras.dna && es.elephant_stage) { es.elephant_stage.dna ??= {}; es.elephant_stage.dna[avatar] = extras.dna; }
    if (extras.arsenal && es.elephant_director) { es.elephant_director.arsenal ??= {}; es.elephant_director.arsenal[avatar] = extras.arsenal; }
    if (extras.power && es.elephant_power) { es.elephant_power.perChar ??= {}; es.elephant_power.perChar[avatar] = extras.power; }
    ctx().saveSettingsDebounced();
}

function saveFile(text, name) {
    if (globalThis.ElephantApp?.saveFile) {
        globalThis.ElephantApp.saveFile(utf8ToBase64(text), name, 'application/json');
        return;
    }
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ------------------------------------------------------------------ export

export async function exportCurrentChat() {
    const c = ctx();
    if (c.groupId) return toast().info('Групповые чаты пока не выгружаются');
    const ch = c.characters?.[c.characterId];
    if (!ch) return toast().info('Сначала открой чат с персонажем');
    try {
        await c.saveChat?.();
        const pngRes = await post('/api/characters/export', { format: 'png', avatar_url: ch.avatar });
        if (!pngRes.ok) throw new Error(`карточка: ${pngRes.status}`);
        const png = toBase64(await pngRes.arrayBuffer());
        const chatRes = await post('/api/chats/export', { is_group: false, avatar_url: ch.avatar, file: `${ch.chat}.jsonl`, exportfilename: `${ch.chat}.jsonl`, format: 'jsonl' });
        const chatData = await chatRes.json().catch(() => ({}));
        if (!chatRes.ok || typeof chatData.result !== 'string') throw new Error(chatData.message || `чат: ${chatRes.status}`);
        const bundle = {
            format: FORMAT,
            version: 1,
            app: 'Elephant Tavern',
            exported: new Date().toISOString(),
            character: { name: ch.name, avatar: ch.avatar, png },
            chat: { name: ch.chat, messages: (c.chat ?? []).length, jsonl: chatData.result },
            extras: extrasFor(ch.avatar),
        };
        const date = new Date().toLocaleDateString('sv-SE');
        saveFile(JSON.stringify(bundle), `${safeName(ch.name)} — ${date}.etchat.json`);
        toast().success(`Чат с ${ch.name} выгружен вместе с карточкой`, 'Elephant Tavern');
    } catch (e) {
        log('export failed', e);
        toast().error(String(e.message || e), 'Не удалось выгрузить чат');
    }
}

// ------------------------------------------------------------------ import

export async function importBundle(file) {
    const c = ctx();
    let bundle;
    try {
        bundle = JSON.parse(await file.text());
    } catch {
        return toast().error('Это не файл чата Elephant Tavern');
    }
    if (bundle?.format !== FORMAT || !bundle.character?.png || !bundle.chat?.jsonl) {
        return toast().error('Это не файл чата Elephant Tavern');
    }
    try {
        const name = bundle.character.name;
        let avatar = null;
        const existing = (c.characters ?? []).filter(x => x.name === name);
        if (existing.length) {
            const reuse = await c.Popup.show.confirm('Персонаж уже есть',
                `«${name}» уже есть в приложении. Добавить чат к нему? «Нет» создаст копию персонажа из файла.`,
                { okButton: 'Добавить к нему', cancelButton: 'Создать копию' });
            if (reuse) avatar = (existing.find(x => x.avatar === bundle.character.avatar) ?? existing[0]).avatar;
        }
        if (!avatar) {
            const fd = new FormData();
            fd.append('file_type', 'png');
            fd.append('avatar', new File([fromBase64(bundle.character.png)], bundle.character.avatar || 'character.png', { type: 'image/png' }));
            const res = await fetch('/api/characters/import', { method: 'POST', headers: c.getRequestHeaders({ omitContentType: true }), body: fd });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data.error || !data.file_name) throw new Error('не удалось создать персонажа');
            avatar = String(data.file_name).endsWith('.png') ? data.file_name : `${data.file_name}.png`;
            await c.getCharacters();
        }
        restoreExtras(avatar, bundle.extras);

        // Text fields go before the file: the server reads them while the upload streams in.
        const fd = new FormData();
        fd.append('file_type', 'jsonl');
        fd.append('avatar_url', avatar);
        fd.append('character_name', name);
        fd.append('user_name', c.name1);
        fd.append('avatar', new File([bundle.chat.jsonl], 'chat.jsonl', { type: 'application/jsonl' }));
        const res = await fetch('/api/chats/import', { method: 'POST', headers: c.getRequestHeaders({ omitContentType: true }), body: fd });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error || !data.fileNames?.length) throw new Error('не удалось загрузить переписку');

        const idx = (ctx().characters ?? []).findIndex(x => x.avatar === avatar);
        if (idx < 0) throw new Error('персонаж не найден после импорта');
        await ctx().selectCharacterById(idx);
        await ctx().openCharacterChat(String(data.fileNames[0]).replace(/\.jsonl$/, ''));
        toast().success(`Чат с ${name} загружен (${bundle.chat.messages ?? '?'} сообщений)`, 'Elephant Tavern');
    } catch (e) {
        log('import failed', e);
        toast().error(String(e.message || e), 'Не удалось загрузить чат');
    }
}

export function pickBundle() {
    let $in = $('#et-chat-import');
    if (!$in.length) {
        $in = $('<input type="file" id="et-chat-import" accept=".json,.etchat,application/json" hidden>').appendTo('body');
        $in.on('change', function () {
            const f = this.files?.[0];
            this.value = '';
            if (f) importBundle(f);
        });
    }
    $in.trigger('click');
}

export async function init() {
    globalThis.ElephantCore = { ...(globalThis.ElephantCore || {}), transfer: { exportCurrentChat, importBundle, pickBundle } };
}
