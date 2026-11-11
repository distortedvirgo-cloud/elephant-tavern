/*
 * Elephant Core — first-run setup.
 *
 * Replaces SillyTavern's "what's your name" popup with one screen: name,
 * NanoGPT key, and the models (text, helper, images) with sensible defaults.
 * It connects Chat Completion → NanoGPT right away, so the first chat works.
 * Also shown once to existing users who have no NanoGPT key yet.
 */
import { oai_settings } from '../../openai.js';
import { writeSecret, secret_state, readSecretState, SECRET_KEYS } from '../../secrets.js';
import { getPresetManager } from '../../preset-manager.js';
import { allowPresetScripts } from '../../extensions/regex/engine.js';
import { ctx, loadHelperModels, log } from '../stage/helper.js';

const $ = (...a) => globalThis.jQuery(...a);

export const DEFAULT_TEXT_MODEL = 'z-ai/glm-5.3';
export const DEFAULT_HELPER_MODEL = 'deepseek/deepseek-v4.1-flash-1017';
const OLD_TEXT_MODEL = 'xiaomi/mimo-v2.6-pro';
/** Bump when preset.json changes: it is (re)installed once per version. */
const PRESET_VERSION = '17';
const PRESET_NAME = 'Elephant Tavern';
export const DEFAULT_IMAGE_MODEL = 'anima/text-to-image';

const hasKey = () => Array.isArray(secret_state?.[SECRET_KEYS.NANOGPT]) ? secret_state[SECRET_KEYS.NANOGPT].length > 0 : Boolean(secret_state?.[SECRET_KEYS.NANOGPT]);

