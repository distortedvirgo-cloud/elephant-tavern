#!/usr/bin/env node
/*
 * Applies Elephant Tavern changes to a clean SillyTavern checkout.
 * Usage: node patch-st.mjs <path-to-sillytavern>
 *
 * Patches are string replacements that fail loudly when the upstream code
 * changes, so a SillyTavern bump never silently ships without them.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? '');
if (!fs.existsSync(path.join(root, 'server.js'))) {
    console.error('Not a SillyTavern directory:', root);
    process.exit(1);
}

let failed = false;
function patch(file, search, replace, { optional = false } = {}) {
    const full = path.join(root, file);
    const text = fs.readFileSync(full, 'utf8');
    if (text.includes(replace)) {
        console.log(`= ${file}: already patched`);
        return;
    }
    if (!text.includes(search)) {
        console.error(`${optional ? '?' : '!'} ${file}: pattern not found:\n    ${search.split('\n')[0]}`);
        if (!optional) failed = true;
        return;
    }
    fs.writeFileSync(full, text.replace(search, replace));
    console.log(`+ ${file}`);
}

// 1. Frontend libraries are pre-compiled at build time into ./dist (like the
//    Docker image does), so the phone does not run a cold webpack build.
patch('webpack.config.js',
    'if (forceDist || isDocker()) {',
    'if (forceDist || isDocker() || process.env.ST_FORCE_DIST === \'1\') {');

// 2. Mobile shell styles load before SillyTavern renders anything,
//    so there is no flash of the desktop layout.
patch('public/index.html',
    '<link rel="stylesheet" type="text/css" href="style.css">',
    '<link rel="stylesheet" type="text/css" href="style.css">\n' +
    '    <link rel="stylesheet" type="text/css" href="scripts/extensions/third-party/ElephantStage/early.css">');

patch('public/index.html',
    '<meta name="theme-color" content="#333">',
    '<meta name="theme-color" content="#0d0f14">');

// 3. Branding in the page title.
patch('public/index.html', '<title>SillyTavern</title>', '<title>Elephant Tavern</title>', { optional: true });

if (failed) {
    console.error('Some patches failed. Update tavern/patch-st.mjs for this SillyTavern version.');
    process.exit(1);
}
