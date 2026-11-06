/*
 * Elephant Stage — ambient effects layer.
 * One full-screen canvas under the chat, a small particle system and a few
 * one-shot "events" (hit, flash, hearts, lightning). Cheap by design: capped
 * particle counts, DPR capped at 1.5, paused when the page is hidden.
 */

const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);

/** Ambient presets: how many particles and how they look/move. */
const AMBIENT = {
    none: null,
    dust: { count: 26, spawn: p => base(p, { r: rand(0.6, 1.8), vx: rand(-4, 4), vy: rand(-3, 3), a: rand(0.15, 0.4), color: '255,240,220', glow: 0 }) },
    rain: { count: 90, spawn: p => base(p, { len: rand(10, 22), vx: -60, vy: rand(520, 760), a: rand(0.25, 0.5), color: '190,210,255', kind: 'line' }) },
    storm: { count: 140, spawn: p => base(p, { len: rand(16, 30), vx: -160, vy: rand(800, 1100), a: rand(0.3, 0.6), color: '200,215,255', kind: 'line' }) },
    snow: { count: 70, spawn: p => base(p, { r: rand(1.2, 3.2), vx: rand(-14, 14), vy: rand(22, 55), a: rand(0.5, 0.9), color: '255,255,255', sway: rand(0.5, 1.6) }) },
    embers: { count: 40, spawn: p => base(p, { r: rand(1, 2.6), vx: rand(-12, 12), vy: rand(-70, -30), a: rand(0.5, 0.95), color: '255,150,60', glow: 8, fromBottom: true, life: rand(3, 7) }) },
    fireflies: { count: 22, spawn: p => base(p, { r: rand(1.4, 2.4), vx: rand(-10, 10), vy: rand(-10, 10), a: 0.9, color: '210,255,140', glow: 12, pulse: rand(0.6, 1.6), wander: true, anywhere: true }) },
    stars: { count: 60, spawn: p => base(p, { r: rand(0.5, 1.4), vx: 0, vy: 0, a: rand(0.3, 0.9), color: '255,255,255', pulse: rand(0.3, 1.2), topOnly: true }) },
    petals: { count: 26, spawn: p => base(p, { r: rand(3, 6), vx: rand(10, 40), vy: rand(30, 60), a: rand(0.6, 0.9), color: '255,170,200', kind: 'petal', spin: rand(-2, 2), sway: rand(0.6, 1.4) }) },
    fog: { count: 7, spawn: p => base(p, { r: rand(160, 320), vx: rand(-8, 8), vy: rand(-2, 2), a: rand(0.05, 0.11), color: '200,205,220', kind: 'fog' }) },
    sparkles: { count: 30, spawn: p => base(p, { r: rand(0.8, 2), vx: rand(-6, 6), vy: rand(-18, -4), a: 0.9, color: '200,170,255', glow: 10, pulse: rand(1, 3), life: rand(2, 5), anywhere: true }) },
    ash: { count: 34, spawn: p => base(p, { r: rand(1, 2.4), vx: rand(-20, 20), vy: rand(10, 30), a: rand(0.2, 0.5), color: '160,150,150', sway: rand(0.4, 1) }) },
};

function base(p, o) {
    return Object.assign(p, { x: 0, y: 0, r: 2, len: 0, vx: 0, vy: 0, a: 1, color: '255,255,255', glow: 0, kind: 'dot', spin: 0, rot: rand(0, TAU), sway: 0, pulse: 0, t: rand(0, 10), life: 0, age: 0, fromBottom: false, topOnly: false, wander: false, anywhere: false }, o);
}

export class Effects {
    constructor() {
        this.canvas = document.createElement('canvas');
        this.canvas.id = 'et-fx';
        this.ctx = this.canvas.getContext('2d');
        this.particles = [];
        this.bursts = [];
        this.preset = 'none';
        this.layers = [];
        this.intensity = 1;
        this.enabled = true;
        this.running = false;
        this.last = 0;
        this.resize = this.resize.bind(this);
        this.frame = this.frame.bind(this);
        window.addEventListener('resize', this.resize);
        document.addEventListener('visibilitychange', () => document.hidden ? this.stop() : this.start());
    }

    mount(parent) {
        parent.appendChild(this.canvas);
        this.resize();
    }

