#!/usr/bin/env zsh
# Create (or update) the Cloudflare Access application that guards /auth/login/<collection>.
#
# Usage:
#   zsh scripts/setup-access.zsh <host> <collection> <op-ref-of-api-token> <emails-file>
# Example:
#   zsh scripts/setup-access.zsh models.railclass.ldas.jp railclass "op://Personal/<token item>/credential" ~/private/railclass-emails.txt
#
# <emails-file>: one email address per line (# comments allowed). Keep it out of git.
# The API token needs (account level): Access: Apps and Policies Edit,
#   Access: Organizations, Identity Providers, and Groups Read.
# Prints the team domain and the AUD tag to put into the Worker config. Safe to run again:
# it reuses the application and replaces the allow list.
set -euo pipefail

if (( $# != 4 )); then
  sed -n '2,13p' "$0"; exit 2
fi
host=$1 c=$2 token_ref=$3 emails_file=$4
[[ -f $emails_file ]] || { print -u2 "no emails file: $emails_file"; exit 1; }
emails=$(grep -vE '^\s*(#|$)' "$emails_file" | tr -d ' \r' | jq -Rsc 'split("\n") | map(select(length > 0))')
n=$(jq length <<<"$emails")
(( n > 0 )) || { print -u2 "no email addresses in $emails_file"; exit 1; }

TOK=$(op read -n "$token_ref")
trap 'unset TOK' EXIT
API=https://api.cloudflare.com/client/v4
hdr=(-H "Authorization: Bearer $TOK" -H "Content-Type: application/json")
api() { curl -s "${hdr[@]}" "$@"; }
must() { jq -e '.success' >/dev/null <<<"$1" || { print -u2 "API error: $(jq -c '.errors' <<<"$1")"; exit 1; }; }

# Account: the token is expected to see exactly one.
R=$(api "$API/accounts"); must "$R"
acc=$(jq -r '.result[0].id' <<<"$R")

# Team domain.
R=$(api "$API/accounts/$acc/access/organizations"); must "$R"
team="https://$(jq -r '.result.auth_domain' <<<"$R")"

# One-time PIN login must exist (it is the only login method we allow).
R=$(api "$API/accounts/$acc/access/identity_providers"); must "$R"
otp=$(jq -r '.result[] | select(.type == "onetimepin") | .id' <<<"$R" | head -1)
[[ -n $otp ]] || { print -u2 "One-time PIN is not enabled. Zero Trust > Settings > Authentication > Login methods > Add > One-time PIN."; exit 1; }

domain="$host/auth/login/$c"
R=$(api "$API/accounts/$acc/access/apps?per_page=200"); must "$R"
app=$(jq -r --arg d "$domain" '.result[] | select(.domain == $d) | .id' <<<"$R" | head -1)
body=$(jq -n --arg n "IIIF login: $c" --arg d "$domain" --arg otp "$otp" '{
  name: $n, domain: $d, type: "self_hosted", session_duration: "24h",
  allowed_idps: [$otp], auto_redirect_to_identity: true, app_launcher_visible: false
}')
if [[ -z $app ]]; then
  R=$(api -X POST "$API/accounts/$acc/access/apps" -d "$body"); must "$R"
  app=$(jq -r '.result.id' <<<"$R"); print "created application $app"
else
  R=$(api -X PUT "$API/accounts/$acc/access/apps/$app" -d "$body"); must "$R"
  print "updated application $app"
fi
aud=$(jq -r '.result.aud' <<<"$R")

# Allow list: one policy, replaced on every run.
pbody=$(jq -n --argjson e "$emails" '{
  name: "allow listed emails", decision: "allow", precedence: 1,
  include: ($e | map({email: {email: .}}))
}')
R=$(api "$API/accounts/$acc/access/apps/$app/policies"); must "$R"
pol=$(jq -r '.result[] | select(.name == "allow listed emails") | .id' <<<"$R" | head -1)
if [[ -z $pol ]]; then
  R=$(api -X POST "$API/accounts/$acc/access/apps/$app/policies" -d "$pbody"); must "$R"
else
  R=$(api -X PUT "$API/accounts/$acc/access/apps/$app/policies/$pol" -d "$pbody"); must "$R"
fi
print "allow list: $n addresses"

print "\nPut these into the Worker config:"
print "  ACCESS_TEAM_DOMAIN = $team"
print "  COLLECTIONS.$c.aud = $aud"
