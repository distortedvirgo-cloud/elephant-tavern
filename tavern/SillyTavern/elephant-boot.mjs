/*
 * Elephant Tavern — entry point that the Android app hands to the embedded
 * Node.js runtime. It prepares the environment for SillyTavern and then
 * imports the stock server.js.
 *
 * Environment (set by the app before node starts):
 *   ET_DATA   — persistent data directory (characters, chats, settings)
 *   ET_PORT   — port to listen on (127.0.0.1 only)
 *   ET_LOG    — log file the app shows on the splash / error screen
 */
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import os from 'node:os';

const here = import.meta.dirname;
const dataDir = process.env.ET_DATA || path.join(here, '..', 'data');
const port = String(process.env.ET_PORT || '8000');
const logFile = process.env.ET_LOG || path.join(dataDir, 'server.log');

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.dirname(logFile), { recursive: true });

// --- Log to a file as well as stdout (stdout goes to logcat) ---------------
try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 1024 * 1024) {
        fs.renameSync(logFile, logFile + '.old');
    }
} catch { /* ignore */ }
const logStream = fs.createWriteStream(logFile, { flags: 'a' });
// eslint-disable-next-line no-control-regex
const stripAnsi = s => s.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07/g, '');
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
        original(...args);
        if (level === 'debug') return;
        try {
            const line = stripAnsi(util.format(...args));
            logStream.write(`${new Date().toISOString().slice(11, 19)} ${level === 'log' ? '' : level.toUpperCase() + ' '}${line}\n`);
        } catch { /* ignore */ }
    };
}

// Android 8+ hides per-core info; some libraries expect os.cpus() to be a non-empty array.
try {
    const cpus = os.cpus();
    if (!Array.isArray(cpus) || cpus.length === 0) {
        const n = typeof os.availableParallelism === 'function' ? os.availableParallelism() : 4;
        const fake = Array.from({ length: n }, () => ({ model: 'arm64', speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } }));
        os.cpus = () => fake;
    }
} catch { /* ignore */ }

process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

// --- SillyTavern configuration overrides (env beats config.yaml) ----------
const defaults = {
    SILLYTAVERN_LISTEN: 'false',
    SILLYTAVERN_PORT: port,
    SILLYTAVERN_WHITELISTMODE: 'true',
    SILLYTAVERN_BROWSERLAUNCH_ENABLED: 'false',
    SILLYTAVERN_PERFORMANCE_LAZYLOADCHARACTERS: 'true',
    SILLYTAVERN_HEARTBEATINTERVAL: '0',
    ST_FORCE_DIST: '1',
};
for (const [k, v] of Object.entries(defaults)) {
    if (process.env[k] === undefined) process.env[k] = v;
}

console.log(`[Elephant Tavern] node ${process.version} (${process.versions.mobile ? 'mobile ' + process.versions.mobile : 'desktop'}), data: ${dataDir}, port ${port}`);

process.argv = [
    process.argv[0],
    path.join(here, 'server.js'),
    '--configPath', path.join(dataDir, 'config.yaml'),
    '--dataRoot', dataDir,
    '--port', port,
    '--listen', 'false',
    '--browserLaunchEnabled', 'false',
];

await import('./server.js');
