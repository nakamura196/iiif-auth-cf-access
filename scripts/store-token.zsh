#!/usr/bin/env zsh
# =============================================================================
# Cloudflare API トークン「railclass-models」を検査して、1Password に入れる。
#
# 目的:
#   railclass の 3D を守る Worker（models.railclass.ldas.jp）と、Access アプリ
#   （/auth/login/railclass）を配るためのトークン。設定は deploy/railclass.jsonc。
#
# 前提:
#   - 1Password CLI (op) にサインイン済み（Touch ID）
#   - ダッシュボードでトークンを作成済み（CLI からは作れない）。
#     ~/git/tools/cloudflare/fill-cf-token-form-railclass-models.console.js で
#     フォームを埋められる（2026-10-14 は画面が変わっていて、Claude in Chrome で埋めた）。権限は次の 6 つ:
#       Account | Workers Scripts                                       | Edit
#       Account | Access: Apps                                          | Edit
#       Account | Access: Policies                                      | Edit
#       Account | Access: Organizations                                 | Read
#       Account | Access: Identity Providers                            | Read
#       Zone    | Workers Routes                                        | Edit   (ldas.jp だけ)
#
# 使い方:
#   zsh scripts/store-token.zsh --clip     # クリップボードから（作成直後の画面でコピーしてから）
#   zsh scripts/store-token.zsh            # 非表示入力（read -s）
#   zsh scripts/store-token.zsh --title "Cloudflare API Token 別名" --zone example.jp --account <ID>
#   zsh scripts/store-token.zsh --clip --no-access --title "Cloudflare API Token iiif-demo-models" --notes "用途: ..."
#     --no-access: Access を使わない配備（同意だけの clickthrough）。Access の 3 つの検査を省き、
#                  権限は Workers Scripts: Edit と Workers Routes: Edit (ldas.jp) の 2 つでよい
#
# 何をするか:
#   1. トークンを受け取る（画面にもシェル履歴にも出さない）
#   2. Cloudflare に問い合わせて、有効か（active）と、必要なことができるかを実測する
#        Workers のスクリプト一覧 / Access アプリ一覧 / Access の組織 /
#        ログイン方法（identity providers）/ Workers の独自ドメイン一覧 /
#        ゾーンの Workers ルート一覧
#      ゾーンの ID を引くには「Zone: Read」が要るが、このトークンには付けない。
#      引けなければ、ゾーンの検査は「省略」と表示する（失敗扱いにしない）。
#   3. 必須の検査が通ったときだけ 1Password に保存する（既にあれば更新）
#   4. 変数を消す
#
# 値は画面に出さない。curl には認証ヘッダを標準入力で渡し、ps に残さない。
# =============================================================================
set -euo pipefail

VAULT="Personal"
TITLE="Cloudflare API Token railclass-models"
ACC="7efcf816ee8a11cebbfcc7115bbca3d5"   # アカウント ID（秘密ではない）
ZONE_NAME="ldas.jp"
NOTES="用途: railclass の 3D を守る Worker と Access | 使用先: nakamura196/iiif-auth-cf-access (deploy/railclass.jsonc) | 範囲: account + zone ldas.jp"
API="https://api.cloudflare.com/client/v4"

USE_CLIP=0
NO_ACCESS=0
while (( $# > 0 )); do
  case "$1" in
    --clip) USE_CLIP=1; shift ;;
    --title) TITLE="$2"; shift 2 ;;
    --zone) ZONE_NAME="$2"; shift 2 ;;
    --account) ACC="$2"; shift 2 ;;
    --notes) NOTES="$2"; shift 2 ;;
    --no-access) NO_ACCESS=1; shift ;;
    *) print -u2 "ERROR: 知らない引数です: $1"; exit 1 ;;
  esac
done

for c in op curl jq; do
  if ! command -v "$c" >/dev/null 2>&1; then
    print -u2 "ERROR: $c が見つかりません。"
    exit 1
  fi
done

