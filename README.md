# VelaPlay

The online backend for **Giantwood**, the game in `../giantwood-scouts`. It has player accounts, saved characters and cloud saves, plus a shared real-time world where everyone sees each other move and chat.

**Play online:** <https://46-101-63-217.sslip.io>. That's the full game: sign in or play as a guest, make your scout, and press Deploy to join the shared world. A bare-bones test page lives at `/test.html`.

HTTPS uses a free `sslip.io` name that points at the Droplet's IP, and Caddy fetches the certificate automatically. To switch to your own domain, point it at `46.101.63.217`, set `SITE_ADDRESS` in the server's `.env` and redeploy.

## What runs where

All of it is self-hosted on one DigitalOcean Droplet in London: `giantwood-game`, 2 vCPU / 4 GB, $24/mo, Ubuntu 24.04. The Droplet runs Docker Compose with three containers:

| Container | What it does |
|---|---|
| `caddy` | Takes ports 80/443 and forwards everything to the server. When `SITE_ADDRESS` is set to a domain, it fetches HTTPS certificates itself. |
| `server` | Node 22 + TypeScript. It serves the REST API under `/api`, the Colyseus WebSocket rooms, and the files in `server/public`: the game at `/`, the test page at `/test.html`, and a browser build of `colyseus.js` in `/vendor`. |
| `db` | PostgreSQL 16 holding users, characters and saves. Its data lives in the `dbdata` volume. |
| `turn` | coturn, the TURN relay for voice chat, for players whose networks block direct connections. It uses host networking on UDP/TCP 3478 with relay ports 49160–49200, and logins are short-lived HMAC credentials from `/api/turn`. |

The DigitalOcean firewall `giantwood-fw` (tag `giantwood`) allows only ports 22, 80 and 443, plus 3478 and 49160–49200 for the voice relay. SSH accepts only the `INYANG-MAC` key, password login is off, and fail2ban is running.

## API

| Method and path | Auth | What |
|---|---|---|
| `GET /api/health` | | Server and database status |
| `POST /api/auth/register` | | `{ email, password (8+), name }` → `{ token, user }` |
| `POST /api/auth/login` | | `{ email, password }` → `{ token, user }` |
| `GET /api/me` | Bearer | Your account and character |
| `PUT /api/character` | Bearer | Your look. Only known fields are accepted (colours as `#rrggbb`, `hairStyle`, `build`, `hat`, `shades`…) |
| `GET /api/world` | | Every owned or sold-on plot: owner name, house (type, side, furniture, fence), bulldozer edits |
| `GET /api/land/state` | Bearer | Your money, bulldozer, plots and edits, plus the `version` you're on |
| `POST /api/land/sync` | Bearer | `{ base, state }`: your land record after a change (see below) |
| `GET /api/trade/offers` | Bearer | Your open land offers, `incoming` and `outgoing`, plus `limits` `{ cap, left, canPay }` |
| `POST /api/trade/offers` | Bearer | `{ key, to, price }`: offer your plot (with its house) to a player by name. `price` 0 is a gift |
| `POST /api/trade/offers/:id/accept` | Bearer | `{ base }`: the buyer takes it. Land and money move in one transaction |
| `POST /api/trade/offers/:id/decline` | Bearer | The buyer turns it down |
| `POST /api/trade/offers/:id/cancel` | Bearer | The seller withdraws it |
| `POST /api/trade/pay` | Bearer | `{ to, amount, base }`: send money to a player |
| `GET/PUT /api/save` | Bearer | The old raw cloud save (no longer used by the game) |

Tokens are JWTs that last 30 days. Passwords are hashed with bcrypt.

## The world room (Colyseus `world`)

