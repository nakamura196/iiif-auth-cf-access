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

## 2026-10-14（続き）R2 をやめ、Workers Static Assets に置く

- `wrangler r2 bucket list` が「R2 を有効にしてください」（code 10042）で失敗した。このアカウントでは R2 が使えない。
  R2 を有効にするには支払い方法の登録が要るため、無料枠の方針に合わない。
- 代わりに、ファイルを Worker と一緒に Workers Static Assets として配る。`run_worker_first: true` にすると、
  すべての要求がまず Worker を通り、ファイルは Worker が `env.ASSETS.fetch` で取り出したときだけ出る。
  無料プランの上限は 1 ファイル 25 MiB・2 万ファイル。railclass は GLB 100 件（最大 2.9 MB）と
  ダウンロード 400 件（最大 4.2 MB、計 535 MB）なので収まる。
- 置き場所を差し替えられるようにした（src/store.ts）。R2 を結べば R2、Static Assets を結べばそちらを使う。
  Range は Static Assets が応じなければ Worker 側で切り出す。
- 手元の `wrangler dev` で確かめた（acela.glb、2,294,332 バイト）:
  ファイルの素のパス → 404、署名なしの /files → 403、正しい署名 → 200 で全バイト、Range 0-99 → 206 で 100 バイト。
- 代償: ファイルを差し替えるたびに Worker を配り直す。ファイルの数だけ配布の時間が延びる。
- 鍵が無い・32 文字未満のときは 500 を返すようにした。配布の途中で鍵が未設定のまま動くと、
  空の鍵で署名が通ってしまうため。配布は `--secrets-file` で鍵とコードを同時に出す（scripts/deploy.zsh）。
- テストは 47 件で通過。
- 置き場所の別案として、mdx の S3 互換ストレージ（s3ds.mdx.jp）も挙がった。Worker から S3 の署名付きで読む形になる。
  本人の判断で採らず、Workers Static Assets のままにした（2026-10-14）。

## 2026-10-14（続き）トークンと Access を作った

- トークンはダッシュボードでしか作れない（CLI の親鍵を持たない方針）。画面を埋める console スクリプトを用意したが、
  画面の部品がまた変わっていて（base-ui）、「レベル」の欄の代わりに「権限」の欄の開閉ボタンを掴んで止まった。
  - 権限の欄は `input[role=combobox]`、リソースとレベルは `button[role=combobox]`。開閉ボタンも `aria-haspopup=listbox` を名乗る。
  - 「ゾーン リソース」の隠し入力 `zoneResources` は無くなっていた。見出し h2 の 2 段上が区画。
  - 「Access: Organizations, Identity Providers, and Groups」は画面では「Access: Organizations」と「Access: Identity Providers」に分かれていた。権限は計 6 行。
  - アカウント リソースの既定は「すべてのアカウント」。自分のアカウントに絞った。
- 結局、Claude in Chrome でその場の DOM を読みながら埋め、「トークンを作成する」だけ本人が押した。
  画面の作りが変わるたびに console スクリプトを直すより、この方が手戻りが少ない。
- 作成直後の画面でコピーすると、試すための curl の行が丸ごと入ることがある。保存スクリプトは Bearer の後ろだけを取るようにした。
- zsh では `status` が読み取り専用の変数。スクリプトで使うと止まる。
- 保存前の実測（6 項目）はすべて通った。Zone Read を付けていないのに `zones?name=` でゾーン ID が引けた（Workers Routes の権限で足りるらしい）。
- Access は API で作った（scripts/setup-access.zsh）。対象は `/auth/login/railclass` だけ、ログイン方法は one-time PIN だけ。許可は 1 アドレスから始めた。

## 2026-10-14（続き）2段下のサブドメインには証明書が出なかった

- `models.railclass.ldas.jp` に custom domain を割り当てて配った。DNS は 1.1.1.1 で引けた（104.26.x / 172.67.x）。
- しかし HTTPS は接続の始めで断られた（`sslv3 alert handshake failure`）。配ってから 15 分以上たっても変わらなかった。
- 無料の証明書（Universal SSL）が守るのは `ldas.jp` と `*.ldas.jp` だけで、`*.railclass.ldas.jp` は入らない。2段下を使うには有料の証明書が要る。
- 無料枠の中で使う方針なので、ホスト名を1段の `railclass-models.ldas.jp` に替える案に進む。
- 汎用の手順としての教訓: Worker の custom domain は、ゾーンの直下の1段（`<名前>.<ゾーン>`）にする。
- ホスト名を `railclass-models.ldas.jp` に替えて配り直した（Version 6e3e62bf）。ファイルは前回分が使われ、送り直しは 0 件だった。
- 確認 4 つはすべて期待どおり: probe は 401、署名なしの file は 403、素のパスは 404、login は Access のログイン画面への 302。
- Access アプリは新しいホスト名で作り直し、aud を差し替えた。古いアプリは API で消した。古い custom domain は、配り直しのときに wrangler が外していた。
- ブラウザで `/auth/login/railclass` を開くと、Access のログイン画面（one-time PIN）に移ることを確かめた。
- 本人のアドレスで one-time PIN のログインを通したあと、`https://railclass.ldas.jp` のページから一連の流れを確かめた（Chrome で実行）。
  - トークンの iframe は `AuthAccessToken2` を postMessage で返した（有効 300 秒）。
  - そのトークンで probe を聞くと status 302 と、署名付きの /files の URL が返った。
  - その URL に Range（先頭 4 バイト）で頼むと 206 で、中身は `glTF` で始まった。別のオリジンからの読み出しも CORS で通った。

