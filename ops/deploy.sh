#!/usr/bin/env bash
# Deploy VelaPlay to the game Droplet: copy the code, create server secrets once, rebuild and restart with Docker.
# Usage: ops/deploy.sh            (host defaults to the giantwood-game Droplet)
set -euo pipefail
cd "$(dirname "$0")/.."
HOST="${VELAPLAY_HOST:-root@46.101.63.217}"
SSH=(ssh -i "${SSH_KEY:-$HOME/.ssh/id_rsa}" -o BatchMode=yes -o StrictHostKeyChecking=accept-new)
echo "→ copying code to $HOST:/opt/velaplay"
"${SSH[@]}" "$HOST" "mkdir -p /opt/velaplay"
COPYFILE_DISABLE=1 tar --no-xattrs --exclude=node_modules --exclude=dist --exclude=.env --exclude=.env.local --exclude=.git -czf - . | "${SSH[@]}" "$HOST" "tar -xzf - -C /opt/velaplay && find /opt/velaplay -name '._*' -delete"
echo "→ secrets (created once on the server, never printed)"
"${SSH[@]}" "$HOST" 'set -e; cd /opt/velaplay && if [ ! -f .env ]; then
  cp .env.example .env
  sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -hex 24)|; s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -hex 48)|" .env
  chmod 600 .env; echo "   created /opt/velaplay/.env"; else echo "   kept existing .env"; fi'
echo "→ building and starting"
"${SSH[@]}" "$HOST" "cd /opt/velaplay && docker compose up -d --build 2>&1 | tail -5"
echo "→ health"
sleep 4
"${SSH[@]}" "$HOST" "curl -s http://localhost/api/health; echo; docker compose -f /opt/velaplay/docker-compose.yml ps --format '{{.Service}}: {{.Status}}'"
