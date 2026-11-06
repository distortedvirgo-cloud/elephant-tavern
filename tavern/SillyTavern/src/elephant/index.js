/*
 * Elephant Core — server side.
 *
 * The cheap "helper" model (scene reading, game referee and reporter, image
 * prompts) is called from here, with the NanoGPT key SillyTavern already
 * stores. The browser no longer needs a Connection Manager profile, and a
 * request keeps running even if the WebView is suspended mid-call.
 *
 *   POST /api/elephant/complete  { model, messages, max_tokens?, temperature?, json? }
 *   POST /api/elephant/models    → [{ id, name, input, output }] (USD per 1M tokens)
 *   GET  /api/elephant/health
 */
import express from 'express';
import fetch from 'node-fetch';

import { readSecret, SECRET_KEYS } from '../endpoints/secrets.js';

export const router = express.Router();

// Overridable for tests.
const NANOGPT = process.env.ELEPHANT_NANOGPT_URL || 'https://nano-gpt.com/api/v1';
const TIMEOUT_MS = 90_000;

let modelsCache = { at: 0, list: [] };

function nanoKey(request) {
    return readSecret(request.user.directories, SECRET_KEYS.NANOGPT);
}

async function callNano(key, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(`${NANOGPT}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        const text = await res.text();
        let data = null;
        try { data = JSON.parse(text); } catch { /* not json */ }
        return { ok: res.ok, status: res.status, data, text };
    } finally {
        clearTimeout(timer);
    }
}

router.get('/health', (_request, response) => response.json({ ok: true, core: 'elephant', version: 1 }));

router.post('/complete', async (request, response) => {
    try {
        const key = nanoKey(request);
        if (!key) return response.status(400).json({ error: 'no-key', message: 'Нет ключа NanoGPT — сохраните его в «Подключении».' });

        const { model, messages, max_tokens = 400, temperature = 0.4, json = false } = request.body ?? {};
        if (!model || !Array.isArray(messages) || !messages.length) {
            return response.status(400).json({ error: 'bad-request' });
        }

        const body = {
            model: String(model),
            messages: messages.map(m => ({ role: String(m.role || 'user'), content: String(m.content ?? '') })),
            max_tokens: Math.max(16, Math.min(4096, Number(max_tokens) || 400)),
            temperature: Math.max(0, Math.min(2, Number(temperature) || 0)),
            stream: false,
        };
        if (json) body.response_format = { type: 'json_object' };

        let result = await callNano(key, body);
        // Some providers reject response_format — retry once without it.
        if (!result.ok && json && result.status >= 400 && result.status < 500) {
            delete body.response_format;
            result = await callNano(key, body);
        }
        if (!result.ok) {
            const message = result.data?.error?.message || result.text?.slice(0, 300) || `HTTP ${result.status}`;
            console.warn('[Elephant Core] helper call failed:', result.status, message);
            return response.status(502).json({ error: 'upstream', status: result.status, message });
        }

        const choice = result.data?.choices?.[0];
        const content = choice?.message?.content ?? choice?.text ?? '';
        return response.json({ content: String(content), usage: result.data?.usage ?? null, model: result.data?.model ?? model });
    } catch (error) {
        const aborted = error?.name === 'AbortError';
        console.error('[Elephant Core] complete error:', aborted ? 'timeout' : error);
        return response.status(aborted ? 504 : 500).json({ error: aborted ? 'timeout' : 'internal', message: String(error?.message || error) });
    }
});

router.post('/models', async (_request, response) => {
    try {
        if (Date.now() - modelsCache.at < 30 * 60_000 && modelsCache.list.length) return response.json(modelsCache.list);
        const res = await fetch(`${NANOGPT}/models?detailed=true`);
        if (!res.ok) return response.json(modelsCache.list);
        /** @type {any} */
        const data = await res.json();
        const list = (Array.isArray(data?.data) ? data.data : []).map((m) => {
            const p = m.pricing ?? {};
            const input = Number(p.prompt ?? p.input ?? NaN);
            const output = Number(p.completion ?? p.output ?? NaN);
            return {
                id: m.id,
                name: m.name || m.id,
                // NanoGPT reports per-token or per-1M prices depending on the field; normalise to per 1M.
                input: Number.isFinite(input) ? (input < 0.01 ? input * 1e6 : input) : null,
                output: Number.isFinite(output) ? (output < 0.01 ? output * 1e6 : output) : null,
            };
        }).filter(m => m.id);
        modelsCache = { at: Date.now(), list };
        return response.json(list);
    } catch (error) {
        console.error('[Elephant Core] models error:', error);
        return response.json(modelsCache.list);
    }
});