## 2026-10-15 サイトを切り替えた

- サイト（静的、GitHub Pages）は、3D を直接読むのをやめた。ページを開くと隠した iframe で通行証を聞き、probe で署名付き URL をもらって表示する。通行証が無ければ、サムネイルの上に「ログイン」のボタンを出す。
- ログインの窓は、クリックからすぐ開かないとポップアップとして止められる。ダウンロードのリンクは、ページを開いた時点でログインの有無を調べておき、押したらすぐ窓を開くようにした。
- 手元（localhost）では token の iframe が何も返さない（許可したオリジンではないため）。案内が出るまで時間切れの 10 秒を待つ。本番では「ログインしていない」がすぐ返る。
- マニフェストの rights は In Copyright（rightsstatements.org）に替え、requiredStatement に「個別の許諾が必要」と書いた。RDF の schema:license も同じ。schema:contentUrl は Worker の /files の URL にした（それだけでは 403）。
- 公開側から GLB 100 個を外し、GitHub のリリース（400 ファイル）を消した。git の履歴は書き換えていない。
- 落とし穴: ファイルが 400 個あるリリースは、`gh release delete` が GitHub の 502 で何度も失敗した。ファイルを 1 つずつ消してから、リリースを消すと通った。
- 本番で、ログインした状態の形式ページに 3D が出ることを Chrome で確かめた。

## 2026-10-17 デモサイトの最初の型（clickthrough の画像）

iiif-auth-demo.ldas.jp を「Auth 2.0 の型を 1 つずつ試せるサイト」にする。最初の型は clickthrough（同意だけ）を画像で。

- 画像は国立国会図書館デジタルコレクション「百鬼夜行絵巻」（pid 2540972、14 コマ目、PDM、8701×6937）。
  当初は九相図を探した（clickthrough は本来、内容の注意書きに使う型なので）。NDL のデジタル化資料では見つからず、深追いをやめた。同意の文言は「利用条件への同意」にした。
- タイルは `vips dzsave --layout iiif3 --tile-size 512` で前もって切る。332 ファイル・4.5 MB（1024 px の full を足して 334）。Static Assets の上限 2 万ファイルに対して十分小さい。サイズの名前は IIIF 3 の `w,h`（`512,512`）になる。
- info.json は誰でも読める。タイルは Cookie で守る。`<img>` はトークンを送れないため。probe は、画像の service なら 200 を返し、`location` を付けない。
- info.json とマニフェストは、要求のホスト名で `id` と auth の service を埋める。同じファイルが本番でも手元でも使える。
- 手元の確認（wrangler dev）: 同意前のタイル 401、同意後 200（image/jpeg）、トークン付き probe 200。
  wrangler dev は custom_domain の route があると、要求の URL を本番のホスト名（http://iiif-auth-demo.ldas.jp）に書き換える。手元で Kasane からは開けない。ブラウザでの確認は配備後。
- 確かめていないこと: tomcrane client（github.io、別サイト）で、第三者 Cookie の制限によりトークンが取れない、という見込み。
  tomcrane client の劣化版は `substitute` という古い書き方を読む。Kasane は `location` を読む。2 番目の型（劣化版）では両方の違いが出る。

## 2026-10-17 配備して見つかった食い違い 2 つ

最初の型（terms/hyakki）を iiif-auth-demo.ldas.jp に配り、ブラウザで開いた。curl では 401→同意→200 が通っていたが、ビューアでは画像が出なかった。

