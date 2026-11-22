import { ctx } from '../stage/helper.js';
import { settings, translateArtifactText } from '../memory/index.js';
import { hashText } from '../memory/translate.js';
import { renderMarkup } from './interaction.js';

const KEY = 'elephant_artifact_translations';
const MAX_SAVED = 8;
const rendered = new WeakMap();
const pending = new WeakMap();
const failed = new WeakMap();

function prepare(item, target) {
    const cached = rendered.get(item.pages);
    if (cached?.target === target && cached.title === item.title && cached.description === item.description && cached.utility === item.utility) return cached;

    const texts = [];
    const positions = new Map();
    function textIndex(value) {
        const text = value?.trim() || '';
        if (!/\p{L}/u.test(text)) return -1;
        if (!positions.has(text)) {
            positions.set(text, texts.length);
            texts.push(text);
        }
        return positions.get(text);
    }

    textIndex(item.title);
    textIndex(item.description);
    textIndex(item.utility);
    const actions = new Map(item.actions.map(action => [action.id, action]));
    const pages = item.pages.map(page => {
        textIndex(page.title);
        const root = document.createElement('div');
        renderMarkup(document, page.html, actions, root);
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
        const fields = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (node.nodeType === Node.TEXT_NODE) {
                const index = textIndex(node.textContent);
                if (index !== -1) fields.push({ node, index, original: node.textContent });
                continue;
            }
            for (const attribute of ['aria-label', 'title']) {
                const index = textIndex(node.getAttribute(attribute));
                if (index !== -1) fields.push({ node, index, attribute });
            }
        }
        return { page, root, fields };
    });
    const key = `${item.id}:${target}:${hashText(JSON.stringify(texts))}`;
    const recipe = { target, key, texts, title: item.title, description: item.description, utility: item.utility, pages, positions };
    rendered.set(item.pages, recipe);
    return recipe;
}

export function displayItem(item) {
    if (!item) return item;
    const s = settings();
    const metadata = ctx().chatMetadata;
    if (!s.translateEnabled || !s.translateIncoming || !metadata) return item;
    const recipe = prepare(item, s.translateTarget);
    const translations = metadata[KEY]?.[recipe.key];
    if (!Array.isArray(translations) || translations.length !== recipe.texts.length) return item;
    if (recipe.translations !== translations) {
        const translated = value => translations[recipe.positions.get(value)] || value;
        recipe.translations = translations;
        recipe.display = {
            title: translated(item.title),
            description: translated(item.description),
            utility: translated(item.utility),
            pages: recipe.pages.map(({ page, root, fields }) => {
                for (const { node, index, attribute, original } of fields) {
                    if (attribute) node.setAttribute(attribute, translations[index]);
                    else node.textContent = original.replace(original.trim(), () => translations[index]);
                }
                return { ...page, title: translated(page.title), html: root.innerHTML };
            }),
        };
    }
    return { ...item, ...recipe.display };
}

async function translateBatches(texts, tokenLimit, inChat) {
    // Bound each request, including older items with much denser generated pages.
    const limit = Math.max(200, Math.min(3200, Math.floor(Number(tokenLimit) || 3000)));
    const result = texts.map(() => []);
    let batch = [];
    let size = 0;

    async function flush() {
        if (!inChat()) return false;
        if (!batch.length) return true;
        const translated = await translateArtifactText(batch.map(entry => entry.text));
        batch.forEach((entry, index) => result[entry.index].push(translated[index]));
        batch = [];
        size = 0;
        return true;
    }

    for (const [index, text] of texts.entries()) {
        let rest = text;
        while (rest) {
            let split = Math.min(rest.length, limit);
            if (split < rest.length) {
                const word = rest.lastIndexOf(' ', split);
                if (word > split / 2) split = word;
            }
            if (size + split + 16 > limit && !await flush()) return null;
            batch.push({ index, text: rest.slice(0, split) });
            size += split + 16;
            rest = rest.slice(split).trimStart();
        }
    }
    if (!await flush()) return null;
    return result.map(parts => parts.join(' '));
}

export function requestItemTranslation(item, onComplete) {
    if (!item) return;
    const s = settings();
    const c = ctx();
    const metadata = c.chatMetadata;
    if (!s.translateEnabled || !s.translateIncoming || !metadata) return;
    const { key, texts } = prepare(item, s.translateTarget);
    if (!texts.length || metadata[KEY]?.[key]) return;
    let jobs = pending.get(metadata);
    if (!jobs) pending.set(metadata, jobs = new Map());
    if ((failed.get(metadata)?.get(key) || 0) > Date.now()) return;
    let job = jobs.get(key);
    if (!job) {
        const inChat = () => ctx().chatMetadata === metadata;
        job = translateBatches(texts, s.translateMaxTokens, inChat).then(translations => {
            if (!translations || !inChat()) return false;
            const cache = Object.entries({ ...metadata[KEY], [key]: translations }).slice(-MAX_SAVED);
            metadata[KEY] = Object.fromEntries(cache);
            void c.saveChat?.();
            return true;
        }).catch(error => {
            console.warn('[Elephant Artifact] translation failed', error);
            let cooldown = failed.get(metadata);
            if (!cooldown) failed.set(metadata, cooldown = new Map());
            cooldown.set(key, Date.now() + 30_000);
            return false;
        }).finally(() => jobs.delete(key));
        jobs.set(key, job);
        void job.then(success => { if (success) onComplete(); });
    }
}
