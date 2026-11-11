/*
 * Elephant Stage — sound. Everything is synthesised with WebAudio: no sound files,
 * so the APK does not grow. Two parts:
 *   play(event) — a one-shot for a moment (a blow, a shot, thunder, magic, coins…);
 *   setScene(scene) — a quiet ambient bed under the chat (rain, wind, a fireplace, the deep…).
 * The audio context starts on the first touch (browsers require a gesture) and sleeps
 * while the app is in the background.
 */

let ac = null;
let master = null;
let fxBus = null;
let ambBus = null;
let noiseBuf = null;
let enabled = true;
let volume = 0.6;
let ambientOn = true;
let ambient = null; // { key, nodes: [], timers: [] }
let wantScene = null;

const now = () => ac.currentTime;
const rnd = (a, b) => a + Math.random() * (b - a);

function ensure() {
    if (ac) return ac;
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return null;
    ac = new AC();
    master = ac.createGain();
    master.gain.value = volume;
    master.connect(ac.destination);
    fxBus = ac.createGain(); fxBus.gain.value = 0.9; fxBus.connect(master);
    ambBus = ac.createGain(); ambBus.gain.value = 0.35; ambBus.connect(master);
    const len = ac.sampleRate * 2;
    noiseBuf = ac.createBuffer(1, len, ac.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return ac;
}

/** Call from any user gesture: the context may only start then. */
export function unlock() {
    if (!enabled) return;
    if (!ensure()) return;
    if (ac.state === 'suspended') ac.resume().catch(() => {});
    if (wantScene && !ambient) setScene(wantScene);
}

export function configure({ on = enabled, vol = volume, amb = ambientOn } = {}) {
    enabled = Boolean(on);
    volume = Math.max(0, Math.min(1, Number(vol)));
    ambientOn = Boolean(amb);
    if (master) master.gain.setTargetAtTime(enabled ? volume : 0, now(), 0.05);
    if (!enabled || !ambientOn) stopAmbient();
    else if (wantScene) setScene(wantScene);
}

// ------------------------------------------------------------------ building blocks

function env(g, t, a, peak, decay, sustain = 0) {
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, sustain || 0.0001), t + a + decay);
}

function noise({ t = now(), dur = 0.3, type = 'lowpass', f = 1000, f2 = null, q = 0.8, peak = 0.6, a = 0.005, out = fxBus, rate = 1 } = {}) {
    const src = ac.createBufferSource();
    src.buffer = noiseBuf; src.loop = true; src.playbackRate.value = rate;
    const fl = ac.createBiquadFilter(); fl.type = type; fl.Q.value = q;
    fl.frequency.setValueAtTime(f, t);
    if (f2) fl.frequency.exponentialRampToValueAtTime(f2, t + dur);
    const g = ac.createGain();
    env(g, t, a, peak, dur);
    src.connect(fl); fl.connect(g); g.connect(out);
    src.start(t, rnd(0, 1.5)); src.stop(t + a + dur + 0.05);
}

function tone({ t = now(), dur = 0.3, f = 440, f2 = null, type = 'sine', peak = 0.4, a = 0.005, out = fxBus, detune = 0 } = {}) {
    const o = ac.createOscillator(); o.type = type; o.detune.value = detune;
    o.frequency.setValueAtTime(f, t);
    if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
    const g = ac.createGain();
    env(g, t, a, peak, dur);
    o.connect(g); g.connect(out);
    o.start(t); o.stop(t + a + dur + 0.05);
}

const thump = (t, f = 110, peak = 0.9, dur = 0.25) => tone({ t, f, f2: 38, peak, dur, type: 'sine' });
const ping = (t, f, peak = 0.18, dur = 0.5) => { tone({ t, f, peak, dur }); tone({ t, f: f * 2.76, peak: peak * 0.35, dur: dur * 0.6 }); };
const chord = (t, notes, { peak = 0.12, dur = 1.4, a = 0.08, type = 'sine', step = 0 } = {}) => notes.forEach((f, i) => tone({ t: t + i * step, f, peak, dur, a, type }));

// ------------------------------------------------------------------ one-shots

