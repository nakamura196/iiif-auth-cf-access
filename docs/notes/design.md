# Cloudflare Access と IIIF Auth 2.0 をつなぐ

## 2026-10-14 設計を始めた

### 何を作るか

Cloudflare Access（ログインした人だけを通す門番）で許可した人だけが、IIIF の資料を見られるようにする。
ビューアとのやり取りは IIIF Authorization Flow API 2.0 に従う。
特定のサイトに依存しない部品として作り、最初の利用者を railclass（railclass.ldas.jp）の 3D モデルにする。

railclass 側で決めたこと（2026-10-14）。

- 3D モデル 100 体（GLB 154 MB）をすべて限定にする。
- 許可はメールアドレスを個別に指定する（Access の one-time PIN。無料枠は 50 人まで）。
- 形式ページにはサムネイルと「ログインすると 3D で見られます」を出し、その場で Auth 2.0 の流れを回す。
- モデルの利用条件は CC BY 4.0 から「個別に許諾」に変える。RDF・マニフェスト・サムネイルは今のまま公開。
- LOD チャレンジ 2026 の応募はデータだけにする。3D は「認証付きで提供」と書く。
- 公開済みの GLB は main・gh-pages・リリース downloads から外す。git の履歴は書き換えない
  （既に配った版は複製がありうる、と割り切る）。

### なぜ Worker を挟むか

railclass.ldas.jp は DNS で GitHub Pages に直接向いており、Cloudflare を通らない。
そのため Pages の前に Access は置けない。
3D ファイルだけを非公開の R2 に移し、別のホスト（案: `models.railclass.ldas.jp`）の Worker から出す。

### Access をかけるのはログイン窓口だけ

ホスト全体に Access をかけると、ビューアの `fetch` が Access のログイン画面へ転送され、CORS で落ちる。
Access の application は `/auth/login/<collection>` のパスだけに付ける。

| 部品（Auth 2.0） | パス | Access | 中身 |
|---|---|---|---|
| AuthAccessService2（profile active） | `/auth/login/<collection>` | あり | Access の JWT を確かめ、自前のセッション Cookie を発行し、窓を閉じる |
| AuthAccessTokenService2 | `/auth/token/<collection>` | なし | iframe。Cookie を確かめ、短いトークンを postMessage で返す |
| AuthProbeService2 | `/probe/<collection>/<id>` | なし | Bearer トークンを確かめ、`location` に署名付き URL を入れて返す |
| AuthLogoutService2 | `/auth/logout/<collection>` | なし | 自前の Cookie を消す。Access 側のセッションは残るので `/cdn-cgi/access/logout` も案内する |
| 資料本体 | `/files/<collection>/<id>.<ext>?exp=…&sig=…` | なし | HMAC 署名と期限を確かめて R2 から返す。CORS `*` |

- Access の JWT は `Cf-Access-Jwt-Assertion` ヘッダで届く。Access が前にいても Worker 側で必ず検証する
  （チームの JWKS と application の AUD で）。`workers.dev` の経路は切る（Access を迂回されるため）。
- トークン・Cookie・署名付き URL はどれも HMAC で署名した自己完結の値にし、保存しない。
  KV や D1 を使わないので、書き込みの無料枠を気にしなくてよい。
- 誰に見せるかはコードに持たない。Access の policy で決める。コレクションごとに application を分ければ、
  許可する人も分けられる。

### 署名付き URL を `location` で渡す理由

資料本体の取得が Cookie に頼らなくなる。Safari などの第三者 Cookie 制限を受けない。
Kasane は probe の `location`（30x）をすでに読む（画像のみ。3D は未対応）。

Cookie が要るのは token service の iframe だけ。ビューアが ldas.jp の中（railclass・kasane・browser）なら
same-site なので Safari でも送られる。ldas.jp の外のビューアでは Safari で失敗しうる（限界として書く）。

### 対象と対象外

- 対象: ファイル 1 つで完結する資料（3D、PDF、音声、動画、画像ファイル）。
- 対象外（後で）: IIIF Image API。タイルの数が多く、1 枚ずつ署名付き URL を配る方式が合わない。

### 確かめていないこと

- probe の応答で `location` を返すときの `status` の値（302 を想定）。仕様の該当箇所を読んで決める。
- 利用者の Cloudflare アカウントに Zero Trust のチーム（`<team>.cloudflareaccess.com`）が既にあるか。
- 手元の Cloudflare トークンで Workers・R2・Access application を作れるか
  （`zsh ~/git/tools/cloudflare/audit-tokens.zsh --zone ldas.jp` で実測する）。
- 同じ組み合わせを部品として公開している先行例。記事を書く前に調べる。

### 作業の順番（案）

1. この部品: Worker 本体と、偽の Access JWT を使ったローカルのテスト。
2. Cloudflare の設定: Access application、R2 バケット、Worker を `models.railclass.ldas.jp` に置く。
3. railclass: GLB を R2 に上げる。マニフェストの Model に probe を付ける。形式ページにログイン案内を出す。
   ダウンロード（STL・OBJ・USDZ）も同じ方式にする。公開側から GLB を外す。
4. ビューア: Kasane の Auth 2.0 を 3D に広げる。この部品にも小さなクライアントを付けるか検討する。
5. 記事（tech-blog）。

主張の候補: Access は「入口の 1 か所」だけを守り、IIIF との受け渡しは Auth 2.0 の token と probe に任せると、
既存の SSO（ここでは Access）を IIIF のどのビューアからも使える形にできる。根拠はまだ無い（実装後に実測する）。