- Kasane（OpenSeadragon）はタイルを `x,y,w,h/512,/0/default.jpg`（幅だけ）で頼む。`vips dzsave --layout iiif3` は `512,512`（幅・高さ）の名前で書く。level 0 では名前が一致しないと 404 になる。Worker で `w,` を `w,h` に読み替えて直した。高さは vips と同じく「領域 ÷ 2 のべき乗、切り上げ」で出す。329 枚すべてで一致を確かめた。
- tomcrane の client は、画像サービスの id（`/info.json` なし）を直接読む。Image API 3 は id から info.json への 303 を推奨しているが、無かったので 404 になっていた。303 を返すようにした。
- 教訓: level 0 のタイルを手で置くときは、クライアントごとの頼み方（`w,` / `w,h`、id の直読み）を実物で確かめる。curl で自分の URL を叩くだけでは見つからない。

## 2026-10-17 2 番目の型（劣化版）と、substitute についての訂正

**訂正:** 上の「tomcrane client の劣化版は `substitute` という古い書き方を読む」は誤り。Auth 2.0 の正式版を読み直した（https://iiif.io/api/auth/2.0/ 、probe の応答の節）。

- 劣化版は、probe が `status: 401` と `substitute`（配列。各要素に `id`・`type`、任意で `label`・`service`）を返す。クライアントは代わりの資料を表示し、そのまま access service（同意・ログイン）へ進む。
- `location` は 30x のときだけ使える。意味は「代わりにこちらを読め」（署名付き URL など）。クライアントの手順では、表示して終わる。ログインの案内には進まない。
- つまり `substitute` が正式な書き方で、`location` で劣化版を返すと、高精細版へ進む道が無くなる。

二つのクライアントの実際:

- tomcrane client（ブランチ iiif-auth2、最終更新 2024-03）は `substitute` を 1 つのオブジェクトとして読み、`substitute.id` を info.json として取りに行く。正式版の配列は読めない。401 なので、同意の流れには進む見込み。
- Kasane は `substitute` を読まない。30x と `location` は「見てよい」と扱い、案内を出さない。劣化版を見せるには Kasane 側の対応が要る（別の PR）。

作ったもの:

- まとまり `degraded`。設定に `substituteLabel` があると、画像 `<id>-degraded` が公開の劣化版になる（info.json に auth の service なし、タイルは Cookie なしで読める）。トークンの無い probe は 401 と、その画像サービスを `substitute` に入れて返す。
- 画像は「百鬼夜行絵巻」17 コマ目（彩色の妖怪。白黒との差が分かりやすい）。劣化版は長い辺 600 px の白黒（`vips thumbnail` → `vips colourspace b-w`）。このまとまりのファイルは 339 個。
- 手元（wrangler dev）で確認: probe は 401 と substitute、劣化版のタイルは Cookie なしで 200、高精細のタイルは Cookie なしで 401・同意後 200。既存の `terms` の probe には substitute が付かない。
- 確かめていないこと: ビューアでの見え方（配備後に Kasane の対応を入れてから）。tomcrane client で劣化版が出ず、同意後に高精細版が出るか。

前回の積み残し（PR #3 の配備後の目視）:

- Kasane・tomcrane client の両方で「同意画面 → 同意 → 画像」が出た。tomcrane（github.io、別サイト）でも出たのは、使った Chrome が第三者 Cookie を止めていなかったため。Safari や、第三者 Cookie を止めた Chrome での失敗はまだ見ていない。

## 2026-10-17 劣化版を配って、二つのクライアントで見た

劣化版（まとまり `degraded`）を iiif-auth-demo.ldas.jp に配った（Worker の Version d03d8c80）。どちらのクライアントも、毎回 `/auth/logout/<まとまり>` で Cookie を消してから開いた。

- curl: トークンの無い probe は 401 と `substitute`（配列）を返す。高精細のタイルは同意前 401、白黒版のタイルは Cookie なしで 200。
- tomcrane client（github.io）: 予想どおり劣化版は出ない。コンソールに「substitute of undefined」が出て、画像の枠は空のまま。同意の案内は出て、同意するとカラーの高精細版が出た。正式版の配列の `substitute` を読めないため。同意の流れ自体は 401 なので動く。
- Kasane（kasane.ldas.jp）: `substitute` を読む対応を入れた版で、白黒の劣化版と同意の案内が出る → 同意 → カラーに替わる。同意後は「同意を取り消す」が出る。既存の `terms` も、ぼかした縮小画像と案内 → 同意 → カラー、で変わらない。
- 同意後に「Could not load the image」が残る、という報告が一度あった。手元では再現しなかった。タイミング次第で出る見込みで、Kasane 側で「タイルが 1 枚でも読めたら消す」ようにした。その版で両方の見本をもう一度見て、同意の数秒後にこの文言が出ていないことを確かめた（Chrome、1 回ずつ）。
- 分かったこと: 劣化版は、サーバを仕様どおりにしても、クライアントが `substitute` を読まなければ見せられない。2024 年までのクライアントは、単一のオブジェクトを前提にしていることがある。デモでは「同じ probe の応答が、クライアントによって違って見える」こと自体を見せる。
- 確かめていないこと: Mirador での見え方。第三者 Cookie を止めたブラウザでの tomcrane client（前回からの積み残し）。