const SFX = {
    hit: (t) => { thump(t, 120, 0.9, 0.22); noise({ t, dur: 0.12, f: 1800, type: 'lowpass', peak: 0.5 }); },
    blood: (t) => { thump(t, 90, 0.6, 0.2); noise({ t: t + 0.02, dur: 0.25, f: 600, f2: 200, peak: 0.35 }); },
    slash: (t) => { noise({ t, dur: 0.22, type: 'bandpass', f: 1500, f2: 7000, q: 1.4, peak: 0.55, a: 0.02 }); tone({ t: t + 0.05, f: 3200, f2: 2600, peak: 0.05, dur: 0.4, type: 'triangle' }); },
    gunshot: (t) => { noise({ t, dur: 0.08, type: 'highpass', f: 900, peak: 1 }); thump(t, 150, 1, 0.18); noise({ t: t + 0.04, dur: 0.9, f: 900, f2: 180, peak: 0.25 }); },
    explosion: (t) => { thump(t, 70, 1, 1.2); noise({ t, dur: 1.8, f: 1400, f2: 90, peak: 0.95, a: 0.01 }); noise({ t: t + 0.3, dur: 1.4, f: 300, peak: 0.3, a: 0.2 }); },
    lightning: (t) => { noise({ t, dur: 0.12, type: 'highpass', f: 1500, peak: 0.8 }); noise({ t: t + 0.25, dur: 2.4, f: 260, f2: 60, peak: 0.85, a: 0.25 }); thump(t + 0.3, 55, 0.6, 1.6); },
    thunder: (t) => SFX.lightning(t),
    shatter: (t) => { noise({ t, dur: 0.15, type: 'highpass', f: 2500, peak: 0.6 }); for (let i = 0; i < 9; i++) ping(t + rnd(0, 0.35), rnd(2200, 5200), 0.08, rnd(0.15, 0.4)); },
    quake: (t) => { noise({ t, dur: 2.4, f: 120, peak: 0.9, a: 0.3, rate: 0.5 }); thump(t, 45, 0.7, 2); },
    shake: (t) => SFX.quake(t),
    flashbang: (t) => { noise({ t, dur: 0.2, type: 'highpass', f: 600, peak: 1 }); tone({ t: t + 0.05, f: 3800, peak: 0.12, dur: 2.6, a: 0.05 }); },
    fire: (t) => { noise({ t, dur: 0.9, type: 'bandpass', f: 300, f2: 2400, q: 0.7, peak: 0.6, a: 0.12 }); for (let i = 0; i < 6; i++) noise({ t: t + rnd(0.1, 0.8), dur: 0.03, type: 'highpass', f: 3000, peak: 0.25 }); },
    ice: (t) => { [2093, 2637, 3136, 3951].forEach((f, i) => ping(t + i * 0.06 + rnd(0, 0.03), f, 0.1, 0.9)); noise({ t, dur: 0.3, type: 'highpass', f: 5000, peak: 0.15 }); },
    water: (t) => { noise({ t, dur: 0.5, f: 2500, f2: 300, peak: 0.6, a: 0.01 }); for (let i = 0; i < 5; i++) tone({ t: t + 0.2 + rnd(0, 0.5), f: rnd(300, 600), f2: rnd(900, 1500), peak: 0.08, dur: 0.07 }); },
    smoke: (t) => noise({ t, dur: 1.2, type: 'bandpass', f: 1200, f2: 400, q: 0.5, peak: 0.3, a: 0.2 }),
    magic: (t) => { [523, 659, 784, 1047, 1319].forEach((f, i) => tone({ t: t + i * 0.07, f, peak: 0.09, dur: 1.1, a: 0.02, type: 'triangle' })); noise({ t, dur: 0.8, type: 'highpass', f: 6000, peak: 0.08, a: 0.2 }); },
    dark: (t) => { tone({ t, f: 110, f2: 55, type: 'sawtooth', peak: 0.12, dur: 1.8, a: 0.3, detune: -12 }); tone({ t, f: 116, f2: 58, type: 'sawtooth', peak: 0.1, dur: 1.8, a: 0.3 }); noise({ t, dur: 1.6, f: 400, f2: 120, peak: 0.3, a: 0.4 }); },
    holy: (t) => chord(t, [523, 659, 784, 1047], { peak: 0.08, dur: 2.2, a: 0.4 }),
    heal: (t) => chord(t, [440, 554, 659, 880], { peak: 0.08, dur: 0.9, a: 0.02, step: 0.09, type: 'triangle' }),
    poison: (t) => { for (let i = 0; i < 7; i++) tone({ t: t + rnd(0, 0.8), f: rnd(150, 300), f2: rnd(400, 700), peak: 0.12, dur: 0.09 }); },
    kiss: (t) => { noise({ t, dur: 0.06, type: 'bandpass', f: 2200, q: 3, peak: 0.25 }); tone({ t: t + 0.01, f: 900, f2: 1400, peak: 0.05, dur: 0.08 }); },
    heartbeat: (t) => { thump(t, 70, 0.8, 0.18); thump(t + 0.22, 60, 0.55, 0.2); thump(t + 1.0, 70, 0.8, 0.18); thump(t + 1.22, 60, 0.55, 0.2); },
    coins: (t) => { for (let i = 0; i < 8; i++) ping(t + i * 0.05 + rnd(0, 0.04), rnd(2600, 4200), 0.07, 0.35); },
    confetti: (t) => { noise({ t, dur: 0.06, type: 'highpass', f: 1500, peak: 0.7 }); thump(t, 220, 0.4, 0.08); for (let i = 0; i < 10; i++) ping(t + 0.1 + rnd(0, 0.6), rnd(1500, 3500), 0.04, 0.3); },
    stars: (t) => chord(t, [784, 988, 1175, 1568], { peak: 0.07, dur: 0.8, a: 0.01, step: 0.06, type: 'triangle' }),
    shout: (t) => { thump(t, 90, 0.7, 0.3); noise({ t, dur: 0.25, f: 900, peak: 0.3 }); },
    dice: (t) => { for (let i = 0; i < 5; i++) noise({ t: t + i * 0.07 + rnd(0, 0.03), dur: 0.035, type: 'bandpass', f: rnd(1800, 3200), q: 4, peak: 0.35 }); },
    glitch: (t) => { for (let i = 0; i < 6; i++) tone({ t: t + i * 0.06, f: rnd(200, 2000), type: 'square', peak: 0.05, dur: 0.05 }); },
    whisper: (t) => noise({ t, dur: 1.2, type: 'bandpass', f: 3000, q: 2, peak: 0.12, a: 0.3 }),
    title: (t) => { thump(t, 60, 0.6, 1.4); chord(t, [196, 294, 392], { peak: 0.06, dur: 2.4, a: 0.3 }); },
};
export const SOUND_EVENTS = Object.keys(SFX);

