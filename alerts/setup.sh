#!/usr/bin/env bash
# Sets up (or updates) the Baseline alerts service on Cloudflare. Run by the Baseline workflow; safe to re-run.
set -euo pipefail
cd "$(dirname "$0")"
API=https://api.cloudflare.com/client/v4
cf() { curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" "$@"; }
WR="npx --yes wrangler@3"

# 1. Which Cloudflare account
if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  CLOUDFLARE_ACCOUNT_ID=$(cf "$API/accounts" | jq -r '.result[0].id // empty')
fi
[ -n "$CLOUDFLARE_ACCOUNT_ID" ] || { echo "::error::Couldn't find your Cloudflare account. Check the API token's permissions (see README)."; exit 1; }
export CLOUDFLARE_ACCOUNT_ID
ACC=$CLOUDFLARE_ACCOUNT_ID

# 2. Storage for subscriptions and scores
KV=$(cf "$API/accounts/$ACC/storage/kv/namespaces?per_page=100" | jq -r '.result[]? | select(.title=="baseline-alerts") | .id' | head -1)
if [ -z "$KV" ]; then
  KV=$(cf -X POST "$API/accounts/$ACC/storage/kv/namespaces" -d '{"title":"baseline-alerts"}' | jq -r '.result.id // empty')
fi
[ -n "$KV" ] || { echo "::error::Couldn't create storage (KV). The API token needs 'Workers KV Storage: Edit'."; exit 1; }

# 3. The free workers.dev address
SUB=$(cf "$API/accounts/$ACC/workers/subdomain" | jq -r '.result.subdomain // empty')
if [ -z "$SUB" ]; then
  SUB="baseline-$(echo "${GITHUB_REPOSITORY_OWNER:-me}" | tr 'A-Z_.' 'a-z--' | cut -c1-24)-$((RANDOM % 9000 + 1000))"
  cf -X PUT "$API/accounts/$ACC/workers/subdomain" -d "{\"subdomain\":\"$SUB\"}" > /dev/null
fi

# 4. Settings
OWNER=$(echo "${GITHUB_REPOSITORY_OWNER:-you}" | tr 'A-Z' 'a-z'); REPO="${GITHUB_REPOSITORY#*/}"
SITE="https://$OWNER.github.io/$REPO"
set_var() { sed -i "s|^$1 = .*|$1 = \"$2\"|" wrangler.toml; }
sed -i "s|^id = .*|id = \"$KV\"|" wrangler.toml
set_var SITE_URL "$SITE"
set_var VAPID_SUBJECT "mailto:${OWNER}@users.noreply.github.com"
[ -s vapid_public.txt ] && set_var VAPID_PUBLIC_KEY "$(cat vapid_public.txt)"

# 5. Install the worker's libraries, deploy, then make sure the notification keys exist (created once, kept forever)
npm install --no-audit --no-fund --silent
$WR deploy
if ! $WR secret list 2>/dev/null | grep -q VAPID_PRIVATE_JWK || [ ! -s vapid_public.txt ]; then
  node make-keys.mjs --json > /tmp/keys.json
  jq -r .public /tmp/keys.json > vapid_public.txt
  set_var VAPID_PUBLIC_KEY "$(cat vapid_public.txt)"
  jq -c .private /tmp/keys.json | tr -d '\n' | $WR secret put VAPID_PRIVATE_JWK
  rm -f /tmp/keys.json
  $WR deploy
fi
if [ -n "${API_TENNIS_KEY:-}" ]; then printf '%s' "$API_TENNIS_KEY" | $WR secret put API_TENNIS_KEY; fi
# Optional: Ask Cosmo uses Claude instead of the free Workers AI model when this secret is set
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then printf '%s' "$ANTHROPIC_API_KEY" | $WR secret put ANTHROPIC_API_KEY; fi

URL="https://baseline-alerts.$SUB.workers.dev"
printf '{"alerts_url": "%s"}\n' "$URL" > ../site_config.json
echo "::notice::Alerts service is live at $URL"
