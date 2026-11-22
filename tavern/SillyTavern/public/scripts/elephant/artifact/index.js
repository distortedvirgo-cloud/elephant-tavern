import { ctx } from '../stage/helper.js';
import {
    ARTIFACT_UPDATED, acceptArtifact, deferArtifact, getArtifactState, initArtifactStore,
    proposeArtifact, reconcileArtifact, revertArtifact, setArtifactPage,
} from './store.js';
import { createArtifactInteraction } from './interaction.js';

const SURPRISE = 'Offer a substantially different artifact that still belongs in this story. Surprise the player.';
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

let dialog;
let artifactHost;
let interaction;
let renderedItem;
let renderedProposal;
let returnFocus;
let revising = false;
let revision = '';
let ready = false;
let chatVersion = 0;
let autoTimer;
let revealTimer;

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

function button(action, label, className = '') {
    const node = element('button', className, label);
    node.type = 'button';
    node.dataset.artifactAction = action;
    return node;
}

export function canOpenArtifact() {
    const c = ctx();
    return Boolean(c.getCurrentChatId?.()
        && (c.groupId || c.characterId != null)
        && c.chat?.some(message => !message.is_system && !message.is_user && message.mes?.trim()));
}

function ensureDialog() {
    if (dialog) return;
    dialog = element('dialog', 'ea-dialog');
    dialog.id = 'ea-dialog';
    dialog.setAttribute('aria-labelledby', 'ea-title');
    dialog.addEventListener('cancel', event => {
        event.preventDefault();
        if (!finishReveal()) closeArtifact();
    });
    dialog.addEventListener('click', handleClick);
    dialog.addEventListener('input', event => {
        if (event.target.id === 'ea-revision') revision = event.target.value;
    });
    dialog.addEventListener('submit', event => {
        event.preventDefault();
        if (revision.trim()) void proposeArtifact(revision.trim());
    });
    document.body.append(dialog);
}

function showDialog() {
    ensureDialog();
    if (dialog.open) return;
    returnFocus = document.activeElement;
    dialog.showModal();
}

function closeArtifact(restoreFocus = true) {
    if (!dialog?.open) return false;
    clearTimeout(revealTimer);
    revealTimer = undefined;
    interaction?.close();
    renderedItem = undefined;
    renderedProposal = undefined;
    revising = false;
    revision = '';
    dialog.close();
    dialog.replaceChildren();
    if (restoreFocus) {
        const target = returnFocus?.isConnected && returnFocus !== document.body
            ? returnFocus : document.getElementById('ec-quick-btn');
        target?.focus({ preventScroll: true });
    }
    returnFocus = undefined;
    return true;
}

function render(state = getArtifactState()) {
    if (!dialog?.open || revealTimer) return;
    if (state.active && state.active.pages === renderedItem?.pages && state.active.pageId === renderedItem.pageId) return;
    const previousAction = dialog.contains(document.activeElement)
        ? document.activeElement.dataset.artifactAction : undefined;
    const editing = document.activeElement?.id === 'ea-revision';
    const panel = element('section', 'ea-panel');
    const close = button('close', '×', 'ea-close');
    close.setAttribute('aria-label', 'Закрыть');
    panel.append(close);
    const item = state.active || state.proposal;
    const heading = element('h2', 'ea-title', item?.title || 'Артефакт');
    heading.id = 'ea-title';
    heading.tabIndex = -1;
    if (state.active) {
        panel.classList.add('ea-panel-item');
        panel.append(heading);
        if (item.description) panel.append(element('p', 'ea-description', item.description));
        if (item.available === false) {
            panel.append(element('p', 'ea-status', 'Сейчас предмет у вас не находится.'));
            dialog.replaceChildren(panel);
            renderedItem = item;
            heading.focus({ preventScroll: true });
            return;
        }
        artifactHost ??= element('div', 'ea-artifact');
        artifactHost.id = 'ea-artifact';
        panel.append(artifactHost);
        dialog.replaceChildren(panel);
        interaction ??= createArtifactInteraction({ host: artifactHost, onPageChange: setArtifactPage });
        renderedItem = item;
        interaction.render(item, { itemId: item.id, onClose: closeArtifact });
        heading.focus({ preventScroll: true });
        return;
    }

    if (renderedProposal && item?.id !== renderedProposal) {
        revising = false;
        revision = '';
    }
    renderedProposal = item?.id;
    const seal = element('div', 'ea-seal');
    seal.setAttribute('aria-hidden', 'true');
    const icon = element('i', 'fa-solid fa-gem');
    seal.append(icon);
    panel.append(seal, heading);
    if (item?.description) panel.append(element('p', 'ea-description', item.description));
    const busy = state.status === 'generating';
    const status = element('p', 'ea-status');
    status.setAttribute('role', 'status');
    if (busy) status.textContent = item ? 'Готовится новый вариант…' : 'Артефакт обретает форму…';
    else if (!state.helperAvailable) status.textContent = 'Для создания артефакта подключите служебную модель в «Сцена и арт».';
    else if (state.error || state.status === 'error') status.textContent = 'Не удалось создать артефакт. Попробуйте ещё раз.';
    if (status.textContent) panel.append(status);

    const actions = element('div', 'ea-actions');
    if (item) {
        const keep = button('keep', 'Оставить', 'ea-primary');
        const change = button('change', 'Изменить');
        const later = button('later', 'Позже');
        keep.disabled = busy;
        change.disabled = busy || !state.helperAvailable;
        change.setAttribute('aria-expanded', String(revising));
        later.disabled = busy;
        actions.append(keep, change, later);
        if (state.canRevert) {
            const revert = button('revert', 'Вернуть прежний вариант');
            revert.disabled = busy;
            actions.append(revert);
        }
    } else {
        const create = state.error || state.status === 'error'
            ? button('retry', 'Повторить', 'ea-primary') : button('create', 'Создать', 'ea-primary');
        create.disabled = busy;
        actions.append(create);
    }
    panel.append(actions);
    let input;
    if (item && revising) {
        const form = element('form', 'ea-change');
        const label = element('label', '', 'Каким должен быть артефакт?');
        label.htmlFor = 'ea-revision';
        input = element('textarea', 'ea-revision');
        input.id = 'ea-revision';
        input.rows = 2;
        input.maxLength = 500;
        input.required = true;
        input.value = revision;
        input.disabled = busy;
        const submit = button('revise', 'Предложить вариант');
        submit.type = 'submit';
        submit.disabled = busy;
        const surprise = button('surprise', 'Удиви меня');
        surprise.disabled = busy;
        const choices = element('div', 'ea-actions');
        choices.append(submit, surprise);
        form.append(label, input, choices);
        panel.append(form);
    }
    dialog.replaceChildren(panel);
    const nextFocus = (editing && !input?.disabled && input)
        || (previousAction && dialog.querySelector(`[data-artifact-action="${previousAction}"]:enabled`))
        || heading;
    nextFocus.focus({ preventScroll: true });
}

