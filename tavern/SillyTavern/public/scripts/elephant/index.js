/*
 * Elephant Core — client side. Loaded by script.js during app start-up
 * (not through the extension manager):
 *   memory — Elephant Memory (chronicle, state card, critic, translation);
 *   stage  — mobile shell, living scene, NanoGPT art;
 *   game   — referee, dice, HUD, bonds, goals.
 * Generation calls globalThis.ElephantCore.beforeGenerate (see
 * runGenerationInterceptors): memory first, then the game engine.
 */
import { init as initMemory } from './memory/index.js';
import { init as initStage } from './stage/index.js';
import { init as initGame, beforeGenerate as gameBeforeGenerate } from './game/index.js';
import { init as initProactive } from './proactive/index.js';

async function beforeGenerate(chat, contextSize, abort, type) {
    let stop = false;
    const guard = (immediately) => { if (immediately) stop = true; abort(immediately); };
    const memory = globalThis.elephantMemory_interceptor;
    if (typeof memory === 'function') {
        try { await memory(chat, contextSize, guard, type); } catch (e) { console.error('[Elephant Core] memory interceptor', e); }
        if (stop) return;
    }
    await gameBeforeGenerate(chat, contextSize, guard, type);
}

export async function initElephantCore() {
    globalThis.ElephantCore = { version: 2, beforeGenerate };
    for (const [name, init] of [['memory', initMemory], ['stage', initStage], ['game', initGame], ['proactive', initProactive]]) {
        try {
            await init();
        } catch (e) {
            console.error(`[Elephant Core] ${name} failed to start`, e);
        }
    }
}
