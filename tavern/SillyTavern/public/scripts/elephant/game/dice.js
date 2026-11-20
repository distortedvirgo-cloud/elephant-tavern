// The face rotations are also used in reverse to land on the engine's result.
const faces = [
    { x: 0, y: 0, pips: [5] },
    { x: 90, y: 0, pips: [1, 9] },
    { x: 0, y: 90, pips: [1, 5, 9] },
    { x: 0, y: -90, pips: [1, 3, 7, 9] },
    { x: -90, y: 0, pips: [1, 3, 5, 7, 9] },
    { x: 0, y: 180, pips: [1, 3, 4, 6, 7, 9] },
];

const sides = faces.map(({ x, y, pips }) => {
    const dots = pips.map(n => `<i style="grid-area:${Math.ceil(n / 3)} / ${(n - 1) % 3 + 1}"></i>`).join('');
    return `<span class="eg-cube-face" style="--x:${x}deg;--y:${y}deg">${dots}</span>`;
}).join('');

export function diceTray(count) {
    return Array.from({ length: count }, () => `<span class="eg-die" role="img" aria-label="Кубик"><span class="eg-cube" aria-hidden="true">${sides}</span></span>`).join('');
}

export async function landDice(tray, values, motion) {
    const animations = [];
    const dropped = values.length === 3 ? values.indexOf(Math.min(...values)) : -1;
    const dice = tray.querySelectorAll('.eg-die');
    dice.forEach((die, i) => {
        const cube = die.firstElementChild;
        const { x, y } = faces[values[i] - 1];
        const faceUp = `rotateY(${-y}deg) rotateX(${-x}deg)`;
        const start = cube.style.transform || 'rotateY(0deg) rotateX(0deg)';
        die.classList.remove('eg-die-drop');
        cube.style.transform = faceUp;
        if (motion) {
            const direction = i % 2 === 0 ? 1 : -1;
            const spin = cube.animate([
                { transform: start },
                { transform: `rotateY(${-y + 360 * direction}deg) rotateX(${-x + 360}deg)` },
            ], { duration: 560 + i * 60, easing: 'cubic-bezier(.18,.64,.24,1)' });
            animations.push(spin.finished);
        }
    });
    await Promise.all(animations);
    dice.forEach((die, i) => {
        die.classList.toggle('eg-die-drop', i === dropped);
        die.setAttribute('aria-label', `Кубик: ${values[i]}${i === dropped ? ', не учитывается' : ''}`);
    });
}
