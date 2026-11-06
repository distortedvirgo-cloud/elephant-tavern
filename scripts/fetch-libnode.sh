#!/usr/bin/env bash
# Downloads the nodejs-mobile Android runtime (libnode.so + headers) into app/libnode.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(tr -d '[:space:]' < "$ROOT/scripts/nodejs-mobile.version")"
DEST="$ROOT/app/libnode"

if [ -f "$DEST/.version" ] && [ "$(cat "$DEST/.version")" = "$VERSION" ]; then
    echo "libnode $VERSION already present"
    exit 0
fi

TMP="$(mktemp -d)"
URL="https://github.com/digidem/nodejs-mobile/releases/download/v$VERSION/nodejs-mobile-android-$VERSION.zip"
echo "==> Downloading $URL"
curl -fSL --retry 3 -o "$TMP/libnode.zip" "$URL"
rm -rf "$DEST"
mkdir -p "$DEST"
unzip -q "$TMP/libnode.zip" -d "$DEST"
# Only the ABIs we ship.
rm -rf "$DEST/bin/x86_64" "$DEST/bin/armeabi-v7a"
test -f "$DEST/bin/arm64-v8a/libnode.so"
test -f "$DEST/include/node/node.h"
echo "$VERSION" > "$DEST/.version"
rm -rf "$TMP"
echo "libnode $VERSION ready"
