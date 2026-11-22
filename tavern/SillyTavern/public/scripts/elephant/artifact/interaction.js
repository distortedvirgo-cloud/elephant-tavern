import { artifactTimelineKeys } from './store.js';
import {
    chat_metadata, eventSource, event_types, generateQuietPrompt, getCurrentChatId,
    isGenerating, online_status, saveMetadata, sendTextareaMessage,
} from '../../../script.js';

const THREADS = 'elephant_artifact_threads';
const TAGS = new Set('article aside b blockquote br button caption code dd details div dl dt em figcaption figure footer h1 h2 h3 h4 h5 h6 header hr i kbd li main mark nav ol p pre s section small span strong sub summary sup table tbody td th thead tr u ul'.split(' '));
const ATTRIBUTES = new Set(['class', 'id', 'title', 'aria-label', 'aria-hidden', 'colspan', 'rowspan']);
const FRAME_DOCUMENT = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"></head><body></body></html>`;

function element(tag, text = '', className = '') {
    const node = document.createElement(tag);
    node.textContent = text;
    node.className = className;
    return node;
}

/**
 * Rebuild markup from inert input, including only presentation and declared actions.
 * The frame does not run scripts and CSP blocks all subresource requests.
 */
function renderMarkup(doc, html, actions) {
    const template = document.createElement('template');
    template.innerHTML = html;
    function copyChildren(source, destination) {
        for (const child of source.childNodes) {
            if (child.nodeType === Node.TEXT_NODE) {
                destination.append(doc.createTextNode(child.textContent));
                continue;
            }
            if (child.namespaceURI !== 'http://www.w3.org/1999/xhtml') continue;
            const tag = child.localName;
            const actionId = child.getAttribute('data-action');
            if (!TAGS.has(tag) && tag !== 'a') continue;
            const node = doc.createElement(tag === 'a' ? (actions.has(actionId) ? 'button' : 'span') : tag);
            for (const attr of child.attributes) {
                if (ATTRIBUTES.has(attr.name)) node.setAttribute(attr.name, attr.value);
            }
            node.style.cssText = child.getAttribute('style') || '';
            if (node.localName === 'button') {
                node.type = 'button';
                node.disabled = !actions.has(actionId);
            }
            if (tag === 'details' && child.hasAttribute('open')) node.open = true;
            if (actions.has(actionId)) {
                node.dataset.action = actionId;
                if (node.localName !== 'button') {
                    node.setAttribute('role', 'button');
                    node.tabIndex = 0;
                }
            }
            copyChildren(child, node);
            destination.append(node);
        }
    }
    copyChildren(template.content, doc.body);
}

function renderStyles(doc, css) {
    const parsed = new CSSStyleSheet();
    // Constructed stylesheets ignore @import. Use CSSOM output and textContent so
    // model text cannot terminate the style element or introduce HTML.
    parsed.replaceSync(css);
    const style = doc.createElement('style');
    style.textContent = `body { margin: 0; padding: 1rem; font: 16px system-ui, sans-serif; overflow-wrap: anywhere; }
[data-action]:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
${Array.from(parsed.cssRules, rule => rule.cssText).join('\n')}
html, body { min-width: 0 !important; max-width: 100% !important; }
body * { box-sizing: border-box !important; min-width: 0 !important; max-width: 100% !important; }
body, body * { overflow-wrap: anywhere !important; }
pre { white-space: pre-wrap !important; }
[data-action] { white-space: normal !important; }
`;
    doc.head.append(style);
}

function setComposerValue(composer, value) {
    composer.value = value;
    composer.dispatchEvent(new Event('input', { bubbles: true }));
}

async function sendIntent(text, inChat) {
    const composer = document.getElementById('send_textarea');
    if (!composer || !inChat()) return;
    const draft = composer.value;
    const start = composer.selectionStart;
    const end = composer.selectionEnd;
    const direction = composer.selectionDirection;
    let consumed = false;
    const restore = () => {
        if (!inChat() || composer.value !== '') return;
        composer.removeEventListener('input', restore);
        consumed = true;
        setComposerValue(composer, draft);
        composer.setSelectionRange(start, end, direction);
    };
    setComposerValue(composer, text);
    composer.addEventListener('input', restore);
    try {
        await sendTextareaMessage();
        return consumed;
    } finally {
        composer.removeEventListener('input', restore);
        if (!consumed && inChat() && composer.value === text) {
            setComposerValue(composer, draft);
            composer.setSelectionRange(start, end, direction);
        }
    }
}