## 2026-10-17 3 番目の型（3D の劣化版）

上野の点群で、劣化版を 3D に広げた。まとまり `degraded3d`。上野の代表見本（hongo-campus-iiif の ueno.json）は変えず、デモサイトに別の見本として置いた（本人の選択）。代表見本を劣化版にすると、PLATEAU の模型を選んでも同意前は点群が出る、という食い違いが出るため。

- 作り: 画像の劣化版と同じ名前の決まりにした。`<まとまり>/model/<id>/model.glb` が高精細（17,478,236 バイト）、`<id>-degraded/model.glb` が軽い点群（1,666,960 バイト）。トークンの無い probe は 401 と `substitute: [{ type: "Model", format: "model/gltf-binary", ... }]` を返す。軽い版は `/files` から署名なしで配る（`substituteLabel` のあるまとまりだけ）。同意後は従来どおり 302 と署名付き URL。
- マニフェストは Worker が組み立てる（Presentation 4、Scene 1 つ）。元のファイルは github.io の公開 URL から `demo/models.json` でビルド時に取る。手元のファイルに頼らないので、worktree を消しても作り直せる。
- 手元で確認: wrangler dev（8799）と Kasane の next dev（3838、既存の allowedOrigins に入っている）。軽い点群＋同意の案内 → 同意 → 高精細に替わった。通信は probe 200（中身 401）→ 軽い版 200 → token → probe → 署名付き URL 200。
- 落とし穴: 本番の Kasane（https）から手元の http://localhost のマニフェストは読みに行かなかった（通信が 1 本も出ない）。手元の確認は Kasane も手元で動かす。
- 分かったこと: 3D では「劣化版」が画質を落とした同じ物とは限らない。点群を間引いた版、形式の違う版（点群とメッシュ）も substitute にできる。ただし Kasane は substitute を 1 つしか見ない。
- 確かめていないこと: 本番への配備。tomcrane client は 3D を表示しないので対象外。

## 2026-10-17 4 番目と 5 番目の型（ID とパスワード、ビューアの外での先ログイン）

ID とパスワードで入る型を 2 つ足した。まとまり `login` と `external`。どちらも見本用の ID（`demo`）とパスワードを公開し、ページにも書く。本物の秘密ではない。

- `login`: ビューアが窓を開き、そこにフォームが出る。入れると Cookie が付き、窓が閉じる。access service の profile は `active`（クリックスルーと同じ）。違うのは、同意ボタンの代わりにフォームが出ること。
- `external`: ビューアは何も開かない。token service に問い合わせるだけで、Cookie が無ければ「ログインが要る」と返る。ユーザーは先に、同じフォームを普通のタブで開いてログインする。成功したら窓は閉じず、「ビューアに戻って開く」とトップページへのリンクを出す。access service は `profile: "external"` で `id` を持たない（Auth 2.0 では、external のクライアントは何も開かずに token service へ進むため）。token と logout の service は今までどおり入れ子にした。
- 作り: フォームのページは 1 つ（`/auth/login/<c>`）で、GET がフォーム、POST が検証。2 つの型で同じものを使い、違いは成功後の画面と service block の profile だけ。POST を許すのは login ルートだけで、ほかの auth ルートは GET のみ。クリックスルーや Access のまとまりへの POST は 405 で、Cookie は付けない。ID かパスワードの設定が無いまとまりは、フォームも検証も 503 で止める（開けっ放しにしない）。比較は長さと内容によらず同じ手順で行う。
- 一つのフォームを使い回した理由: 型の違いはクライアントの動き（窓を開くか）であって、サーバの認証処理ではないため。分けると同じ検証が 2 か所になる。
- 却下した案: external でも成功後に `window.close()` する案。普通のタブで開いた窓は閉じられないことが多く、閉じられても元のビューアに戻る手がかりが無い。
- テスト: 自動テストで、フォームの表示、誤りの 401（Cookie なし）、正しいときの Cookie → token → probe、external の service block（`id` なし）、POST の拒否、設定欠落の 503 を確認した。

確かめていないこと:

1. Kasane と tomcrane client のブラウザでの動き。サーバ側（curl とテスト）だけ確認した。
2. 注意: tomcrane（github.io）では、どの型でも token の iframe は別サイトになる。第三者 Cookie を止めたブラウザは、external だけでなく全部の型に響く。external が増やすのは、ビューアが窓を開かないので、ビューアの側で利用者の操作が起きないこと。そのためブラウザの Storage Access の判定が変わるかどうかは、試していない。
