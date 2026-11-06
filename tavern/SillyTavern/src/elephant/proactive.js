/*
 * Elephant Core — "the character writes first".
 *
 * The browser keeps a small snapshot of each chat (card summary, Elephant
 * Memory's state card, last messages) up to date. A scheduler inside the
 * server — which keeps running in the app's foreground service while the UI
 * is closed — decides when a character would plausibly text the user, writes
 * the message with the helper model and drops it into an inbox. The Android
 * shell turns new inbox entries into notifications (outbox files); the chat
 * picks them up the next time it is open.
 *
 * Storage per user: <data>/<user>/elephant/proactive.json and inbox.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import fetch from 'node-fetch';

import { readSecret, SECRET_KEYS } from '../endpoints/secrets.js';
import { getAllEnabledUsers, getUserDirectories } from '../users.js';

const NANOGPT = process.env.ELEPHANT_NANOGPT_URL || 'https://nano-gpt.com/api/v1';
const OUTBOX = process.env.ET_OUTBOX || '';
const TICK_MS = Number(process.env.ELEPHANT_PROACTIVE_TICK_MS) || 60_000;

/** Base silence before a character reaches out, in hours. */
export const FREQUENCY = { rare: 24, normal: 8, often: 3 };
const MAX_UNANSWERED = 2;
const MIN_GAP_HOURS = 2;

// ------------------------------------------------------------------ storage

function dir(directories) {
    const d = path.join(directories.root, 'elephant');
    fs.mkdirSync(d, { recursive: true });
    return d;
}

function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, data) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
    fs.renameSync(tmp, file);
}

export function loadConfig(directories) {
    const cfg = readJson(path.join(dir(directories), 'proactive.json'), {});
    cfg.characters ??= {};
    cfg.model ??= '';
    return cfg;
}

export function saveConfig(directories, cfg) {
    writeJson(path.join(dir(directories), 'proactive.json'), cfg);
    // The Android shell starts the server at boot only when someone may write first.
    if (OUTBOX) {
        const flag = path.join(path.dirname(OUTBOX), 'proactive.on');
        const any = Object.values(cfg.characters).some(c => c.enabled);
        try { any ? fs.writeFileSync(flag, '1') : fs.rmSync(flag, { force: true }); } catch { /* ignore */ }
    }
}

export function loadInbox(directories) {
    return readJson(path.join(dir(directories), 'inbox.json'), []);
}

function saveInbox(directories, inbox) {
    writeJson(path.join(dir(directories), 'inbox.json'), inbox.slice(-50));
}

// ------------------------------------------------------------------ scheduling

function hourNow() {
    const d = new Date();
    return d.getHours() + d.getMinutes() / 60;
}

function inQuietHours(from, to) {
    if (from === to) return false;
    const h = hourNow();
    return from < to ? h >= from && h < to : h >= from || h < to;
}

/** Deterministic jitter per character and day, so the timing feels human but stable. */
function jitter(key, spanHours) {
    const day = new Date().toISOString().slice(0, 10);
    const n = crypto.createHash('sha1').update(`${key}:${day}`).digest().readUInt16BE(0) / 65535;
    return (n - 0.5) * spanHours;
}

export function isDue(entry, now = Date.now()) {
    if (!entry?.enabled || !entry.snapshot) return false;
    if ((entry.unanswered ?? 0) >= MAX_UNANSWERED) return false;
    if (inQuietHours(entry.quietFrom ?? 23, entry.quietTo ?? 9)) return false;
    const base = FREQUENCY[entry.frequency] ?? FREQUENCY.normal;
    const wait = Math.max(1, base + jitter(entry.key, base * 0.5)) * 3600_000;
    const last = Math.max(entry.lastActivity ?? 0, entry.lastProactive ?? 0);
    if (now - last < wait) return false;
    if (entry.lastProactive && now - entry.lastProactive < MIN_GAP_HOURS * 3600_000) return false;
    return true;
}

// ------------------------------------------------------------------ writing

function hoursAgo(ts) {
    if (!ts) return 'a while';
    const h = (Date.now() - ts) / 3600_000;
    return h < 1 ? 'less than an hour' : h < 24 ? `${Math.round(h)} hours` : `${Math.round(h / 24)} days`;
}

function partOfDay() {
    const h = new Date().getHours();
    return h < 5 ? 'late night' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 22 ? 'evening' : 'night';
}