function findThread(metadata, itemId, recipient, create = false) {
    if (!Array.isArray(metadata[THREADS])) {
        if (!create) return;
        metadata[THREADS] = [];
    }
    const threads = metadata[THREADS];
    let thread = threads.find(entry => entry?.itemId === itemId && entry.recipient === recipient && Array.isArray(entry.messages));
    if (!thread && create) {
        thread = { itemId, recipient, messages: [] };
        threads.push(thread);
    }
    return thread;
}

export function createArtifactInteraction({ host, onPageChange }) {
    const drafts = new Map();
    let draftTimer;
    let scope;
    let view;
    let threadView;
    let sending;

    const inChat = candidate => Boolean(candidate?.chatId && candidate.chatId === getCurrentChatId() && candidate.metadata === chat_metadata);

    function close() {
        view = undefined;
        threadView = undefined;
        host.replaceChildren();
    }

    function chatChanged() {
        if (inChat(scope)) return;
        drafts.clear();
        close();
    }
    eventSource.on(event_types.CHAT_CHANGED, chatChanged);

    function render(artifact, { itemId = artifact?.id, onClose } = {}) {
        chatChanged();
        if (!artifact || !host.isConnected) return close();
        scope = { chatId: getCurrentChatId(), metadata: chat_metadata };
        view = { artifact, itemId, onClose, scope, actions: new Map(artifact.actions.map(action => [action.id, action])) };
        threadView = undefined;
        renderPage();
    }

    function renderPage(pageId = view.artifact.pageId) {
        const current = view;
        const page = current.artifact.pages.find(entry => entry.id === pageId) || current.artifact.pages[0];
        const iframe = document.createElement('iframe');
        iframe.className = 'elephant-artifact-frame';
        iframe.title = page?.title || current.artifact.title;
        iframe.setAttribute('sandbox', 'allow-same-origin');
        iframe.setAttribute('referrerpolicy', 'no-referrer');
        iframe.addEventListener('load', () => {
            if (view !== current || !iframe.isConnected) return;
            const doc = iframe.contentDocument;
            if (!doc) return;
            renderStyles(doc, page?.css || '');
            renderMarkup(doc, page?.html || '', current.actions);
            function activate(event) {
                const target = event.target.closest?.('[data-action]');
                if (!target) return;
                if (event.type === 'keydown' && (target.localName === 'button' || !['Enter', ' '].includes(event.key))) return;
                event.preventDefault();
                void dispatch(target.dataset.action);
            }
            doc.addEventListener('click', activate);
            doc.addEventListener('keydown', activate);
        }, { once: true });
        iframe.srcdoc = FRAME_DOCUMENT;
        host.replaceChildren(iframe);
    }

    const visibleMessages = thread => {
        const keys = new Set(artifactTimelineKeys());
        return (thread?.messages ?? []).filter(entry => entry.anchor && keys.has(entry.anchor));
    };

    function paintThread(current) {
        if (threadView !== current || view !== current.view) return;
        const entries = visibleMessages(findThread(current.view.scope.metadata, current.view.itemId, current.recipient));
        current.history.replaceChildren(...entries.map(entry => {
            const role = entry.role === 'sent' ? 'Вы' : current.recipient;
            return element('li', `${role}: ${entry.text}`, `elephant-artifact-message-${entry.role === 'sent' ? 'sent' : 'received'}`);
        }));
        current.history.scrollTop = current.history.scrollHeight;
        current.send.disabled = Boolean(sending && sending.scope.metadata === current.view.scope.metadata);
    }

    async function sendThread(current) {
        const { view: from, recipient, composer, draftKey, status } = current;
        const { scope, itemId } = from;
        const text = composer.value.trim().slice(0, 2000);
        if (!text || threadView !== current || !inChat(scope)) return;
        if (sending || isGenerating() || online_status === 'no_connection') {
            status.textContent = 'Отправка пока недоступна.';
            return;
        }
        sending = { scope };
        const thread = findThread(scope.metadata, itemId, recipient, true);
        const anchor = artifactTimelineKeys().at(-1);
        thread.messages.push({ role: 'sent', text, anchor });
        drafts.delete(draftKey);
        delete thread.draft;
        composer.value = '';
        status.textContent = 'Отправлено. Ожидание ответа…';
        paintThread(current);
        try {
            await saveMetadata();
            if (!inChat(scope)) return;
            const history = visibleMessages(thread).slice(-12).map(entry => ({
                from: entry.role === 'sent' ? 'player' : recipient,
                message: entry.text,
            }));
            const reply = await generateQuietPrompt({
                quietPrompt: `Continue the current roleplay through a private text message from the specified recipient. Consider the current story and reply as that recipient. Output only their text message, without a sender label, narration, or changing the roleplay state. Recipient and conversation data: ${JSON.stringify({ recipient, history })}`,
            });
            if (!inChat(scope)) return;
            if (typeof reply === 'string' && reply.trim()) {
                thread.messages.push({ role: 'received', text: reply.trim().slice(0, 2000), anchor });
                await saveMetadata();
                status.textContent = '';
            } else {
                status.textContent = 'Ответ не получен.';
            }
        } catch {
            status.textContent = 'Ответ не получен.';
        } finally {
            sending = undefined;
            if (threadView) paintThread(threadView);
        }
    }

    function openThread(recipient) {
        const from = view;
        if (!from.itemId || !recipient) return;
        const draftKey = JSON.stringify([from.itemId, recipient]);
        const panel = element('section', '', 'elephant-artifact-thread');
        const back = element('button', 'К предмету', 'elephant-artifact-thread-back');
        back.type = 'button';
        back.addEventListener('click', () => {
            threadView = undefined;
            renderPage();
        });
        const heading = element('h3', recipient);
        const history = element('ol', '', 'elephant-artifact-thread-history');
        history.setAttribute('role', 'log');
        const form = element('form');
        const composer = element('textarea');
        composer.rows = 2;
        composer.maxLength = 2000;
        composer.placeholder = 'Сообщение';
        composer.setAttribute('aria-label', `Сообщение для ${recipient}`);
        const savedThread = findThread(from.scope.metadata, from.itemId, recipient);
        const savedDraft = savedThread?.draft;
        composer.value = drafts.get(draftKey) ?? (savedDraft && artifactTimelineKeys().includes(savedDraft.anchor) ? savedDraft.text : '') ?? '';
        composer.addEventListener('input', () => {
            drafts.set(draftKey, composer.value);
            const thread = findThread(from.scope.metadata, from.itemId, recipient, true);
            thread.draft = { text: composer.value, anchor: artifactTimelineKeys().at(-1) };
            clearTimeout(draftTimer);
            draftTimer = setTimeout(() => { if (inChat(from.scope)) void saveMetadata(); }, 300);
        });
        const send = element('button', 'Отправить');
        send.type = 'submit';
        const status = element('p', '', 'elephant-artifact-thread-status');
        status.setAttribute('role', 'status');
        const current = { view: from, recipient, history, composer, send, draftKey, status };
        form.addEventListener('submit', event => {
            event.preventDefault();
            void sendThread(current);
        });
        form.append(composer, send);
        panel.append(back, heading, history, form, status);
        threadView = current;
        host.replaceChildren(panel);
        paintThread(current);
        composer.focus();
    }

    async function dispatch(actionId) {
        const current = view;
        const action = current?.actions.get(actionId);
        if (!action || !inChat(current.scope)) return false;
        if (action.type === 'page' || action.type === 'inspect') {
            if (!current.artifact.pages.some(page => page.id === action.pageId)) return false;
            current.artifact = { ...current.artifact, pageId: action.pageId };
            threadView = undefined;
            onPageChange?.(action.pageId, action.id);
            if (view === current) renderPage();
            return true;
        }
        if (action.type === 'message' && action.recipient) {
            openThread(action.recipient);
            return true;
        }
        if (action.type !== 'use' || !action.text || sending || isGenerating() || online_status === 'no_connection') return false;
        sending = { scope: current.scope };
        // Prefix the declared intent so it cannot be processed as a slash command.
        // Neutralize the macro delimiters in generated text before submitting.
        const intent = action.text.replaceAll('{{', '｛｛').replaceAll('}}', '｝｝');
        const title = current.artifact.title.replaceAll('{{', '｛｛').replaceAll('}}', '｝｝');
        try {
            const sent = await sendIntent(`*Я пытаюсь использовать «${title}».* ${intent}`, () => inChat(current.scope));
            if (sent && view === current && inChat(current.scope)) current.onClose?.();
            return Boolean(sent);
        } catch {
            return false;
        } finally {
            sending = undefined;
            if (threadView) paintThread(threadView);
        }
    }

    return { render, dispatch, close, destroy() { close(); eventSource.removeListener(event_types.CHAT_CHANGED, chatChanged); } };
}
