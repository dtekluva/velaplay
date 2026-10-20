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
        '<meta name="mobile-web-app-capable" content="yes">\n<meta name="apple-mobile-web-app-capable" content="yes">\n'
        # the preview card when the link is shared (X/Twitter, WhatsApp, Facebook, iMessage, Slack...)
        '<meta name="description" content="Lagos as an open world: buy land on Banana Island, build a mansion, drive through Ikoyi, party in the clubs and play online with friends. Free in your browser.">\n'
        '<link rel="canonical" href="https://famtime.space/">\n'
        '<meta property="og:type" content="website">\n<meta property="og:site_name" content="NaijLife">\n'
        '<meta property="og:title" content="NaijLife: Lagos as an open world">\n'
        '<meta property="og:description" content="Buy land on Banana Island, build a mansion, drive through Ikoyi, party in the clubs and play online with friends. Free in your browser.">\n'
        '<meta property="og:url" content="https://famtime.space/">\n'
        '<meta property="og:image" content="https://famtime.space/og-ikoyi.jpg">\n<meta property="og:image:type" content="image/jpeg">\n'
        '<meta property="og:image:width" content="1200">\n<meta property="og:image:height" content="630">\n'
        '<meta property="og:image:alt" content="The Ikoyi skyline across the lagoon, with a jetty in front: NaijLife, Lagos as an open world">\n'
        '<meta name="twitter:card" content="summary_large_image">\n'
        '<meta name="twitter:title" content="NaijLife: Lagos as an open world">\n'
        '<meta name="twitter:description" content="Buy land on Banana Island, build a mansion, drive through Ikoyi, party in the clubs. Free in your browser.">\n'
        '<meta name="twitter:image" content="https://famtime.space/og-ikoyi.jpg">\n'
        '<meta name="twitter:image:alt" content="The Ikoyi skyline across the lagoon, with a jetty in front">\n')
open(sys.argv[2], 'w').write(head + s[:i] + '</head>\n<body>\n' + s[i:] + '\n</body>\n</html>\n')
print('game copied to', sys.argv[2], len(s) // 1024, 'KB')
PY
# the club music loops (Pixabay Content License; see ../giantwood-scouts/music/CREDITS.md) sit beside the page
MUSIC="$(dirname "$SRC")/music"
if [ -d "$MUSIC" ]; then mkdir -p server/public/music && cp "$MUSIC"/*.mp3 "$MUSIC"/CREDITS.md server/public/music/ && echo "music copied: $(ls "$MUSIC"/*.mp3 | wc -l | tr -d ' ') loops"; fi
# the realistic people (Quaternius character and animation packs, CC0; Rocketbox men in rb/, MIT; see the LICENSE files in humans/) too
HUMANS="$(dirname "$SRC")/humans"
if [ -d "$HUMANS" ]; then rm -rf server/public/humans && mkdir -p server/public/humans && cp "$HUMANS"/*.glb "$HUMANS"/*.png "$HUMANS"/*.jpg "$HUMANS"/LICENSE-*.txt server/public/humans/ && { [ ! -d "$HUMANS/rb" ] || rsync -a --exclude='.DS_Store' "$HUMANS/rb" server/public/humans/; } && echo "humans copied: $(du -sh server/public/humans | cut -f1)"; fi
# the link preview image (see the og: and twitter: tags above)
[ -f "$(dirname "$SRC")/og-ikoyi.jpg" ] && cp "$(dirname "$SRC")/og-ikoyi.jpg" server/public/og-ikoyi.jpg && echo "preview card copied"
