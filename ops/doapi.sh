#!/usr/bin/env bash
# Call the DigitalOcean API with the token from .env.local (never printed).
# Usage: ops/doapi.sh GET droplets   |   ops/doapi.sh POST droplets '{"name":...}'
# Works around routers whose DNS can't resolve api.digitalocean.com by asking Cloudflare's DNS (TLS still verified).
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env.local; set +a
[ -n "${DIGITALOCEAN_TOKEN:-}" ] || { echo "DIGITALOCEAN_TOKEN is empty in .env.local" >&2; exit 1; }
METHOD="${1:-GET}"; PATH_="${2:-account}"; BODY="${3:-}"
IP=$(dig +short api.digitalocean.com @1.1.1.1 | grep -E '^[0-9.]+$' | head -1)
ARGS=(-s -X "$METHOD" -H "Authorization: Bearer $DIGITALOCEAN_TOKEN" -H "Content-Type: application/json")
[ -n "$IP" ] && ARGS+=(--resolve "api.digitalocean.com:443:$IP")
[ -n "$BODY" ] && ARGS+=(-d "$BODY")
curl "${ARGS[@]}" "https://api.digitalocean.com/v2/$PATH_"