## 2026-10-14（続き）作る前の確認 3 点

### probe の `status` と `location`（仕様 https://iiif.io/api/auth/2.0/ で確認）

- probe の HTTP 応答そのものは常に 200。`status` は「同じ要求を資料に送ったら返るはずの状態コード」。
- `location` は「アクセス制限された資料の代わりに、クライアントが必ず要求する資料」。
  `status` が 30x 以外のときは `location` を付けてはならない。
- → 許可された人には `status: 302` と `location`（署名付き URL）を返す。仕様の例も 302 + 動画の `.m3u8`。
  未許可の人には `status: 401` と heading / note を返す（`location` は付けない）。
- 仕様は資料本体の資格情報として Cookie を前提に書いている。署名付き URL を `location` で渡す使い方は、
  仕様の文面には無いが、30x の定義の範囲に収まる。記事ではここを明記する。
- token service は非表示の iframe で開き、`?messageId=…&origin=…` を付ける。postMessage の `targetOrigin` は
  その `origin` と同じ値でなければならない。応答は `@context`・`type: AuthAccessToken2`・`messageId`・
  `accessToken`（必須）と `expiresIn`（任意）。

### Cloudflare の資格情報（`audit-tokens.zsh --zone ldas.jp`、32 件）

- Zero Trust のチームは既にある（他案件の Access Service Token が複数ある）。チーム名はまだ見ていない。
- この案件用のトークンは無い。Workers と Access を扱えるトークンは他案件のもの（kano、genji-x、matsuyama 等）で、
  使い回さない決まり。R2 の可否は道具が調べていない。
- → ダッシュボードで専用のトークンを 1 本作ってもらう。必要な権限は実装の前に構成から決める。

### 先行例（Web 検索 2 回、2026-10-14）

- Cloudflare Access と IIIF Auth 2.0 を組み合わせた実装・記事は見つからなかった。
- Auth 2.0 の実装: dlcs/iiif-auth-v2（https://github.com/dlcs/iiif-auth-v2、IIIF Cloud Services 用）、
  daamiansz/iiif-rs（https://github.com/daamiansz/iiif-rs、Rust の IIIF サーバ）、
  nakamura196/iiif-auth-nextjs（https://github.com/nakamura196/iiif-auth-nextjs、本人の Next.js デモ、JWT）。
- digirati-co-uk/iiif-auth-server は Auth 1.0 の型（login / clickthrough / kiosk / external）。
- 署名付き URL を probe の `location` で渡す実装は見つからなかった。既存の SSO（OIDC 等）を Auth 2.0 に
  つなぐ汎用の部品も見つからなかった。
- 限界: 検索 2 回だけ。GitHub のコード検索と IIIF Slack / Google グループは見ていない。

## 2026-10-14（続き）Worker 本体を作った（手元のみ、未コミット）

- 作業は Sonnet のサブエージェントに指示書を渡して行い、コードは司令塔（Opus）が読んで確かめた。
- src/ 11 ファイル 750 行、テスト 40 件（偽の RSA 鍵と JWKS で Access の JWT を作る）。`npm test` と型検査は通過。
  依存は開発用のみ: wrangler 4.143.0、typescript 6.0.3、vitest 4.1.11、@cloudflare/vitest-pool-workers 0.22.0、
  @cloudflare/workers-types 5.20260930.1。`npm audit` の high 5 件（wrangler 経由の undici・sharp）は overrides で 0 件にした。
- 実装中に分かったこと:
  - 同梱の workerd が対応する compatibility_date は 2026-08-22 まで。
  - `cloudflare:test` の `fetchMock` はこの版には無い。テストは `globalThis.fetch` を差し替えて JWKS を返している。
  - トークン・セッション・ファイル署名は同じ鍵の HMAC。`typ` とコレクション名を payload に入れて取り違えを防ぐ。
    ファイル署名の入力は `files/<c>/<path>|<exp>` で、base64url の値（`/` と `|` を含まない）とは衝突しない。

### 読んで気づいた点（直していない。判断して直すか、限界として記事に書く）

1. **ブラウザのキャッシュが効かない。** probe のたびに `exp` が変わり URL も変わるので、
   同じモデルを開き直すたびに全体を取り直す。対策案: `exp` を 5 分単位に切り上げる、または 1 日単位の長めの署名にする。
2. **Access から外した人が、最長 8 時間見られる。** 自前のセッション Cookie（`cookieMaxAge` 28800 秒）が
   有効な間は、Access の policy を変えても token が出続ける。保存を持たない設計の代償。
3. **許可していない origin には何も返さない。** 仕様には `invalidOrigin` の誤り応答がある。
   ただし `frame-ancestors` の制限で、許可外のページではそもそも iframe が表示されない。
   クライアントは待ち時間切れで失敗を知る。
4. 本物の Access の JWT（`iss` の形、`aud` が配列かどうか）では試していない。初めて配るときに確かめる。

### 2026-10-14 読んで気づいた点 1・2 を直した（本人の判断）

- 1 → 署名付き URL の期限を「次の正時」にそろえた（残りが 5 分未満なら、その次の正時）。
  同じ 1 時間のうちは probe が同じ URL を返し、ブラウザに残った分が使われる。漏れた URL は最長 1 時間 5 分使える。
- 2 → 通行証（セッション Cookie）を 8 時間から 1 時間に短くした。Access から外した人は最長 1 時間で見られなくなる。
  切れたら窓が一瞬開いて閉じる（Access 側のログインが残っている間）。
- テストは 42 件で通過。