const last = {};
export function play(event) {
    if (!enabled || !SFX[event] || !ensure() || ac.state !== 'running') return;
    const t = now();
    if (last[event] && t - last[event] < 0.15) return; // the same event twice in one frame
    last[event] = t;
    try { SFX[event](t + 0.01); } catch { /* audio is a nicety */ }
}

// ------------------------------------------------------------------ ambient

function loopNoise({ type = 'lowpass', f = 800, q = 0.7, gain = 0.3, lfo = 0, lfoDepth = 0, rate = 1 }) {
    const src = ac.createBufferSource(); src.buffer = noiseBuf; src.loop = true; src.playbackRate.value = rate;
    const fl = ac.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q;
    const g = ac.createGain(); g.gain.value = 0.0001; g.gain.setTargetAtTime(gain, now(), 1.2);
    src.connect(fl); fl.connect(g); g.connect(ambBus);
    const nodes = [src, fl, g];
    if (lfo) {
        const o = ac.createOscillator(); o.frequency.value = lfo;
        const og = ac.createGain(); og.gain.value = lfoDepth;
        o.connect(og); og.connect(fl.frequency); o.start(); nodes.push(o, og);
    }
    src.start();
    return { nodes, g };
}

function loopDrone(freqs, gain = 0.03, type = 'sine') {
    const g = ac.createGain(); g.gain.value = 0.0001; g.gain.setTargetAtTime(gain, now(), 2);
    g.connect(ambBus);
    const nodes = [g];
    for (const f of freqs) { const o = ac.createOscillator(); o.type = type; o.frequency.value = f; o.detune.value = rnd(-8, 8); o.connect(g); o.start(); nodes.push(o); }
    return { nodes, g };
}

