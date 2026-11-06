/*
 * Elephant Stage — scene reading.
 * Turns the latest message (+ Elephant Memory's state card when present)
 * into a scene: mood, weather, time of day, place and one-shot events.
 *
 * Two layers:
 *   1. heuristics — instant and free, English + Russian keywords;
 *   2. the cheap helper model — a short JSON verdict that overrides them.
 */

/** Visual identity of each mood. Colours are used for CSS variables. */
export const MOODS = {
    calm:     { label: 'Спокойно',    icon: '🌿', accent: '#9fd8c4', accent2: '#6aa8ff', bgA: '#0e1418', bgB: '#101a1f', glow: 0.18, haptic: null },
    cozy:     { label: 'Уютно',       icon: '🕯️', accent: '#ffc58a', accent2: '#ff9f6b', bgA: '#17110c', bgB: '#1d140e', glow: 0.22, haptic: null },
    joy:      { label: 'Радость',     icon: '✨', accent: '#ffe08a', accent2: '#8ad7ff', bgA: '#141420', bgB: '#191a28', glow: 0.25, haptic: 'tick' },
    romance:  { label: 'Романтика',   icon: '💗', accent: '#ff8fb8', accent2: '#c08bff', bgA: '#1a0f17', bgB: '#22111d', glow: 0.3, haptic: 'heartbeat' },
    tension:  { label: 'Напряжение',  icon: '⚡', accent: '#ffb35c', accent2: '#ff5c5c', bgA: '#16100c', bgB: '#1c0f0d', glow: 0.25, haptic: 'tick' },
    combat:   { label: 'Бой',         icon: '⚔️', accent: '#ff5d5d', accent2: '#ffae42', bgA: '#1a0a0a', bgB: '#240d0b', glow: 0.35, haptic: 'hit' },
    mystery:  { label: 'Тайна',       icon: '🔮', accent: '#a98bff', accent2: '#4fd1c5', bgA: '#0f0d1c', bgB: '#120f24', glow: 0.28, haptic: null },
    horror:   { label: 'Жуть',        icon: '🩸', accent: '#c23b3b', accent2: '#6b7a8f', bgA: '#0a0a0c', bgB: '#120a0b', glow: 0.2, haptic: 'heartbeat' },
    sad:      { label: 'Грусть',      icon: '🌧️', accent: '#8fb0d9', accent2: '#7b86a8', bgA: '#0d1118', bgB: '#10141d', glow: 0.15, haptic: null },
    epic:     { label: 'Эпично',      icon: '🔥', accent: '#ffcf5a', accent2: '#ff6b3d', bgA: '#170f08', bgB: '#1f1309', glow: 0.35, haptic: 'rumble' },
};

export const WEATHER = { clear: '☀️', rain: '🌧️', storm: '⛈️', snow: '❄️', fog: '🌫️', ash: '🌋' };
export const TIMES = { day: 'день', night: 'ночь', dusk: 'сумерки', dawn: 'рассвет' };

const KEYWORDS = {
    combat: ['sword', 'blade', 'strike', 'struck', 'slash', 'punch', 'kick', 'attack', 'fight', 'battle', 'parry', 'dodge', 'arrow', 'blood', 'wound', 'stab', 'shot', 'gun', 'fire at', 'lunges', 'clash',
        'меч', 'удар', 'бой', 'битв', 'атак', 'рана', 'кровь', 'выстрел', 'клинок', 'парир', 'увернул'],
    romance: ['kiss', 'blush', 'lips', 'embrace', 'caress', 'heart races', 'love', 'tender', 'cuddle', 'hold hands', 'gaze into', 'whisper softly', 'darling', 'sweetheart',
        'поцел', 'румян', 'губ', 'объят', 'нежн', 'любл', 'ласк', 'милый', 'милая'],
    tension: ['tense', 'glare', 'threat', 'warn', 'danger', 'suspicious', 'trap', 'freeze', 'silence fell', 'heart pounding', 'nervous', 'growl', 'clench',
        'напряж', 'угроз', 'опасн', 'ловушк', 'замер', 'тревог', 'нервн', 'рычит'],
    horror: ['scream', 'corpse', 'rotting', 'shadow moved', 'creature', 'monster', 'eerie', 'dread', 'terror', 'ghost', 'whispering voices', 'flesh',
        'крик', 'труп', 'чудовищ', 'монстр', 'жутк', 'ужас', 'призрак', 'плоть'],
    mystery: ['strange', 'ancient', 'secret', 'rune', 'glyph', 'riddle', 'mysterious', 'magic', 'spell', 'arcane', 'glowing symbol', 'prophecy',
        'странн', 'древн', 'тайн', 'загадк', 'магия', 'заклин', 'руна', 'пророч'],
    sad: ['tears', 'cry', 'sob', 'grief', 'mourn', 'lonely', 'loss', 'funeral', 'sorrow', 'regret',
        'слёз', 'слез', 'плач', 'горе', 'одинок', 'потер', 'похорон', 'печал', 'сожал'],
    joy: ['laugh', 'grin', 'cheer', 'celebrat', 'giggle', 'smile wide', 'dance', 'festival', 'party', 'joke',
        'смех', 'смеёт', 'улыб', 'праздн', 'танц', 'шутк', 'веселье'],
    cozy: ['fireplace', 'hearth', 'blanket', 'tea', 'warm', 'candle', 'tavern', 'inn', 'cozy', 'soup', 'bed',
        'камин', 'очаг', 'плед', 'чай', 'тепл', 'свеч', 'таверн', 'уют'],
    epic: ['army', 'dragon', 'roar', 'legend', 'thunderous', 'throne', 'kingdom', 'titan', 'ascend', 'destiny',
        'армия', 'дракон', 'рёв', 'легенд', 'трон', 'королевств', 'судьб'],
};