export function proactivePrompt(entry) {
    const s = entry.snapshot;
    const lines = (s.messages || []).slice(-8).map(m => `${m.name}: ${String(m.mes || '').slice(0, 500)}`).join('\n');
    const system = `You are ${s.charName}. You write a text message to ${s.userName} on your own initiative, as a real person in your life would. You stay fully in character and in the world of the story.`;
    const user = `Who you are:
<character>
${String(s.card || '').slice(0, 1800)}
</character>
${s.state ? `\nWhat is going on in the story right now:\n<state>\n${String(s.state).slice(0, 1800)}\n</state>\n` : ''}
Your last exchange with ${s.userName}:
<recent>
${lines}
</recent>

It has been ${hoursAgo(entry.lastActivity)} since ${s.userName} last wrote. It is ${partOfDay()} now.${(entry.unanswered ?? 0) > 0 ? ` Your previous message got no reply yet.` : ''}

Write ONE short message ${s.charName} sends to ${s.userName} now (1–3 sentences, like a text): pick up an open thread, a promise, a feeling or something that happened since — whatever this character would actually do. No narration, no asterisks, no quotes around it.
Reply with one line of minified JSON: {"en":"the message in English","ru":"the same message in natural Russian"}`;
    return { system, user };
}

async function writeMessage(directories, cfg, entry) {
    const key = readSecret(directories, SECRET_KEYS.NANOGPT);
    const model = entry.model || cfg.model;
    if (!key || !model) return null;
    const { system, user } = proactivePrompt(entry);
    const res = await fetch(`${NANOGPT}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: 300, temperature: 0.9, stream: false }),
    });
    if (!res.ok) throw new Error(`NanoGPT ${res.status}`);
    /** @type {any} */
    const data = await res.json();
    const text = String(data?.choices?.[0]?.message?.content ?? '');
    let en = '';
    let ru = '';
    try {
        const o = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? '');
        en = String(o.en || '').trim();
        ru = String(o.ru || '').trim();
    } catch {
        en = text.trim();
    }
    if (!en) return null;
    return { en: en.slice(0, 600), ru: (ru || en).slice(0, 600) };
}

function notify(item, entry, directories) {
    if (!OUTBOX) return;
    try {
        fs.mkdirSync(OUTBOX, { recursive: true });
        const avatar = entry.key && !entry.key.startsWith('group:') ? path.join(directories.characters, entry.key) : '';
        fs.writeFileSync(path.join(OUTBOX, `${item.id}.json`), JSON.stringify({
            id: item.id, key: item.key, chatFile: item.chatFile, charName: item.charName, text: item.ru, avatar,
        }));
    } catch (e) {
        console.warn('[Elephant Core] outbox write failed', e);
    }
}

/** Writes one message for a chat entry right now and stores it in the inbox. */
export async function reachOut(directories, cfg, entry) {
    const msg = await writeMessage(directories, cfg, entry);
    if (!msg) return null;
    const item = {
        id: crypto.randomUUID(),
        key: entry.key,
        chatFile: entry.snapshot.chatFile,
        charName: entry.snapshot.charName,
        en: msg.en,
        ru: msg.ru,
        created: Date.now(),
    };
    const inbox = loadInbox(directories);
    inbox.push(item);
    saveInbox(directories, inbox);
    entry.lastProactive = Date.now();
    entry.unanswered = (entry.unanswered ?? 0) + 1;
    saveConfig(directories, cfg);
    notify(item, entry, directories);
    console.info(`[Elephant Core] ${item.charName} wrote first`);
    return item;
}

let running = false;
async function tick() {
    if (running) return;
    running = true;
    try {
        for (const user of await getAllEnabledUsers()) {
            const directories = getUserDirectories(user.handle);
            const cfg = loadConfig(directories);
            for (const entry of Object.values(cfg.characters)) {
                if (!isDue(entry)) continue;
                try {
                    await reachOut(directories, cfg, entry);
                } catch (e) {
                    console.warn('[Elephant Core] proactive message failed:', e.message);
                    entry.lastProactive = Date.now(); // back off instead of retrying every minute
                    saveConfig(directories, cfg);
                }
            }
        }
    } catch (e) {
        console.warn('[Elephant Core] proactive tick failed', e);
    } finally {
        running = false;
    }
}

let timer = null;
export function startScheduler() {
    if (timer) return;
    timer = setInterval(tick, TICK_MS);
    timer.unref?.();
}