if (( USE_CLIP )); then
  TOK=$(pbpaste)
  # 作成直後の画面の「試すための curl」を丸ごとコピーした場合は、Bearer の後ろだけを取る
  if [[ $TOK == *Bearer* ]]; then
    TOK=$(print -r -- "$TOK" | grep -o 'Bearer [A-Za-z0-9_-]*' | head -1 | cut -d' ' -f2)
    print "curl の行から、トークンの部分だけを取り出しました"
  fi
  TOK=${TOK//[[:space:]]/}
  print "クリップボードから受け取りました"
else
  read -s 'TOK?Cloudflare API トークン (非表示): '
  print ""
  TOK=${TOK//[[:space:]]/}
fi

if [[ -z "$TOK" ]]; then
  print -u2 "ERROR: トークンが空です。中断します。"
  exit 1
fi
print "受け取りました (${#TOK} 文字)"
print ""

# 認証ヘッダを標準入力 (-H @-) で渡す。コマンドラインに値が載らない。
# 引数: URL。応答の JSON を標準出力へ。
cf() {
  print -r -- "Authorization: Bearer $TOK" | curl -sS -H @- "$1"
}

# ── 1. トークンが有効か ────────────────────────────────────
# 検証の窓口は 2 つ。アカウント所有は /accounts/<id>/tokens/verify、
# ユーザー所有は /user/tokens/verify。片方だけだと有効なものを無効と誤判定する。
st=$(cf "$API/accounts/$ACC/tokens/verify" | jq -r '.result.status // empty' 2>/dev/null || true)
owner="アカウント所有"
if [[ "$st" != "active" ]]; then
  st=$(cf "$API/user/tokens/verify" | jq -r '.result.status // empty' 2>/dev/null || true)
  owner="ユーザー所有"
fi
if [[ "$st" != "active" ]]; then
  print -u2 "✗ トークンが有効ではありません（判定: ${st:-検証できず}）。値は保存していません。"
  unset TOK st owner
  exit 1
fi
print "✓ トークンは有効です（$owner）"
print ""

# ── 2. 何ができるかを実測する ──────────────────────────────
print "権限を確かめます:"
fail=0
# check 表示名 URL ... 成功なら ✓、だめなら ✗ で fail を立てる
check() {
  local label=$1 url=$2
  if cf "$url" | jq -e '.success == true' >/dev/null 2>&1; then
    print "  ✓ $label"
  else
    print "  ✗ $label  ← 権限が足りません"
    fail=1
  fi
}

check "Workers のスクリプト一覧を引ける"        "$API/accounts/$ACC/workers/scripts"
if (( ! NO_ACCESS )); then
  check "Access のアプリ一覧を引ける"             "$API/accounts/$ACC/access/apps"
  check "Access の組織を読める"                   "$API/accounts/$ACC/access/organizations"
  check "ログイン方法 (identity providers) を読める" "$API/accounts/$ACC/access/identity_providers"
fi
check "Workers の独自ドメイン一覧を引ける"      "$API/accounts/$ACC/workers/domains"

# ゾーンの検査。ゾーン ID を引けないときは「省略」（Zone: Read を付けていないため普通のこと）
zid=$(cf "$API/zones?name=$ZONE_NAME" | jq -r '.result[0].id // empty' 2>/dev/null || true)
if [[ -z "$zid" ]]; then
  print "  - ゾーン $ZONE_NAME の Workers ルート: 省略（ゾーン ID を引けません。Zone: Read が無いため）"
  print "    独自ドメインの割り当ては、上の「独自ドメイン一覧」と、実際のデプロイで確かめてください"
else
  check "ゾーン $ZONE_NAME の Workers ルート一覧を引ける" "$API/zones/$zid/workers/routes"
fi
unset zid
print ""

if (( fail )); then
  print -u2 "★ 必須の権限が足りません。値は保存していません（クリップボードもそのままです）。"
  print -u2 "  ダッシュボードで権限を直してから、もう一度実行してください。"
  print -u2 "  トークンの値は編集しても変わりません。"
  unset TOK st owner
  exit 1
fi

# ── 3. 1Password に保存 ───────────────────────────────────
# 値を引数に載せないよう、項目は JSON テンプレートを標準入力で渡して作る。
# 既にある項目は上書きしない（中身を確かめてから、手で消すか別名で作る）。
if op item get "$TITLE" --vault="$VAULT" >/dev/null 2>&1; then
  print -u2 "★ 1Password に同じ名前の項目が既にあります: $TITLE"
  print -u2 "  上書きはしません。古い項目を確かめて消すか、--title で別名にしてから、もう一度実行してください。"
  unset TOK st owner
  exit 1
fi
jq -n --arg t "$TITLE" --rawfile v <(print -rn -- "$TOK") --arg n "$NOTES" '{
  title: $t, category: "API_CREDENTIAL",
  fields: [
    {id: "credential", label: "credential", type: "CONCEALED", value: $v},
    {id: "notesPlain", label: "notesPlain", type: "STRING", purpose: "NOTES", value: $n}
  ]
}' | op item create --vault="$VAULT" >/dev/null
print "✓ 1Password に保存しました: $TITLE"
unset TOK st owner

# 保存できたか読み直す（長さだけ表示）
GOT=$(op item get "$TITLE" --vault="$VAULT" --fields credential --reveal)
print "  読み直し: ${#GOT} 文字"
unset GOT

if (( USE_CLIP )); then
  print -n "" | pbcopy
  print "  クリップボードを空にしました"
fi

print ""
print "★ 必要な権限がそろっています。以後は次で読み出せます:"
print "  op item get \"$TITLE\" --vault=$VAULT --fields credential --reveal"
