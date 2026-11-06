#!/usr/bin/env bash
# Builds the SillyTavern bundle that ships inside the APK:
#   app/src/main/assets/tavern.zip  — the SillyTavern fork + node_modules + Elephant Memory
#   app/src/main/assets/tavern.json — version info and entry count (for the install progress bar)
#
# Requires: git, node >= 20, npm, zip, python3, tar.
# The SillyTavern fork (with Elephant Core) is tavern/SillyTavern in this repo.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAVERN="$ROOT/tavern"
WORK="$ROOT/build/tavern"
ST="$WORK/SillyTavern"
ASSETS="$ROOT/app/src/main/assets"

EM_REPO="https://github.com/distortedvirgo-cloud/SillyTavern-ElephantMemory"
EM_REF="$(tr -d '[:space:]' < "$TAVERN/elephant-memory.version")"
ST_REF="$(node -p "require('$TAVERN/SillyTavern/package.json').version")-elephant"

echo "==> SillyTavern fork ($ST_REF)"
rm -rf "$WORK"
mkdir -p "$WORK"
# The fork lives in the repo (tavern/SillyTavern): copy it without local state.
(cd "$TAVERN/SillyTavern" && tar --exclude=./node_modules --exclude=./data --exclude=./dist --exclude=./config.yaml -cf - .) | (mkdir -p "$ST" && cd "$ST" && tar -xf -)

echo "==> Elephant Memory"
EXT="$ST/public/scripts/extensions/third-party"
mkdir -p "$EXT"
git clone --quiet "$EM_REPO" "$EXT/ElephantMemory"
git -C "$EXT/ElephantMemory" -c advice.detachedHead=false checkout --quiet "$EM_REF"
EM_COMMIT="$(git -C "$EXT/ElephantMemory" rev-parse --short HEAD)"
rm -rf "$EXT/ElephantMemory/.git"

echo "==> npm ci (production)"
(cd "$ST" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)

echo "==> Pre-compiling frontend libraries"
(cd "$ST" && node docker/build-lib.js > /dev/null)
test -f "$ST/dist/_webpack/"*/output/lib.js

echo "==> Pruning"
find "$ST/node_modules" -type f \( -name '*.map' -o -name '*.md' -o -name '*.markdown' -o -name '*.ts' ! -name '*.d.ts' \
    -o -name 'CHANGELOG*' -o -name '*.flow' -o -name '.npmignore' -o -name '.eslintrc*' -o -name '.travis.yml' \) -delete
find "$ST/node_modules" -type f -name '*.d.ts' -delete
find "$ST/node_modules" -depth -type d \( -name test -o -name tests -o -name __tests__ -o -name docs -o -name example -o -name examples -o -name .github \) \
    -exec rm -rf {} + 2>/dev/null || true
# webpack is only needed for the (already done) frontend build at runtime,
# but SillyTavern imports it on startup, so it stays.

echo "==> Packing"
mkdir -p "$ASSETS"
rm -f "$ASSETS/tavern.zip"
(cd "$ST" && zip -q -r -9 -X "$ASSETS/tavern.zip" .)
COUNT="$(python3 -c "import zipfile,sys;print(len(zipfile.ZipFile(sys.argv[1]).infolist()))" "$ASSETS/tavern.zip")"
SIZE="$(du -sm "$ST" | cut -f1)"
BUILD_ID="$(sha1sum "$ASSETS/tavern.zip" | cut -c1-12)"
cat > "$ASSETS/tavern.json" <<EOF
{
  "stVersion": "$ST_REF",
  "elephantMemory": "$EM_COMMIT",
  "build": "$BUILD_ID",
  "entries": $COUNT,
  "unpackedMb": $SIZE
}
EOF
cat "$ASSETS/tavern.json"
du -h "$ASSETS/tavern.zip"
