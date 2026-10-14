#!/usr/bin/env bash
# Copy the game (../giantwood-scouts/index.html, the single-file Giantwood game) into server/public/index.html,
# wrapped as a full page, so the server hosts the game itself at its home page.
set -euo pipefail
cd "$(dirname "$0")/.."
SRC="${GAME_SRC:-../giantwood-scouts/index.html}"
[ -f "$SRC" ] || { echo "game not found at $SRC (set GAME_SRC)" >&2; exit 1; }
python3 - "$SRC" server/public/index.html <<'PY'
import sys
s = open(sys.argv[1]).read(); i = s.index('<div id="app">')
head = ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover, user-scalable=no">\n'
        '<meta name="mobile-web-app-capable" content="yes">\n<meta name="apple-mobile-web-app-capable" content="yes">\n')
open(sys.argv[2], 'w').write(head + s[:i] + '</head>\n<body>\n' + s[i:] + '\n</body>\n</html>\n')
print('game copied to', sys.argv[2], len(s) // 1024, 'KB')
PY
# the club music loops (Pixabay Content License; see ../giantwood-scouts/music/CREDITS.md) sit beside the page
MUSIC="$(dirname "$SRC")/music"
if [ -d "$MUSIC" ]; then mkdir -p server/public/music && cp "$MUSIC"/*.mp3 "$MUSIC"/CREDITS.md server/public/music/ && echo "music copied: $(ls "$MUSIC"/*.mp3 | wc -l | tr -d ' ') loops"; fi
