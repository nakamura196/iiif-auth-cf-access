#!/usr/bin/env zsh
# Deploy the bridge with its protected files as Workers Static Assets.
#
# Usage:
#   zsh scripts/deploy.zsh <config.jsonc> <assets-dir> <op-ref-of-api-token> <op-ref-of-signing-key>
# Example:
#   zsh scripts/deploy.zsh deploy/railclass.jsonc ~/somewhere/protected "op://Personal/<token item>/credential" "op://Personal/<key item>/password"
#
# <assets-dir> holds "<collection>/<path>" (e.g. railclass/acela.glb).
# The API token needs: Account > Workers Scripts: Edit, Zone > Workers Routes: Edit (zone of the custom domain).
# Secrets are read from 1Password with `op read` and never written to disk or printed.
set -euo pipefail

if (( $# != 4 )); then
  sed -n '2,11p' "$0"; exit 2
fi
config=$1 assets=$2 token_ref=$3 key_ref=$4
cd "${0:A:h}/.."

[[ -f $config ]] || { print -u2 "no config: $config"; exit 1; }
if grep -q 'REPLACE' "$config"; then
  print -u2 "config still has REPLACE_ placeholders:"; grep -n 'REPLACE' "$config" >&2; exit 1
fi
[[ -d $assets ]] || { print -u2 "no assets dir: $assets"; exit 1; }
nfiles=$(find "$assets" -type f | wc -l | tr -d ' ')
(( nfiles > 0 )) || { print -u2 "assets dir is empty"; exit 1; }
big=$(find "$assets" -type f -size +25M | head -1)
[[ -z $big ]] || { print -u2 "over the 25 MiB per-file limit: $big"; exit 1; }

keylen=$(op read -n "$key_ref" | wc -c | tr -d ' ')
(( keylen >= 32 )) || { print -u2 "signing key too short ($keylen chars)"; exit 1; }

export CLOUDFLARE_API_TOKEN="$(op read -n "$token_ref")"
# wrangler は <(...) の /dev/fd を読めない（EISDIR）。自分だけが読める一時ファイルに書き、終わったら必ず消す。
secdir=$(mktemp -d)
chmod 700 "$secdir"
trap 'rm -rf "$secdir"; unset CLOUDFLARE_API_TOKEN' EXIT
op read -n "$key_ref" | jq -Rs '{SIGNING_KEY: .}' > "$secdir/secrets.json"

print "deploying $config with $nfiles files from $assets"
npx wrangler deploy --config "$config" --assets "$assets" --secrets-file "$secdir/secrets.json"
rm -rf "$secdir"

host=$(grep -o '"pattern": *"[^"]*"' "$config" | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
c=$(cd "$assets" && find . -mindepth 1 -maxdepth 1 -type d | head -1 | sed 's|^\./||')
first=$(cd "$assets/$c" && find . -type f | head -1 | sed 's|^\./||')
print "\nchecks on https://$host (collection $c, file $first):"
print -n "  probe without token (expect status 401): "
curl -s "https://$host/probe/$c/$first" | jq -c '{type, status}'
print -n "  file without signature (expect 403): "
curl -s -o /dev/null -w '%{http_code}\n' "https://$host/files/$c/$first"
print -n "  file by its plain path (expect 404): "
curl -s -o /dev/null -w '%{http_code}\n' "https://$host/$c/$first"
print -n "  login without Access (expect 302 to cloudflareaccess.com): "
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' "https://$host/auth/login/$c" | cut -c1-80
