/*
 * Elephant Core — client side. Loaded by script.js during app start-up
 * (not through the extension manager): the mobile shell and living scene
 * (stage), then game mode (game), which hooks generation directly via
 * globalThis.ElephantCore.beforeGenerate (see runGenerationInterceptors).
 */
import { init as initStage } from './stage/index.js';
import { init as initGame, beforeGenerate } from './game/index.js';

export async function initElephantCore() {
    globalThis.ElephantCore = { version: 1, beforeGenerate };
    for (const [name, init] of [['stage', initStage], ['game', initGame]]) {
        try {
            await init();
        } catch (e) {
            console.error(`[Elephant Core] ${name} failed to start`, e);
        }
    }
}