const WEATHER_WORDS = {
    storm: ['thunder', 'lightning', 'storm', 'гроза', 'молни', 'гром', 'шторм', 'буря'],
    rain: ['rain', 'drizzle', 'downpour', 'wet streets', 'дожд', 'ливень', 'морось'],
    snow: ['snow', 'blizzard', 'frost', 'snowflake', 'снег', 'метел', 'вьюг', 'мороз'],
    fog: ['fog', 'mist', 'haze', 'туман', 'дымк', 'мгла'],
    ash: ['ash', 'volcano', 'smoke-filled', 'пепел', 'вулкан'],
};

const TIME_WORDS = {
    night: ['night', 'moon', 'midnight', 'stars', 'darkness', 'ночь', 'ночн', 'лун', 'полночь', 'звёзд', 'звезд'],
    dusk: ['sunset', 'dusk', 'evening', 'twilight', 'закат', 'сумерк', 'вечер'],
    dawn: ['dawn', 'sunrise', 'morning light', 'рассвет', 'утро', 'утренн'],
    day: ['noon', 'midday', 'sunlight', 'afternoon', 'полдень', 'днём', 'солнечн'],
};

const EVENT_WORDS = {
    hit: ['punch', 'struck', 'slams', 'slammed', 'kicks', 'hits him', 'hits her', 'hits you', 'impact', 'crash into', 'удар', 'врезал', 'бьёт', 'пнул'],
    blood: ['blood spurt', 'bleeding', 'blood sprays', 'stabbed', 'кровь хлын', 'истекает кровью', 'пронзил'],
    explosion: ['explosion', 'explodes', 'blast', 'boom', 'взрыв', 'взорвал'],
    lightning: ['lightning', 'thunder crack', 'молния', 'раскат грома'],
    kiss: ['kiss', 'kisses', 'kissed', 'поцел', 'целует'],
    magic: ['spell', 'casts', 'glowing runes', 'magic surges', 'заклинан', 'колдует', 'магия вспых'],
    heartbeat: ['heart pounding', 'heartbeat', 'heart races', 'сердце колот', 'сердцебиен'],
};

const INDOOR = ['room', 'hall', 'tavern', 'inn', 'house', 'chamber', 'library', 'kitchen', 'bedroom', 'office', 'cave', 'castle', 'комнат', 'зал', 'таверн', 'дом', 'библиотек', 'кухн', 'спальн', 'пещер', 'замок'];