function html(name, withName) {
    return `
    <div id="ew-overlay" role="dialog" aria-modal="true">
        <div class="ew-card">
            <div class="ew-logo">🐘</div>
            <h2>Elephant Tavern</h2>
            <p class="ew-sub">Пара шагов — и можно играть.</p>
            ${withName ? `
            <label class="ew-field"><span>Как тебя зовут в историях?</span>
                <input id="ew_name" type="text" class="text_pole" value="${escapeHtml(name)}" maxlength="60" autocomplete="off">
            </label>` : ''}
            <label class="ew-field"><span>Ключ NanoGPT</span>
                <input id="ew_key" type="password" class="text_pole" placeholder="sk-nano-…" autocomplete="off">
                <small>Ключ берётся на <a href="https://nano-gpt.com/api" target="_blank" rel="noopener">nano-gpt.com/api</a>. Хранится только на этом устройстве.</small>
            </label>
            <details class="ew-more">
                <summary>Модели</summary>
                <label class="ew-field"><span>Рассказчик (основная модель)</span>
                    <input id="ew_text" type="text" class="text_pole" value="${DEFAULT_TEXT_MODEL}" list="ew_models" autocomplete="off">
                </label>
                <label class="ew-field"><span>Служебная (сцена, игра, память, промпты картинок) — пусто = как рассказчик</span>
                    <input id="ew_helper" type="text" class="text_pole" value="${DEFAULT_HELPER_MODEL}" list="ew_models" placeholder="например, дешёвая flash-модель" autocomplete="off">
                </label>
                <label class="ew-field"><span>Картинки</span>
                    <input id="ew_image" type="text" class="text_pole" value="${DEFAULT_IMAGE_MODEL}" autocomplete="off">
                </label>
                <datalist id="ew_models"></datalist>
                <small>Всё это меняется потом: «Подключение» и «Сцена и арт».</small>
            </details>
            <div class="ew-error" hidden></div>
            <button id="ew_go" class="ew-btn">Начать</button>
            <button id="ew_skip" class="ew-link">Пропустить — настрою сам</button>
        </div>
    </div>`;
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

async function fillModels() {
    try {
        const list = await loadHelperModels();
        $('#ew_models').html(list.map(m => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}${m.input != null ? ` · $${m.input} / $${m.output}` : ''}</option>`).join(''));
    } catch { /* offline — free text still works */ }
}

/** Points Chat Completion at NanoGPT with the chosen model and connects. */
async function connectNanoGpt(model) {
    oai_settings.chat_completion_source = 'nanogpt';
    if (model) oai_settings.nanogpt_model = model;
    $('#main_api').val('openai').trigger('change');
    $('#chat_completion_source').val('nanogpt').trigger('change');
    if (model) {
        const $sel = $('#model_nanogpt_select');
        if (!$sel.find(`option[value="${CSS.escape(model)}"]`).length) $sel.append($('<option>').val(model).text(model));
        $sel.val(model);
    }
    // Stock 300 tokens cut replies short, especially on reasoning models.
    if (!(Number(oai_settings.openai_max_tokens) >= 1200)) {
        oai_settings.openai_max_tokens = 1200;
        $('#openai_max_tokens').val(1200).trigger('input');
    }
    ctx().saveSettingsDebounced();
    await installPreset();
    setTimeout(() => $('#api_button_openai').trigger('click'), 300);
}

/** Fingerprint of what matters in a preset: prompt texts, their on/off state, samplers. */
function presetHash(p) {
    if (!p) return '';
    const order = p.prompt_order?.find(g => String(g.character_id) === '100001')?.order ?? p.prompt_order?.[0]?.order ?? [];
    const key = JSON.stringify([
        (p.prompts ?? []).map(x => [x.identifier, x.content ?? '', x.role ?? '', x.injection_position ?? 0, x.injection_depth ?? 0]),
        order.map(o => [o.identifier, Boolean(o.enabled)]),
        [p.temperature, p.top_p, p.openai_max_tokens, p.reasoning_effort, p.names_behavior],
    ]);
    let h = 5381;
    for (let i = 0; i < key.length; i++) h = ((h * 33) ^ key.charCodeAt(i)) >>> 0;
    return h.toString(36);
}

/**
 * Installs the bundled Elephant Tavern preset and selects it (once per PRESET_VERSION).
 * If the user changed the installed preset since, their copy stays: the new version is
 * saved next to it as "Elephant Tavern vN" and nothing is switched.
 */
export async function installPreset({ force = false } = {}) {
    if (!force && localStorage.getItem('et-preset-installed') === PRESET_VERSION) return false;
    try {
        const res = await fetch('scripts/elephant/welcome/preset.json', { cache: 'no-cache' });
        if (!res.ok) throw new Error(`preset ${res.status}`);
        const preset = await res.json();
        const pm = getPresetManager('openai');
        if (!pm) throw new Error('no preset manager');
        const { presets, preset_names } = pm.getPresetList('openai');
        const existing = preset_names?.[PRESET_NAME] !== undefined ? presets[preset_names[PRESET_NAME]] : null;
        const known = localStorage.getItem('et-preset-hash');
        const edited = existing && known && presetHash(existing) !== known;
        if (edited && !force) {
            const name = `${PRESET_NAME} v${PRESET_VERSION}`;
            const keep = pm.getSelectedPreset();
            await pm.savePreset(name, { ...preset, name });
            // Saving selects the new preset in the list; stay on the one the user was using.
            if (keep !== undefined && pm.getSelectedPreset() !== keep) await pm.selectPreset(keep);
            allowPresetScripts('openai', name);
            globalThis.toastr?.info(`Вышла новая версия пресета. Твой изменённый «${PRESET_NAME}» не тронут, новый лежит рядом: «${name}».`, 'Elephant Tavern', { timeOut: 12000 });
        } else {
            await pm.savePreset(PRESET_NAME, preset);
            allowPresetScripts('openai', PRESET_NAME);
            const value = pm.findPreset(PRESET_NAME);
            if (value !== undefined) await pm.selectPreset(value);
            localStorage.setItem('et-preset-hash', presetHash(preset));
        }
        localStorage.setItem('et-preset-installed', PRESET_VERSION);
        ctx().saveSettingsDebounced();
        return true;
    } catch (e) {
        log('preset install failed', e);
        return false;
    }
}

/** The story runs in English (best quality); the helper model translates both ways. */
function enableTranslation() {
    const es = ctx().extensionSettings;
    es.elephant_memory ??= {};
    es.elephant_memory.translateEnabled = true;
    es.elephant_memory.translateTarget ||= 'Russian';
    es.elephant_memory.translateInternal ||= 'English';
}

/** Existing installs: move the old default model to the new defaults, once. */
async function migrateDefaults() {
    if (localStorage.getItem('et-defaults') === '2') return;
    const es = ctx().extensionSettings;
    es.elephant_stage ??= {};
    const st = es.elephant_stage;
    if (!st.helperModel || st.helperModel === OLD_TEXT_MODEL) st.helperModel = DEFAULT_HELPER_MODEL;
    if (!oai_settings.nanogpt_model || oai_settings.nanogpt_model === OLD_TEXT_MODEL) {
        oai_settings.nanogpt_model = DEFAULT_TEXT_MODEL;
        const $sel = $('#model_nanogpt_select');
        if (!$sel.find(`option[value="${CSS.escape(DEFAULT_TEXT_MODEL)}"]`).length) $sel.append($('<option>').val(DEFAULT_TEXT_MODEL).text(DEFAULT_TEXT_MODEL));
        $sel.val(DEFAULT_TEXT_MODEL);
    }
    enableTranslation();
    localStorage.setItem('et-defaults', '2');
    ctx().saveSettingsDebounced();
}

/**
 * Shows the setup screen. Resolves with the chosen name (or null if skipped).
 * withName: the first-run variant that also names the persona.
 */
export function showWelcome({ name = 'User', withName = true } = {}) {
    return new Promise((resolve) => {
        $('#ew-overlay').remove();
        $('body').append(html(name, withName));
        fillModels();
        setTimeout(() => $(withName ? '#ew_name' : '#ew_key').trigger('focus'), 200);

        $('#ew_skip').on('click', () => {
            $('#ew-overlay').remove();
            localStorage.setItem('et-welcome-done', '1');
            resolve(withName ? String($('#ew_name').val() || name).trim() : null);
        });
        $('#ew_go').on('click', async function () {
            const key = String($('#ew_key').val() || '').trim();
            const userName = withName ? String($('#ew_name').val() || '').trim() : null;
            const text = String($('#ew_text').val() || '').trim();
            const helper = String($('#ew_helper').val() || '').trim();
            const image = String($('#ew_image').val() || '').trim();
            const $err = $('.ew-error');
            if (withName && !userName) { $err.text('Введи имя').prop('hidden', false); return; }
            if (!key && !hasKey()) { $err.text('Нужен ключ NanoGPT (или «Пропустить»)').prop('hidden', false); return; }
            this.disabled = true;
            this.textContent = 'Подключаю…';
            try {
                if (key) {
                    const id = await writeSecret(SECRET_KEYS.NANOGPT, key, 'Elephant Tavern');
                    if (!id) throw new Error('Не удалось сохранить ключ');
                }
                const es = ctx().extensionSettings;
                es.elephant_stage ??= {};
                es.elephant_stage.helperModel = helper || text;
                es.elephant_stage.images ??= {};
                if (image) es.elephant_stage.images.model = image;
                enableTranslation();
                await connectNanoGpt(text);
                localStorage.setItem('et-welcome-done', '1');
                $('#ew-overlay').addClass('ew-out');
                setTimeout(() => $('#ew-overlay').remove(), 350);
                resolve(userName);
            } catch (e) {
                $err.text(e.message || String(e)).prop('hidden', false);
                this.disabled = false;
                this.textContent = 'Начать';
            }
        });
    });
}

/** Called by SillyTavern's first-run onboarding instead of its name popup. */
export async function onboarding({ name }) {
    return showWelcome({ name, withName: true });
}

export async function init() {
    globalThis.ElephantCore = { ...(globalThis.ElephantCore || {}), onboarding, showWelcome };
    const ev = ctx().eventSource;
    const et = ctx().eventTypes ?? ctx().event_types;
    // Existing installs without a key: offer the key screen once.
    ev.once?.(et.APP_READY, async () => {
        try {
            await readSecretState();
            if (!hasKey() && !localStorage.getItem('et-welcome-done') && !document.getElementById('ew-overlay')) {
                await showWelcome({ withName: false });
            } else if (hasKey()) {
                await migrateDefaults();
                await installPreset();
            }
        } catch (e) {
            log('welcome check failed', e);
        }
    });
}