/** Ambient beds by name. Each returns { parts, every?: [ms, fn] } for random one-shots. */
const BEDS = {
    rain: () => ({ parts: [loopNoise({ type: 'bandpass', f: 2500, q: 0.4, gain: 0.32 }), loopNoise({ type: 'lowpass', f: 400, gain: 0.12 })] }),
    storm: () => ({ parts: [loopNoise({ type: 'bandpass', f: 2000, q: 0.4, gain: 0.45 }), loopNoise({ type: 'lowpass', f: 300, gain: 0.25, lfo: 0.1, lfoDepth: 150 })], every: [[9000, 20000], (t) => { noise({ t, dur: 3, f: 220, f2: 60, peak: 0.5, a: 0.4, out: ambBus }); }] }),
    wind: () => ({ parts: [loopNoise({ type: 'bandpass', f: 500, q: 1.2, gain: 0.3, lfo: 0.13, lfoDepth: 300 })] }),
    blizzard: () => ({ parts: [loopNoise({ type: 'bandpass', f: 800, q: 1, gain: 0.45, lfo: 0.2, lfoDepth: 500 }), loopNoise({ type: 'highpass', f: 4000, gain: 0.08 })] }),
    sandstorm: () => ({ parts: [loopNoise({ type: 'bandpass', f: 1400, q: 0.6, gain: 0.35, lfo: 0.15, lfoDepth: 600 })] }),
    fireplace: () => ({ parts: [loopNoise({ type: 'lowpass', f: 300, gain: 0.18 })], every: [[80, 600], (t) => noise({ t, dur: rnd(0.01, 0.04), type: 'highpass', f: rnd(1500, 4000), peak: rnd(0.05, 0.25), out: ambBus })] }),
    deep: () => ({ parts: [loopNoise({ type: 'lowpass', f: 180, gain: 0.35, lfo: 0.07, lfoDepth: 60 })], every: [[1500, 5000], (t) => { for (let i = 0; i < 3; i++) tone({ t: t + i * 0.12, f: rnd(200, 400), f2: rnd(600, 1000), peak: 0.04, dur: 0.08, out: ambBus }); }] }),
    night: () => ({ parts: [loopNoise({ type: 'lowpass', f: 250, gain: 0.06 })], every: [[700, 2500], (t) => { const f = rnd(4200, 5200); for (let i = 0; i < 3; i++) tone({ t: t + i * 0.06, f, peak: 0.015, dur: 0.03, out: ambBus }); }] }),
    dread: () => ({ parts: [loopDrone([55, 58.3, 82.4], 0.045, 'sawtooth'), loopNoise({ type: 'lowpass', f: 160, gain: 0.15 })] }),
    dream: () => ({ parts: [loopDrone([261.6, 329.6, 392, 523.3], 0.018)] }),
    sacred: () => ({ parts: [loopDrone([196, 293.7, 392, 587.3], 0.02)] }),
    neon: () => ({ parts: [loopDrone([110, 165], 0.025, 'triangle'), loopNoise({ type: 'bandpass', f: 2500, q: 0.4, gain: 0.12 })] }),
    room: () => ({ parts: [loopNoise({ type: 'lowpass', f: 220, gain: 0.05 })] }),
};

/** Which bed fits a scene: weather first (outdoors), then mood and place. */
export function bedFor(scene) {
    if (!scene) return null;
    const w = scene.weather, m = scene.mood;
    if (!scene.indoor && ['rain', 'storm', 'wind', 'blizzard', 'sandstorm'].includes(w)) return w;
    if (scene.indoor && ['rain', 'storm'].includes(w)) return 'rain';
    if (m === 'abyss') return 'deep';
    if (['horror', 'nightmare', 'uncanny', 'gloom'].includes(m)) return 'dread';
    if (['dream', 'sleepy'].includes(m)) return 'dream';
    if (m === 'sacred') return 'sacred';
    if (m === 'neon') return 'neon';
    if (['cozy', 'romance', 'passion', 'festive'].includes(m) && scene.indoor) return 'fireplace';
    if (m === 'frost') return 'blizzard';
    if (!scene.indoor && scene.time === 'night') return 'night';
    if (m === 'wild') return 'wind';
    return scene.indoor ? 'room' : null;
}

function stopAmbient() {
    if (!ambient) return;
    const old = ambient; ambient = null;
    for (const id of old.timers) clearTimeout(id);
    if (!ac) return;
    for (const p of old.parts) p.g.gain.setTargetAtTime(0.0001, now(), 0.8);
    setTimeout(() => { for (const p of old.parts) for (const n of p.nodes) { try { n.stop?.(); } catch { /* */ } try { n.disconnect(); } catch { /* */ } } }, 3500);
}

export function setScene(scene) {
    wantScene = scene;
    const key = enabled && ambientOn ? bedFor(scene) : null;
    if (ambient?.key === key) return;
    if (!key) { stopAmbient(); return; }
    if (!ac || ac.state !== 'running') return; // starts on the first touch
    stopAmbient();
    const bed = BEDS[key]();
    ambient = { key, parts: bed.parts, timers: [] };
    if (bed.every) {
        const [[lo, hi], fn] = bed.every;
        const me = ambient;
        const tickOnce = () => { if (ambient !== me) return; try { fn(now() + 0.05); } catch { /* */ } me.timers.push(setTimeout(tickOnce, rnd(lo, hi))); };
        me.timers.push(setTimeout(tickOnce, rnd(lo, hi)));
    }
}

export function init() {
    const go = () => unlock();
    for (const e of ['pointerdown', 'touchstart', 'keydown']) document.addEventListener(e, go, { passive: true });
    document.addEventListener('visibilitychange', () => {
        if (!ac) return;
        if (document.hidden) ac.suspend().catch(() => {}); else if (enabled) ac.resume().catch(() => {});
    });
}