// Words match at a word start ("tea" must not hit "instead"), Cyrillic included.
const regexCache = new Map();
function wordRegex(w) {
    let r = regexCache.get(w);
    if (!r) {
        r = new RegExp(`(?:^|[^\\p{L}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gu');
        regexCache.set(w, r);
    }
    r.lastIndex = 0;
    return r;
}

function count(text, words) {
    let n = 0;
    for (const w of words) {
        const m = text.match(wordRegex(w));
        if (m) n += m.length;
    }
    return n;
}

function best(text, table) {
    let top = null;
    let score = 0;
    for (const [k, words] of Object.entries(table)) {
        const s = count(text, words);
        if (s > score) { score = s; top = k; }
    }
    return { key: top, score };
}

/** Instant scene guess from raw text. */
export function heuristicScene(text, previous = null) {
    const t = String(text || '').toLowerCase();
    const mood = best(t, KEYWORDS);
    const weather = best(t, WEATHER_WORDS);
    const time = best(t, TIME_WORDS);
    const events = Object.entries(EVENT_WORDS).filter(([, w]) => count(t, w) > 0).map(([k]) => k);
    const indoor = count(t, INDOOR) > 0;
    const prev = previous || {};
    return {
        mood: mood.score >= 2 ? mood.key : (mood.score === 1 && !prev.mood ? mood.key : prev.mood || 'calm'),
        intensity: Math.min(1, 0.35 + mood.score * 0.12),
        weather: weather.score ? weather.key : (prev.weather || 'clear'),
        time: time.score ? time.key : (prev.time || 'day'),
        indoor: indoor || (prev.indoor ?? false),
        location: prev.location || '',
        events,
        source: 'heuristic',
    };
}

/** Prompt for the helper model. Kept tiny so it costs almost nothing. */
export function scenePrompt({ message, state, previous, user, char }) {
    return `You classify the current moment of a roleplay between ${user} and ${char} for an app that adapts its visuals to the scene.

${state ? `Story state card:\n<state>\n${state}\n</state>\n\n` : ''}Previous scene: ${previous ? JSON.stringify({ mood: previous.mood, weather: previous.weather, time: previous.time, location: previous.location }) : 'unknown'}

Latest message:
<message>
${message}
</message>

Answer with ONE line of minified JSON, nothing else:
{"mood":"calm|cozy|joy|romance|tension|combat|mystery|horror|sad|epic","intensity":0.0-1.0,"weather":"clear|rain|storm|snow|fog|ash","time":"day|night|dusk|dawn","indoor":true|false,"location":"2-4 words","events":["hit"|"blood"|"explosion"|"lightning"|"kiss"|"magic"|"heartbeat"],"changed":true|false}
"changed" = the location or situation clearly changed compared to the previous scene. "events" = only things that physically happen in THIS message (usually empty). Keep weather/time from the previous scene unless the message changes them.`;
}

export function parseSceneJson(text) {
    if (!text) return null;
    const m = String(text).match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
        const o = JSON.parse(m[0]);
        const scene = {
            mood: MOODS[o.mood] ? o.mood : 'calm',
            intensity: Math.max(0, Math.min(1, Number(o.intensity) || 0.5)),
            weather: WEATHER[o.weather] ? o.weather : 'clear',
            time: TIMES[o.time] ? o.time : 'day',
            indoor: Boolean(o.indoor),
            location: String(o.location || '').slice(0, 40),
            events: Array.isArray(o.events) ? o.events.filter(e => EVENT_WORDS[e]) : [],
            changed: Boolean(o.changed),
            source: 'llm',
        };
        return scene;
    } catch {
        return null;
    }
}

/** Which ambient particle layers a scene gets. */
export function ambientFor(scene) {
    const layers = [];
    if (!scene.indoor) {
        if (scene.weather === 'rain') layers.push('rain');
        if (scene.weather === 'storm') layers.push('storm');
        if (scene.weather === 'snow') layers.push('snow');
        if (scene.weather === 'ash') layers.push('ash');
        if (scene.weather === 'fog') layers.push('fog');
        if (scene.time === 'night' && scene.weather === 'clear') layers.push(scene.mood === 'romance' || scene.mood === 'calm' ? 'fireflies' : 'stars');
    } else if (scene.weather === 'fog') {
        layers.push('fog');
    }
    switch (scene.mood) {
        case 'cozy': layers.push('embers'); break;
        case 'romance': layers.push('petals'); break;
        case 'mystery': layers.push('sparkles'); break;
        case 'epic': layers.push('embers'); break;
        case 'horror': layers.push('fog'); break;
        case 'sad': if (!layers.length) layers.push('dust'); break;
        default: if (scene.indoor && !layers.length) layers.push('dust');
    }
    return [...new Set(layers)].slice(0, 2);
}

export function describeScene(scene) {
    if (!scene) return '';
    const parts = [];
    if (scene.location) parts.push(scene.location);
    if (scene.time && scene.time !== 'day') parts.push(TIMES[scene.time]);
    if (scene.weather && scene.weather !== 'clear') parts.push(WEATHER[scene.weather]);
    return parts.join(' · ');
}
