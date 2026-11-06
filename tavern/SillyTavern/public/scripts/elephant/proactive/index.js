/*
 * Elephant Core — "the character writes first", client side.
 *
 *  • keeps the server's snapshot of the open chat fresh (card, Elephant Memory
 *    state card, last messages) and tells it when the user answers;
 *  • delivers messages the server wrote while the app was closed: into the
 *    open chat directly, or as a tap-to-open toast for another chat;
 *  • the per-character settings block in «Сцена и арт».
 */
import { ctx, log, toast, memoryState, currentCharacter, loadHelperModels } from '../stage/helper.js';
import { getMessageTimeStamp } from '../../RossAscends-mods.js';

const $ = (...a) => globalThis.jQuery(...a);
const post = async (url, body = {}) => {
    const res = await fetch(url, { method: 'POST', headers: ctx().getRequestHeaders(), body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || `${url}: ${res.status}`);
    return data;
};

function snapshot() {
    const c = ctx();
    const ch = currentCharacter();
    if (!ch || ch.group) return null;
    const card = [ch.description, ch.personality && `Personality: ${ch.personality}`, ch.scenario && `Scenario: ${ch.scenario}`].filter(Boolean).join('\n\n');
    return {
        key: ch.key,
        snapshot: {
            charName: c.name2,
            userName: c.name1,
            chatFile: c.getCurrentChatId?.() ?? '',
            card: card.slice(0, 4000),
            state: memoryState().slice(0, 4000),
            messages: (c.chat ?? []).filter(m => !m.is_system && m.mes).slice(-8).map(m => ({ name: m.name, is_user: m.is_user, mes: String(m.mes).replace(/<[^>]+>/g, '').slice(0, 800) })),
        },
    };
}

let touchTimer = null;
let pendingUserActive = false;
function touch(userActive = false) {
    pendingUserActive ||= userActive;
    clearTimeout(touchTimer);
    touchTimer = setTimeout(async () => {
        const snap = snapshot();
        const active = pendingUserActive;
        pendingUserActive = false;
        if (!snap) return;
        try { await post('/api/elephant/proactive/touch', { ...snap, userActive: active }); } catch (e) { log('touch failed', e.message); }
    }, 2500);
}

// ------------------------------------------------------------------ inbox

let delivering = false;
export async function deliverInbox() {
    if (delivering) return;
    delivering = true;
    try {
        const c = ctx();
        const items = await post('/api/elephant/inbox');
        if (!items.length) return;
        const ch = currentCharacter();
        const chatFile = c.getCurrentChatId?.();
        const here = items.filter(x => ch && x.key === ch.key && x.chatFile === chatFile);
        const elsewhere = items.filter(x => !here.includes(x));
        for (const item of here) {
            const message = {
                name: c.name2,
                is_user: false,
                is_system: false,
                send_date: getMessageTimeStamp(),
                mes: item.en,
                extra: { elephant_proactive: { id: item.id, created: item.created } },
            };
            c.chat.push(message);
            c.addOneMessage(message);
            await c.eventSource.emit(c.eventTypes.MESSAGE_RECEIVED, c.chat.length - 1, 'extension');
            await c.eventSource.emit(c.eventTypes.CHARACTER_MESSAGE_RENDERED, c.chat.length - 1, 'extension');
        }
        if (here.length) {
            await c.saveChat();
            await post('/api/elephant/inbox/ack', { ids: here.map(x => x.id) });
            globalThis.ElephantApp?.haptic?.('heartbeat');
        }
        const seen = new Set(JSON.parse(sessionStorage.getItem('et-inbox-toasted') || '[]'));
        for (const item of elsewhere) {
            if (seen.has(item.id)) continue;
            seen.add(item.id);
            const t = toast().info(`${item.ru}`, `📩 ${item.charName}`, { timeOut: 12000, extendedTimeOut: 6000, tapToDismiss: false });
            $(t).on('click', () => { t.remove?.(); openChat(item.key, item.chatFile); });
        }
        try { sessionStorage.setItem('et-inbox-toasted', JSON.stringify([...seen])); } catch { /* */ }
    } catch (e) {
        log('inbox failed', e.message);
    } finally {
        delivering = false;
    }
}

/** Opens a character's chat (from a notification or a toast) and delivers its messages. */
export async function openChat(key, chatFile) {
    const c = ctx();
    const idx = c.characters.findIndex(x => x.avatar === key);
    if (idx < 0) return toast().warning('Персонаж не найден');
    if (String(c.characterId) !== String(idx)) await c.selectCharacterById(idx);
    if (chatFile && c.getCurrentChatId?.() !== chatFile) {
        try { await c.openCharacterChat(chatFile); } catch (e) { log('open chat failed', e); }
    }
    await deliverInbox();
}

// ------------------------------------------------------------------ settings block («Сцена и арт»)

async function refreshSettingsBlock() {
    const $b = $('#et_pa_block');
    if (!$b.length) return;
    const ch = currentCharacter();
    if (!ch || ch.group) { $b.find('.et-pa-body').hide(); $b.find('.et-pa-none').show(); return; }
    $b.find('.et-pa-none').hide();
    $b.find('.et-pa-body').show();
    $b.find('#et_pa_name').text(ch.name);
    try {
        const { entry, model } = await post('/api/elephant/proactive/get', { key: ch.key });
        $('#et_pa_enabled').prop('checked', Boolean(entry?.enabled));
        $('#et_pa_freq').val(entry?.frequency || 'normal');
        $('#et_pa_qfrom').val(entry?.quietFrom ?? 23);
        $('#et_pa_qto').val(entry?.quietTo ?? 9);
        const $m = $('#et_pa_model');
        if (!$m.data('loaded')) {
            const list = await loadHelperModels().catch(() => []);
            $m.empty().append('<option value="">— та же служебная модель —</option>');
            list.sort((a, b) => (a.input ?? 99) - (b.input ?? 99));
            for (const x of list) $m.append($('<option>').val(x.id).text(`${x.name} · $${x.input ?? '?'} / $${x.output ?? '?'}`));
            $m.data('loaded', true);
        }
        $m.val(model && model !== ctx().extensionSettings?.elephant_stage?.helperModel ? model : '');
        $('#et_pa_status').text(entry?.lastProactive ? `Последнее сообщение: ${new Date(entry.lastProactive).toLocaleString()}` : '');
    } catch (e) {
        $('#et_pa_status').text(e.message);
    }
}

async function saveSettingsBlock() {
    const ch = currentCharacter();
    if (!ch || ch.group) return;
    const helper = ctx().extensionSettings?.elephant_stage?.helperModel || '';
    const enabled = $('#et_pa_enabled').prop('checked');
    try {
        await post('/api/elephant/proactive/set', {
            key: ch.key,
            enabled,
            frequency: $('#et_pa_freq').val(),
            quietFrom: Number($('#et_pa_qfrom').val()),
            quietTo: Number($('#et_pa_qto').val()),
            model: $('#et_pa_model').val() || helper,
        });
        if (enabled) touch(true);
        if (enabled && !($('#et_pa_model').val() || helper)) toast().warning('Выберите служебную модель или модель для сообщений');
    } catch (e) {
        toast().error(e.message);
    }
}

// ------------------------------------------------------------------ init

export async function init() {
    const c = ctx();
    const ev = c.eventSource;
    const et = c.eventTypes ?? c.event_types;
    ev.on(et.CHAT_CHANGED, () => { touch(false); setTimeout(deliverInbox, 600); });
    if (et.MESSAGE_SENT) ev.on(et.MESSAGE_SENT, () => touch(true));
    ev.on(et.MESSAGE_RECEIVED, (_id, type) => { if (type !== 'extension') touch(false); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) deliverInbox(); });
    setInterval(() => { if (!document.hidden) deliverInbox(); }, 60_000);

    document.addEventListener('et-settings-refresh', refreshSettingsBlock);
    $(document).on('change', '#et_pa_enabled, #et_pa_freq, #et_pa_qfrom, #et_pa_qto, #et_pa_model', saveSettingsBlock);
    $(document).on('click', '#et_pa_now', async function () {
        const ch = currentCharacter();
        if (!ch || ch.group) return;
        this.disabled = true;
        try {
            await saveSettingsBlock();
            touch(false);
            await new Promise(r => setTimeout(r, 2800));
            const item = await post('/api/elephant/proactive/now', { key: ch.key });
            toast().success(item.ru, `📩 ${item.charName}`);
            await deliverInbox();
        } catch (e) {
            toast().error(e.message);
        } finally {
            this.disabled = false;
        }
    });

    globalThis.ElephantCore = { ...(globalThis.ElephantCore || {}), openChat, deliverInbox };
    setTimeout(deliverInbox, 3000);
}
