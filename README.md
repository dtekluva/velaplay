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

The DigitalOcean firewall `giantwood-fw` (tag `giantwood`) allows only ports 22, 80 and 443. SSH accepts only the `INYANG-MAC` key, password login is off, and fail2ban is running.

## API

| Method and path | Auth | What |
|---|---|---|
| `GET /api/health` | | Server and database status |
| `POST /api/auth/register` | | `{ email, password (8+), name }` → `{ token, user }` |
| `POST /api/auth/login` | | `{ email, password }` → `{ token, user }` |
| `GET /api/me` | Bearer | Your account and character |
| `PUT /api/character` | Bearer | Your look. Only known fields are accepted (colours as `#rrggbb`, `hairStyle`, `build`, `hat`, `shades`…) |
| `GET /api/save` / `PUT /api/save` | Bearer | Your land, homes, furniture and money, i.e. the game's existing save (max 512 KB) |

Tokens are JWTs that last 30 days. Passwords are hashed with bcrypt.

## The world room (Colyseus `world`)

- **Joining:** `joinOrCreate('world', { token })` with your token, or `{ name }` as a guest while `ALLOW_GUESTS=true`. A second login on the same account replaces the first.
- **State,** 20 updates a second: `players` is a map of `{ name, x, y, z, ry, anim, veh, look }`. `look` holds your character as JSON.
- **Joining options:** `{ x, y, z }` (where you already are) and, for guests, `{ look }`.
- **Messages you send:**
  - `move` `{ x, y, z, ry, anim, veh, warp? }`. Values are clamped to the map. Jumps of more than 40 m are ignored unless `warp` is set (the game's own respawns and lifts), and at most one warp every 3 s is accepted.
  - `look` `{ … }` sends your character (validated by `schemas.ts`).
  - `chat` `{ text }`, up to 160 characters and one message a second.
- **Messages you get:** `chat` `{ from, id, text, x, z }`.
- Up to 100 players fit in a room; more open new rooms automatically.

## The game client

The game is the single-file Giantwood game (`../giantwood-scouts/index.html`). Its online module (`NET`, near the end of the script) handles:
- **Start screen:** a *Play online* panel to sign in, create an account, play as a guest, or make your scout.
- **Character creator:** body, build, skin, twelve hair styles, hair colour, outfit (jacket, T-shirt or dress) and colours, trousers, shoes, hat and sunglasses, with a turning 3D preview.
- **In the world:** joining when you Deploy, sending your position 20 times a second (only when it changes), and drawing other players as real figures in their look, with name tags. Their car, boat, plane or motorbike is drawn too, from the same models as yours. Movement is smoothed, and they snap after long jumps.
- **Chat:** Enter to chat (Chat in the ••• menu on touch), with messages in a log and as speech bubbles.
- **Cloud saves:** once signed in, the cloud save is loaded if it's newer, and every save is uploaded a few seconds later.

On pages that can't reach the server (the claude.ai artifact blocks all outside connections), the panel links to the online address and the game stays single-player.

`ops/build-client.sh` copies the game into `server/public/index.html`, and `ops/deploy.sh` runs it automatically.

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

## Next steps

1. **Wire the game in:** sign-in and a character creator screen; send your position and draw other players with the game's own figures, wearing their look; chat bubbles; cloud saves instead of browser saves.
2. **Domain and HTTPS:** point a subdomain at `46.101.63.217`, set `SITE_ADDRESS` in the server `.env`, and redeploy.
3. **Shared ownership:** the server becomes the authority for land, building, furniture and money, so everyone sees everyone's homes and a plot can only be bought once. The cloud save then stops being trusted as sent.
4. **Later:** proximity voice (LiveKit on its own Droplet), moderation tools, nightly database backups to Spaces.