    resize() {
        const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
        this.dpr = dpr;
        this.w = window.innerWidth;
        this.h = window.innerHeight;
        this.canvas.width = Math.round(this.w * dpr);
        this.canvas.height = Math.round(this.h * dpr);
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    /** layers: list of ambient preset names, e.g. ['rain', 'fog']. */
    setAmbient(layers, intensity = 1) {
        const list = (Array.isArray(layers) ? layers : [layers]).filter(n => AMBIENT[n]);
        const key = list.join('+');
        this.intensity = Math.max(0, Math.min(1.5, intensity));
        if (key === this.layers.join('+')) return;
        this.layers = list;
        // Let existing particles fade out naturally; new ones use the new presets.
        for (const p of this.particles) p.dying = true;
        for (const name of list) {
            const preset = AMBIENT[name];
            const n = Math.round(preset.count * this.intensity);
            for (let i = 0; i < n; i++) this.particles.push(this.spawn(name, true));
        }
        this.start();
    }

    spawn(name, scatter) {
        const p = AMBIENT[name].spawn({});
        p.preset = name;
        p.fade = scatter ? 0 : 1;
        p.x = rand(0, this.w);
        if (p.kind === 'fog') {
            p.y = rand(this.h * 0.2, this.h);
        } else if (p.anywhere) {
            p.y = rand(this.h * 0.1, this.h * 0.95);
            if (!scatter) p.fade = 0;
        } else if (p.topOnly) {
            p.y = rand(0, this.h * 0.45);
        } else if (p.fromBottom) {
            p.y = scatter ? rand(0, this.h) : this.h + 10;
        } else {
            p.y = scatter ? rand(0, this.h) : -20;
        }
        if (p.life) p.age = scatter ? rand(0, p.life) : 0;
        return p;
    }

    /** One-shot visual events. */
    burst(kind, opts = {}) {
        if (!this.enabled) return;
        const cx = opts.x ?? this.w / 2;
        const cy = opts.y ?? this.h * 0.55;
        const make = (n, f) => { for (let i = 0; i < n; i++) this.bursts.push(f(i)); };
        switch (kind) {
            case 'hearts':
                make(14, () => ({ kind: 'heart', x: cx + rand(-80, 80), y: cy + rand(0, 60), vx: rand(-20, 20), vy: rand(-110, -60), r: rand(6, 12), a: 1, life: rand(1.6, 2.6), age: 0, color: '255,110,160' }));
                break;
            case 'sparks':
                make(26, () => { const ang = rand(0, TAU), sp = rand(160, 420); return { kind: 'spark', x: cx, y: cy, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, r: rand(1, 2.4), a: 1, life: rand(0.35, 0.8), age: 0, color: '255,200,120' }; });
                break;
            case 'magic':
                make(30, () => { const ang = rand(0, TAU), sp = rand(30, 140); return { kind: 'glow', x: cx + rand(-40, 40), y: cy + rand(-40, 40), vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - 30, r: rand(1, 3), a: 1, life: rand(0.8, 1.8), age: 0, color: '190,160,255' }; });
                break;
            case 'blood':
                make(18, () => { const ang = rand(Math.PI * 1.1, Math.PI * 1.9), sp = rand(120, 300); return { kind: 'drop', x: cx, y: cy, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, r: rand(1.5, 3.5), a: 0.9, life: rand(0.6, 1.1), age: 0, g: 700, color: '170,20,30' }; });
                break;
            default:
                return;
        }
        this.start();
    }

    start() {
        if (this.running || !this.enabled || document.hidden) return;
        if (!this.particles.length && !this.bursts.length) return;
        this.running = true;
        this.last = performance.now();
        requestAnimationFrame(this.frame);
    }

    stop() {
        this.running = false;
    }

    clear() {
        this.particles = [];
        this.bursts = [];
        this.layers = [];
        this.ctx.clearRect(0, 0, this.w, this.h);
    }

    setEnabled(on) {
        this.enabled = on;
        if (!on) {
            this.stop();
            this.clear();
        }
    }

    frame(now) {
        if (!this.running) return;
        const dt = Math.min(0.05, (now - this.last) / 1000);
        this.last = now;
        const c = this.ctx;
        c.clearRect(0, 0, this.w, this.h);

        const keep = [];
        for (const p of this.particles) {
            p.t += dt;
            if (p.dying) p.fade -= dt * 0.8;
            else if (p.fade < 1) p.fade = Math.min(1, p.fade + dt * 0.7);
            if (p.fade <= 0) continue;

            if (p.wander) {
                p.vx += rand(-30, 30) * dt;
                p.vy += rand(-30, 30) * dt;
                p.vx = Math.max(-18, Math.min(18, p.vx));
                p.vy = Math.max(-18, Math.min(18, p.vy));
            }
            const sway = p.sway ? Math.sin(p.t * p.sway) * 18 : 0;
            p.x += (p.vx + sway) * dt;
            p.y += p.vy * dt;
            p.rot += p.spin * dt;

            if (p.life) {
                p.age += dt;
                if (p.age > p.life) {
                    if (p.dying) continue;
                    Object.assign(p, this.spawn(p.preset, false));
                }
            }
            const out = p.kind === 'fog' ? (p.x < -p.r || p.x > this.w + p.r)
                : (p.y > this.h + 30 || p.y < -40 || p.x < -40 || p.x > this.w + 40);
            if (out) {
                if (p.dying) continue;
                if (p.kind === 'fog') p.x = p.vx > 0 ? -p.r : this.w + p.r;
                else Object.assign(p, this.spawn(p.preset, false));
            }
            this.draw(c, p, p.fade);
            keep.push(p);
        }
        this.particles = keep;

        const keepB = [];
        for (const b of this.bursts) {
            b.age += dt;
            if (b.age >= b.life) continue;
            if (b.g) b.vy += b.g * dt;
            b.x += b.vx * dt;
            b.y += b.vy * dt;
            b.vx *= 0.985;
            const k = 1 - b.age / b.life;
            this.drawBurst(c, b, k);
            keepB.push(b);
        }
        this.bursts = keepB;

        if (!this.particles.length && !this.bursts.length) {
            this.running = false;
            c.clearRect(0, 0, this.w, this.h);
            return;
        }
        requestAnimationFrame(this.frame);
    }

    draw(c, p, fade) {
        let alpha = p.a * fade;
        if (p.pulse) alpha *= 0.55 + 0.45 * Math.sin(p.t * p.pulse * 2);
        if (p.life) alpha *= Math.min(1, (p.life - p.age) / 1.2, p.age / 0.6 + 0.1);
        if (alpha <= 0.01) return;
        const col = `rgba(${p.color},${alpha.toFixed(3)})`;
        switch (p.kind) {
            case 'line':
                c.strokeStyle = col;
                c.lineWidth = 1;
                c.beginPath();
                c.moveTo(p.x, p.y);
                c.lineTo(p.x + p.vx * 0.02, p.y - p.len);
                c.stroke();
                break;
            case 'fog': {
                const g = c.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
                g.addColorStop(0, col);
                g.addColorStop(1, `rgba(${p.color},0)`);
                c.fillStyle = g;
                c.fillRect(p.x - p.r, p.y - p.r, p.r * 2, p.r * 2);
                break;
            }
            case 'petal':
                c.save();
                c.translate(p.x, p.y);
                c.rotate(p.rot);
                c.fillStyle = col;
                c.beginPath();
                c.ellipse(0, 0, p.r, p.r * 0.55, 0, 0, TAU);
                c.fill();
                c.restore();
                break;
            default:
                if (p.glow) {
                    c.shadowBlur = p.glow;
                    c.shadowColor = `rgba(${p.color},${alpha.toFixed(3)})`;
                }
                c.fillStyle = col;
                c.beginPath();
                c.arc(p.x, p.y, p.r, 0, TAU);
                c.fill();
                c.shadowBlur = 0;
        }
    }

    drawBurst(c, b, k) {
        const col = `rgba(${b.color},${(b.a * k).toFixed(3)})`;
        if (b.kind === 'heart') {
            const s = b.r * (0.8 + 0.4 * (1 - k));
            c.save();
            c.translate(b.x, b.y);
            c.fillStyle = col;
            c.beginPath();
            c.moveTo(0, s * 0.3);
            c.bezierCurveTo(-s, -s * 0.5, -s * 0.4, -s * 1.2, 0, -s * 0.5);
            c.bezierCurveTo(s * 0.4, -s * 1.2, s, -s * 0.5, 0, s * 0.3);
            c.fill();
            c.restore();
            return;
        }
        if (b.kind === 'spark') {
            c.strokeStyle = col;
            c.lineWidth = b.r;
            c.beginPath();
            c.moveTo(b.x, b.y);
            c.lineTo(b.x - b.vx * 0.03, b.y - b.vy * 0.03);
            c.stroke();
            return;
        }
        if (b.kind === 'glow') {
            c.shadowBlur = 12;
            c.shadowColor = col;
        }
        c.fillStyle = col;
        c.beginPath();
        c.arc(b.x, b.y, b.r, 0, TAU);
        c.fill();
        c.shadowBlur = 0;
    }
}

export const AMBIENT_PRESETS = Object.keys(AMBIENT);