function handleClick(event) {
    if (event.target === dialog) {
        if (!finishReveal()) closeArtifact();
        return;
    }
    const action = event.target.closest('[data-artifact-action]')?.dataset.artifactAction;
    switch (action) {
        case 'skip': finishReveal(); break;
        case 'close': closeArtifact(); break;
        case 'keep': void acceptArtifact().then(accepted => { if (accepted) closeArtifact(); }); break;
        case 'later': void deferArtifact(); closeArtifact(); break;
        case 'revert': void revertArtifact(); break;
        case 'change':
            revising = !revising;
            render();
            if (revising) document.getElementById('ea-revision')?.focus();
            break;
        case 'surprise': void proposeArtifact(SURPRISE); break;
        case 'create':
        case 'retry':
            render();
            if (getArtifactState().helperAvailable) void proposeArtifact();
            break;
    }
}

function finishReveal() {
    if (!revealTimer) return false;
    clearTimeout(revealTimer);
    revealTimer = undefined;
    render();
    return true;
}

function reveal() {
    const trigger = document.getElementById('ec-quick-btn')?.getBoundingClientRect();
    showDialog();
    if (!trigger?.width || reducedMotion.matches) {
        render();
        return;
    }
    const intro = element('section', 'ea-reveal');
    intro.id = 'ea-reveal';
    const title = element('h2', 'ea-reveal-title', 'Новый артефакт');
    title.id = 'ea-title';
    const glow = element('div', 'ea-reveal-glow');
    const gem = element('i', 'fa-solid fa-gem ea-reveal-gem');
    gem.setAttribute('aria-hidden', 'true');
    glow.append(gem);
    const skip = button('skip', 'Пропустить', 'ea-skip');
    skip.id = 'ea-skip';
    intro.append(glow, title, skip);
    dialog.replaceChildren(intro);
    const bounds = glow.getBoundingClientRect();
    glow.style.setProperty('--ea-from-x', `${trigger.left + trigger.width / 2 - bounds.left - bounds.width / 2}px`);
    glow.style.setProperty('--ea-from-y', `${trigger.top + trigger.height / 2 - bounds.top - bounds.height / 2}px`);
    glow.classList.add('ea-reveal-fly');
    skip.focus({ preventScroll: true });
    revealTimer = setTimeout(finishReveal, 1000);
}

export function openArtifact() {
    if (!canOpenArtifact() || document.querySelector('#ew-overlay:not(.ew-out)')) return;
    showDialog();
    render(reconcileArtifact());
}

function queueAutomaticProposal() {
    clearTimeout(autoTimer);
    if (!ready || !canOpenArtifact() || document.querySelector('#ew-overlay:not(.ew-out)')) return;
    const version = chatVersion;
    autoTimer = setTimeout(async () => {
        const state = reconcileArtifact();
        if (!state.autoEligible || !state.helperAvailable || dialog?.open) return;
        await proposeArtifact();
        if (version !== chatVersion || !canOpenArtifact() || dialog?.open
            || document.querySelector('#ew-overlay:not(.ew-out)') || !getArtifactState().proposal) return;
        reveal();
    }, 400);
}

export function initArtifact() {
    initArtifactStore();
    const c = ctx();
    const events = c.eventTypes ?? c.event_types;
    c.eventSource.on(events.APP_READY, () => {
        ready = true;
        queueAutomaticProposal();
    });
    c.eventSource.on(events.CHAT_CHANGED, () => {
        chatVersion++;
        closeArtifact(false);
        interaction?.destroy();
        interaction = undefined;
        artifactHost = undefined;
        queueAutomaticProposal();
    });
    c.eventSource.on(events.CHARACTER_MESSAGE_RENDERED, queueAutomaticProposal);
    window.addEventListener(ARTIFACT_UPDATED, () => render());
    reducedMotion.addEventListener('change', () => {
        if (reducedMotion.matches) finishReveal();
    });

    const stage = globalThis.ElephantStage;
    if (stage) {
        const handleBack = stage.handleBack;
        stage.handleBack = () => finishReveal() || closeArtifact() || handleBack();
    }
}