- **Joining:** `joinOrCreate('world', { token })` with your token, or `{ name }` as a guest while `ALLOW_GUESTS=true`. A second login on the same account replaces the first.
- **State,** 20 updates a second: `players` is a map of `{ name, x, y, z, ry, anim, veh, look }`. `look` holds your character as JSON.
- **Joining options:** `{ x, y, z }` (where you already are) and, for guests, `{ look }`.
- **Messages you send:**
  - `move` `{ x, y, z, ry, anim, veh, warp? }`. Values are clamped to the map. Jumps of more than 40 m are ignored unless `warp` is set (the game's own respawns and lifts), and at most one warp every 3 s is accepted.
  - `look` `{ … }` sends your character (validated by `schemas.ts`).
  - `chat` `{ text }`, up to 160 characters and one message a second.
  - `voice` `{ on, talk }`: in voice chat, and holding push-to-talk. These are the `voice` and `talk` fields in the state.
  - `rtc` `{ to, data }`: a WebRTC offer, answer or ICE candidate for another player. It is passed on only if you're in voice and within 60 m of them.
- **Messages you get:** `chat` `{ from, id, text, x, z }`, `plot` (land news), `rtc` `{ from, data }`, and `trade`, sent only to the player it concerns: `{ kind: 'offer' | 'sold' | 'paid' | 'declined' | 'withdrawn', … }`.
- Up to 100 players fit in a room; more open new rooms automatically.

## Shared ownership

The server is the truth for land, homes, furniture, fences, the bulldozer, terrain edits and money. Everything lives in `src/land.ts`, with prices in `src/catalog.ts`.

**How a sync works.** The game plays as before, and after every change it sends its whole land record with `base`, the version it last saw.
- **Stale devices are turned away.** If `base` isn't current (another device changed things), the server replies `409` with the true state and the game reloads from it.
- **Otherwise the server works out what changed** and prices each change from its own tables:
  - **New plots** must be in `data/plots.json`, the 227 plots for sale generated from the game's own map with exact prices. They must also be free; claiming is a single atomic `INSERT … ON CONFLICT … WHERE owner IS NULL`. Someone else's plot comes back as a conflict, with their name.
  - **Houses** cost their type plus furnishing plus fence (`fenceCost` mirrors the game's `fenceQuote`). Mansions are only allowed on the Banana Island lot. A house can't change type or be demolished.
  - **Furniture** is priced piece by piece. Sales refund half. Bathroom fittings are free when a house first gets its bathrooms.
  - **Sold plots** become `npc`: the house stays, nobody can buy it, and the seller gets at most `paid × 1.5 + 90%` of the house.
  - **Bulldozer edits** are kept only where they fall on your own plots.
  - **Money:** the most it can rise between syncs is 80,000 plus 2,500 a second since your last sync (capped at 2,000,000), which covers jobs, fares, tours and daily pay. Anything above that is corrected. What the game already deducted for things the server refused is refunded.
- **The first sync of a new account imports the player's existing save free,** keeping plots that are still free, with money capped at 10,000,000.
- **Accepted changes are broadcast** to every world room as `plot` news, so other players see new houses, fences, furniture and levelled ground live.

## The game client

The game is the single-file Giantwood game (`../giantwood-scouts/index.html`). Its online module (`NET`, near the end of the script) handles:
- **Start screen:** a *Play online* panel to sign in, create an account, play as a guest, or make your scout.
- **Character creator:** body, build, skin, twelve hair styles, hair colour, outfit (jacket, T-shirt or dress) and colours, trousers, shoes, hat and sunglasses, with a turning 3D preview.
- **In the world:** joining when you Deploy, sending your position 20 times a second (only when it changes), and drawing other players as real figures in their look, with name tags. Their car, boat, plane or motorbike is drawn too, from the same models as yours. Movement is smoothed, and they snap after long jumps.
- **Chat:** Enter to chat, with messages in a log and as speech bubbles.
- **Touch screens** get an online dock on the right while playing online:
  - **💬 Chat** opens a chat bar at the top of the screen, clear of the keyboard, with **Send** and **✕**.
  - **🎧 Voice** turns voice on or off.
  - A big **🎙 Hold** button appears while voice is on, and turns red while you're talking.
- **Mobile viewport:** the page carries a `viewport` meta tag, so phones get the touch layout at real size instead of a shrunken desktop page.
- **Proximity voice:**
  - **Connections:** players' browsers connect directly over WebRTC, with the server only passing the handshake along, to other voice players within 35 m. They hang up past 45 m. Each player's messages are handled in order, so the call is set up before its ICE candidates arrive.
  - **Sound:** each voice plays through a 3D panner at the speaker's head, so it fades with distance and comes from their direction.
  - **Off by default:** **J** joins voice (listen only). **Hold Z** to talk, which uses push-to-talk and asks for the microphone on first use. Touch gets a hold-to-talk button and *Voice chat* in the ••• menu.
  - **Speaking indicator:** players who are talking show a 🔊 above their heads.
  - **Network fallback:** Google's public STUN, then our TURN relay, addressed by IP (`46.101.63.217`) so phones don't need a DNS lookup.
  - **Its own audio context** (`VOICE.ac`): the game suspends its sound while paused (for example when the window loses focus), and voices must keep playing.
  - **Phones release the microphone** 1.5 s after you let go of talk. An open mic makes iPhones play call audio through the quiet earpiece; releasing it puts sound back on the loudspeaker.
  - **Phones and tablets** play each voice straight through an `<audio>` element. Web Audio from a call stream is silent on many of them, iOS Safari especially. Volume follows distance where the browser allows it (iOS doesn't), and there's no 3D panning. Computers keep the 3D panner.
  - **Silent until a tap:** if the browser blocks sound, the game says *Tap the screen*, and any tap restarts the voices and wakes the audio.
  - **Status:** a toast says when your voice links with a nearby scout, or if it couldn't connect.
- **Shared land:** your land syncs to the server, and the server's copy wins (`landSync`, `adoptLand`).
- **Other people's land:** their homes are built in your world when you load (`loadWorld`) and as they change (`applyOther`). Their plots can't be bought; standing on one says whose it is. They show on the big map in blue with the owner's name.
- **Guests** can visit but can't buy land.

On pages that can't reach the server (the claude.ai artifact blocks all outside connections), the panel links to the online address and the game stays single-player.

`ops/build-client.sh` copies the game into `server/public/index.html`, and `ops/deploy.sh` runs it automatically.

## How many players it handles

Load test (`ops/loadtest.js`), 13 October 2026, on the $24 Droplet (2 vCPU, 4 GB). Simulated players joined one room and each sent a move 10 times a second:

| Players in the room | Server CPU (of one core) | Memory | Updates/s | Your move back to you (avg / p95) |
|---|---|---|---|---|
| 23 | ~8% | 28 MB | 19.8 | 201 / 222 ms |
| 43 | ~12% | 35 MB | 19.2 | 206 / 233 ms |
| 63 | ~15% | 47 MB | 19.5 | 212 / 244 ms |
| 83 | ~16–25% | 60 MB | 19.7 | 209 / 248 ms |

- **Latency:** the ~200 ms is mostly the distance from the tester to London plus the 50 ms update interval. It barely moved with load.
- **Bandwidth:** at 80 players the server sent about 1.4 MB/s, roughly 17 KB/s to each player. That grows with the square of the players in a room.
- **Limits:**
  - **One room** holds 100 players (`maxClients`); more players open another room, a separate copy of the world.
  - **Raising the cap:** CPU would allow a few hundred per room, but bandwidth is the real limit. Above about 100 in one world, add interest management (only send players near you).
  - **The whole Droplet** should handle several full rooms, roughly 300–500 players online at once, before needing a bigger machine.
- **Voice** is peer to peer, so it doesn't load the server. Each phone connects to the voice players within 35 m, and that's comfortable up to about 6–8 at once. The TURN relay only carries players whose networks block direct connections, at about 50 kbit/s per stream.

To run it again (bots join far from the start, walk about, then leave):

```bash
mkdir -p /tmp/lt && cd /tmp/lt && npm i colyseus.js@0.15.28 && cp <repo>/ops/loadtest.js . && node loadtest.js 20,40,60,80 30
```

## Working on it

```bash
cd server && npm install && npx tsc -p . --noEmit
```

To deploy to the Droplet:

```bash
ops/deploy.sh
```

The script copies the code and, the first time only, creates `/opt/velaplay/.env` on the server with random secrets that are never printed. It then rebuilds the containers and checks health.

Database migrations are the `.sql` files in `server/src/migrations`. They apply in name order when the server starts.

For the DigitalOcean API, `ops/doapi.sh GET droplets` reads the token from `.env.local`, which is never committed. It works around routers whose DNS can't resolve `api.digitalocean.com`.

## Trading between players

Players can sell or give land to each other and send money (`src/trade.ts`, tables in `migrations/003_trade.sql`).

- **Offers:** the owner offers a plot to a player by display name, for a price or as a gift (price 0). The house and everything in it go with the land, and the Banana Island lot moves whole. There is one open offer per plot (a new one replaces the old), and at most 10 open offers per seller.
- **Price cap:** you can't ask more than `2 × value + ₦50,000`. Value is the land, the house, its furnishing and fence, and the furniture bought; bathroom fittings are free, so they don't count.
- **Accepting:** the buyer's game first syncs, then sends `base`. In one transaction the server:
  - locks both wallets in a fixed order;
  - checks the seller still owns the land and the buyer can pay;
  - moves the plots, debits the buyer and credits the seller;
  - bumps both wallet versions and voids other offers on that land.

  The buyer gets their new state back and reloads. The seller gets a `trade` `sold` message; their next sync is stale (`409`), and the reply lists `received` payments, so they reload knowing who bought what.
- **Money:** the payer's wallet is debited at once (version bumped, and the game takes the new version). The payee's `inbox` is credited and added on their next sync, so a sync that doesn't know about it can't overwrite it. Every sync reply includes `received`: who paid you since you were last told (stored in `payments.seen`).
- **Limits.** Every account starts with ₦10,000,000, so to stop new accounts being emptied into one:
  - an account must be 24 hours old before it can pay anyone;
  - what leaves an account is capped at ₦1,000,000 a day: money sent, money paid for land, and the value of land handed over below its worth. All of it is recorded in `payments`.
- **Tested** end to end against a local Postgres (two accounts: offers, refusals, sale, stale seller, gifts, declines, payments, inbox, caps).

## The map's extent

The server clamps positions to x ±346 and z from −5866 (the north edge, past Yaba, Ikeja, Ibadan and Oyo) to 1066 (the south edge, out at sea past the Lekki Deep Sea Port), in `rooms/WorldRoom.ts` (`BOUND`, `ZLO`, `ZHI`). When the game's map grows, move these with it. `data/plots.json` lists 291 plots: the 227 on the old map, the 40 Ikeja GRA lots (kind `e`, ₦40,000) and lots in the expressway hamlets Magboro, Ibafo and Mowe (kind `e`, ₦8,000; a few older hamlet keys are no longer offered by the game since lots are now chosen by position), with negative z keys.

## Next steps

1. **Wire the game in:** sign-in and a character creator screen; send your position and draw other players with the game's own figures, wearing their look; chat bubbles; cloud saves instead of browser saves.
2. **Domain and HTTPS:** point a subdomain at `46.101.63.217`, set `SITE_ADDRESS` in the server `.env`, and redeploy.
3. **Shared ownership** and **trading** are done (see above). Next ideas: owned cars that can be sold, and visiting other players' homes with a doorbell.
4. **Later:** proximity voice (LiveKit on its own Droplet), moderation tools, nightly database backups to Spaces.

## Club music (shared)

The server keeps every club's music on its own clock, so everyone online in a club hears the same track at the same point (`server/src/music.ts`, `WorldRoom`).

- **State:** `state.clubs` holds, per club, the track `key`, its `start` and `end` (server ms), its place `i` in the playlist, and a queued request `req`.
- **Playlists:** a track plays two passes of its loop. The next one starts 4 s before the end, and the games crossfade. After a request, the playlist carries on where it was.
- **`clk`:** the game sends its time, and the server replies with its own, so each game can work out its offset.
- **`dj`:** `{ club, key, now }` is a DJ booth request.
  - `now` starts the track at once. Otherwise it plays next, at the end of the current pass of the loop.
  - One request every 4 s per player. The tip is the player's own money, which reaches the server through their land record.
  - The server broadcasts `djreq` with who asked.
- **Keep in step with the game:** loop lengths in `TRACKS` must match the game's `CLUB_TRACKS` and the files in `giantwood-scouts/music/`. `ops/build-client.sh` copies those files to `public/music/`.
- **Timestamps:** a ms timestamp sent by the game arrives as a 64-bit integer, so the server reads it with `Number()`.

## Doorbell visits

Other players' homes are locked in the game until the owner lets you in.

- **`ring`** `{ key, owner }`: the visitor rings. The server sends `ring` `{ key, from, id }` to the owner's session (found by account id), or `ringres` `{ ok: false, why: "away" }` back if the owner isn't online. One ring per 6 s per player.
- **`answer`** `{ id, key, ok }`: the owner replies. The server sends `ringres` `{ key, ok, name }` to the visitor, but only from the owner the ring went to (`rings` map), so nobody can answer their own ring.
