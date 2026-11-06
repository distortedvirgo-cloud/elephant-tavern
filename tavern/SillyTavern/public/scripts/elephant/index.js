/*
 * Elephant Core — client side. Loaded by script.js during app start-up
 * (not through the extension manager):
 *   memory — Elephant Memory (chronicle, state card, critic, translation);
 *   stage  — mobile shell, living scene, NanoGPT art;
 *   game   — referee, dice, HUD, bonds, goals;
 *   proactive — characters write first (with the server scheduler);
 *   chat   — gestures, long-press actions, reply ideas;
 *   welcome — first-run setup (name, NanoGPT key, models);
 *   power  — the character controls the app (scene, colours, title cards, glitch, whispers);
 *   forge  — character generator (canon-aware cards + Anima avatars);
 *   director — the character's own plan before each reply (helper model);
 *   cost   — what each turn and day costs (NanoGPT balance);
 *   voices — one dialogue colour per character, owned by the app.
 * Generation calls globalThis.ElephantCore.beforeGenerate (see
 * runGenerationInterceptors): memory, then the director, then the game engine.
 */
import { init as initMemory } from './memory/index.js';
import { init as initStage } from './stage/index.js';
import { init as initGame, beforeGenerate as gameBeforeGenerate } from './game/index.js';
import { init as initProactive } from './proactive/index.js';
import { init as initChat } from './chat/index.js';
import { init as initWelcome } from './welcome/index.js';
import { init as initPower } from './power/index.js';
import { init as initForge } from './forge/index.js';
import { init as initCost } from './cost/index.js';
import { init as initVoices } from './voices/index.js';
import { init as initDirector, beforeGenerate as directorBeforeGenerate } from './director/index.js';

async function beforeGenerate(chat, contextSize, abort, type) {
    let stop = false;
    const guard = (immediately) => { if (immediately) stop = true; abort(immediately); };
    const memory = globalThis.elephantMemory_interceptor;
    if (typeof memory === 'function') {
        try { await memory(chat, contextSize, guard, type); } catch (e) { console.error('[Elephant Core] memory interceptor', e); }
        if (stop) return;
    }
    await directorBeforeGenerate(chat, contextSize, guard, type);
    await gameBeforeGenerate(chat, contextSize, guard, type);
}

export async function initElephantCore() {
    globalThis.ElephantCore = { version: 2, beforeGenerate };
    for (const [name, init] of [['memory', initMemory], ['stage', initStage], ['game', initGame], ['proactive', initProactive], ['chat', initChat], ['welcome', initWelcome], ['power', initPower], ['forge', initForge], ['director', initDirector], ['cost', initCost], ['voices', initVoices]]) {
        try {
            await init();
        } catch (e) {
            console.error(`[Elephant Core] ${name} failed to start`, e);
        }
    }
}
