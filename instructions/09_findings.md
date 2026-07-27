# 09 findings — MCP 認証失敗のサイレント埋没への対応

対象: `instructions/09_silent_auth_failure.md`
実施日: 2026-07-23
claude CLI: 2.1.218

---

## Task 1: ハンドシェイク失敗を検出する方法の調査

### 1-1. `system`(init)イベントに MCP サーバーの接続状態は含まれるか → **含まれる。ただし単独では不十分**

`claude --print --output-format stream-json --verbose` の 2 行目に出る
`{"type":"system","subtype":"init", …}` には、以下が含まれていた(実測):

```json
{"type":"system","subtype":"init", …,
 "tools":[… 55 件 …],
 "mcp_servers":[{"name":"central-mcp","status":"connected"},
                {"name":"mist-cloud","status":"pending"}]}
```

`tools[]` には登録済みツールが全部入っており、`mcp__` 接頭辞のものを数えれば
「その時点で何個の MCP ツールが登録されたか」も分かる。

**検証 3 パターン(いずれも scratchpad 上のコピー config で実施):**

| 条件 | init の `mcp_servers` | init 時点の mcp ツール数 | 実際の結果 |
|---|---|---|---|
| 両方正常 | central=`connected`, mist=`pending` | 25(central のみ) | mist ツール呼び出し成功 |
| **mist の Bearer を無効化** | central=`connected`, mist=**`pending`** | 25 | mist ツールが最後まで登録されず、モデルの地の文で終了 |
| central の url を到達不能に | central=**`failed`**, mist=`pending` | 0 | central ツールを1つも呼べず終了 |

つまり:

- **`status: "failed"` は信頼できる**(到達不能な HTTP サーバーは init の時点で `failed` と出る)。
- **`status: "pending"` は判定不能**。mist-cloud は stdio(`npx mcp-remote`)で起動が遅く、
  **正常時も認証切れ時も等しく `pending`** のまま init が出る。
- init 以降に接続状態を更新する `system` イベントは **来ない**(正常時の 14 行、
  異常時の 41 行すべてを走査して確認)。したがって「pending → connected になった」ことを
  イベント列から知る手段は無い。

→ **init イベントだけでは、今回の本丸(mist-cloud の認証切れ)は検出できない。**

### 1-2. 代替手段の検討

指示書に挙がった 2 案のうち、

- (a)「narrowing 済み config のサーバー名 vs 実際に呼ばれたサーバー名の突き合わせ」
  → 単独では **誤検知する**。サイト指定なしで両プラットフォームを config に入れた実行で、
  モデルが Central だけで答えを出す(Mist が不要)ケースは正常であり、
  「呼ばれなかった = 壊れている」とは言えない。
- (b)「事前ヘルスチェック」
  → 全実行の前に毎回やるのは無駄が大きい(正常時もコストを払う)。

そこで **(a) を「疑いの検出」に、(b) を「疑いの確認」に使う 2 段構え** を採用した。

### 1-3. 採用方式: **init イベント + 呼び出し実績 + 事後の直接ハンドシェイク probe**

1 実行が終わった時点で、**narrowing 済み config に含めた各 MCP サーバー**について:

1. **その実行で 1 回でも `tool_use` が出ていれば ok**(接続できていたことが実証済み。probe しない)。
2. **0 件だったサーバーだけ**、その場で **直接 MCP ハンドシェイクを叩いて生死を確認する**
   (claude CLI を介さない。`initialize` → `notifications/initialized` → `tools/list`)。
   - 到達して 1 件以上ツールが返る → **正常**(モデルが単に使わなかっただけ。警告を出さない)
   - JSON-RPC エラー / HTTP エラー / ツール 0 件 → **接続できなかった**(警告)
3. probe できない定義(未知の stdio サーバー等)は、init の `status` で補う
   (`failed` なら異常、`pending` なら「確認が必要」レベルの警告に留める)。

**この方式にした根拠:**

- **誤検知しない**。「呼ばれなかった」だけでは警告せず、必ず実物を叩いて確認してから警告する。
  正常な Mist を使わなかった実行では probe が成功するので、警告は出ない。
- **見逃さない**。`pending` のまま埋もれる stdio 認証切れも、probe が 401 を拾って確定できる。
- **正常時のコストがほぼ無い**。使われたサーバーは probe しない。probe が走るのは
  「config に入れたのに 1 回も使わなかった」ときだけで、実測 0.3〜1.5 秒。
- **理由が具体的に出せる**。probe は MCP サーバー本人のエラー文言をそのまま持ち帰る。

**probe の実測(直接 fetch。claude CLI もmcp-remote も経由しない):**

```
# 正常な Mist トークン
initialize → 200 / mcp-session-id: XNHAZ…  → tools/list → tools 7 件
# 無効な Mist トークン
initialize → 200 / data: {"jsonrpc":"2.0","id":1,
  "error":{"code":0,"message":"authentication failed: Mist API rejected credentials (HTTP 401)"}}
# central-mcp(ローカルの cache proxy)
initialize → 200 (application/json) → tools/list → tools 25 件
```

stdio 定義の mist-cloud は `npx mcp-remote <url> --header k:v …` という形なので、
**args から url と `--header` を取り出して同じ HTTP ハンドシェイクを直接行う**
(mcp-remote が内部でやっていることと同じ)。npx の起動を待たないので速い。
`central-mcp` は `type:"http"` なので `url` をそのまま使う(コンテナ内では
既存の `CENTRAL_MCP_HOST` 書き換えを通してから叩く)。

---

## Task 2: 検出結果の UI 反映

### 2-1. 判定ロジック(サーバー1件ごと)

`plugins/network-investigation/mcp.ts` の `evaluateMcpHealth()`:

| 条件 | 判定 |
|---|---|
| その実行で 1 回以上呼ばれた | `ok` |
| probe 失敗 | **`unreachable`**(= 接続できなかった) |
| probe 成功、init が `failed` | `warn`(claude 側だけ失敗。一時的な可能性) |
| probe 成功、init が `failed` 以外 | `ok`(単に使われなかっただけ) |
| probe 不可、init が `failed` | **`unreachable`** |
| probe 不可、init が `pending`/`unknown` | `warn`(確認が必要) |
| probe 不可、init が `connected` | `ok` |

実行全体のレベルは、いずれかが `unreachable` なら `unreachable`、
それ以外でいずれかが `warn` なら `warn`、でなければ `ok`。

**「失敗」ではなく警告に留めている点**が要点。回答自体は返っているので `isError` は立てない。
その代わりターンに専用のバナーとタグを出す。

### 2-2. 表示

- ターン見出しに **`MCP未接続`(赤)** または **`要確認`(アンバー)** のタグ
- 回答の直前に **警告バナー**。どのサーバーが・どの理由で駄目だったかを 1 行ずつ出す:

  ```
  ⚠ 一部の MCP サーバーに接続できませんでした(認証切れの可能性があります)
     [Mist ロゴ] mist-cloud (Mist)  接続できませんでした
     authentication failed: Mist API rejected credentials (HTTP 401)
     この実行では mist-cloud のツールが 1 度も使われていません。回答は残りのデータだけで
     組み立てられている可能性があります。
  ```

- タイムラインのカードにも同じタグを出す(一覧から気付けるように)
- 履歴 jsonl にも `mcpHealth` として保存するので、後から開いても警告が残る

---

## Task 3: 動作確認

**本番の `.env` と `~/.claude.json` は一切変更していない。** 08 と同様、scratchpad 上に
「mist-cloud の Bearer だけを無効値に差し替えたコピー」を作り、compose のオーバーライドで
`/host/claude.json` のマウント元をそのコピーに差し替えて検証した。検証後にコピーは全削除済み。

### 3-1. 判定ロジックの単体確認(ホスト実行、claude CLI を介さない)

`evaluateMcpHealth()` を直接呼んで 4 分岐すべてを踏んだ。

| 入力 | 結果 |
|---|---|
| 正常な資格情報・呼び出し 0 件 | `level=ok` / central 25 tools・mist 7 tools 到達(**2,145ms**) |
| **mist の Bearer 無効**・呼び出し 0 件 | `level=unreachable` / mist の理由 `authentication failed: Mist API rejected credentials (HTTP 401)`(902ms) |
| mist の Bearer 無効だが **呼び出し 3 件あり** | `level=ok`(**2ms** = probe を1回も走らせない) |
| init に `central-mcp: failed` を注入 + probe 成功 | central=`warn`(「初期化時に接続失敗と報告されたが直接確認では到達できた」) |

### 3-2. 誤検知しないことの確認(正常時・実アプリ経由)

`docker compose up -d --build`(本番マウント)の状態で、
**「サイト指定なし = central-mcp / mist-cloud の両方を config に入れた実行」** を流した。

- クエリ: `Central 側の全サイトの健全性だけを確認して。Mist は見なくてよい。`
- 結果: `isError=false` / 呼び出しは `central-mcp:central_get_summary:done` の **1 件のみ**
- **mist-cloud はツール呼び出し 0 件**(モデルが `[判断] Mist は不要と判断` を宣言)
- → probe が走り、**到達できたので `level=ok`**。履歴の `mcpHealth` は `null`、
  タイムラインにもターンにも **警告は出ていない**

これは「本当にツールを使う必要がなかった質問」そのもので、
指示書 Task 2-3 が懸念していた誤検知ケース。**警告は出なかった。**

`GET /api/network-investigation/mcp-health`(正常時)も `level: ok`
(central-mcp reachable=true tools=25 / mist-cloud reachable=true tools=7)。

### 3-3. 認証無効化での再現(実アプリ経由)

`compose.broken-mist.yml` で壊したコピーをマウントして `--force-recreate` し、
Mist を必要とするクエリを実行した。

- クエリ: `Mist 側の組織情報とサイト統計を確認して(09 認証切れ検証)`
- claude CLI の実行自体は **`isError=false`(成功扱い)**、**ツール呼び出し 0 件**
  → 08 で確認した「サイレントに埋もれる」状態そのものを再現
- 検出結果(履歴 `mcpHealth`):

```json
{"level":"unreachable",
 "servers":[
   {"server":"central-mcp","initStatus":"pending","toolCalls":0,"reachable":true,"tools":25,"level":"ok"},
   {"server":"mist-cloud","initStatus":"pending","toolCalls":0,"reachable":false,"tools":null,
    "level":"unreachable",
    "reason":"authentication failed: Mist API rejected credentials (HTTP 401)"}]}
```

  **central-mcp も呼び出し 0 件だったが、probe が通ったので `ok`**。
  壊れている mist-cloud だけがピンポイントで `unreachable` になっている。

- **画面表示(実測)**
  - タイムラインのカードに赤い **`MCP未接続`** タグ
  - ターン見出しにも **`MCP未接続`** タグ、左端の縦線が赤
  - 回答の直前に警告バナー:

    ```
    ⚠ 一部の MCP サーバーに接続できませんでした(認証切れの可能性があります)
       [Mist] mist-cloud(Mist)   接続できませんでした
       authentication failed: Mist API rejected credentials (HTTP 401)
       この実行では mist-cloud のツールが 1 度も使われていません
       (claude 初期化時の状態: pending)。
       回答は残りのデータだけで組み立てられている可能性があります。
    ```

- サーバーログにも残るようになった(08 では痕跡ゼロだった):

```
[network-investigation] MCP 接続の警告(unreachable): mist-cloud(Mist) — authentication failed: Mist API rejected credentials (HTTP 401)
```

### 3-4. 復元確認

`docker compose up -d --build --force-recreate`(オーバーライド無し)で復帰。

- `docker inspect` のマウント: `/host_mnt/Users/kshimono/.claude.json -> /host/claude.json`(本来の位置に復帰)
- `GET /health` → `mcpConfig.source=live, servers=[central-mcp, mist-cloud]`
- `GET /api/network-investigation/mcp-health` → `level: ok`(central 25 tools / mist 7 tools)
- Mist クエリ再実行(`09 復旧確認`)→ `get_mist_self` / `get_mist_config` / `get_mist_stats`×2 が
  すべて `done`、回答生成成功、**履歴の `mcpHealth` は `null`(= 警告なし)**
- タイムライン: 22:17(復旧後)タグ無し / 22:15(認証無効時)`MCP未接続` / 22:14(Mist 未使用だが正常)タグ無し
- Global Overview も 22 サイト・両プラットフォーム正常表示
- ホストの `~/.claude.json` に `INVALID_TOKEN_FOR_TEST` が含まれないことを確認。
  `.env` は更新時刻 7/23 14:00 のまま(このセッションで触っていない)
- 検証用コピー(`broken-claude.json` / `broken-mist.json` / `broken-central.json` /
  `good.json` / `compose.broken-mist.yml` / probe 用 fakehome)は **すべて削除済み**

### 3-5. 既知の限界

- **既存の履歴には遡って警告は付かない**。`mcpHealth` は 09 以降の実行にだけ記録される
  (08 3-5 で記録した 16:58 の実行はタグ無しのまま)。
- **`type:"sse"` の MCP サーバーや mcp-remote 以外の stdio サーバーは probe できない**。
  その場合は init の `status` に頼り、`pending` なら `warn`(要確認)止まりにする
  = 断定しない。現状の 2 サーバーはどちらも probe 可能。
- **Central の「トークン期限切れ」は probe では検出できない**。central-mcp はローカルの
  cache proxy(`http://127.0.0.1:8011/mcp`)で、Central API の資格情報は proxy の内側にある。
  ハンドシェイクは proxy が返すので通ってしまう。この系統の失敗はツール呼び出し時の
  エラーとして出るので、08 で実装済みの個別失敗表示の担当範囲。

---

## 変更ファイル一覧

```
plugins/network-investigation/mcp-health.ts          新規。MCP サーバーへの直接ハンドシェイク probe
plugins/network-investigation/mcp.ts                 init イベントの取り込み・呼び出し実績集計・健全性判定
plugins/network-investigation/insight-agent.ts       McpHealth を結果に載せる
plugins/network-investigation/api.ts                 SSE answer / 履歴 / GET /mcp-health
plugins/network-investigation/view/types.ts          McpHealth 型
plugins/network-investigation/view/session.ts        ターンへ引き継ぎ
plugins/network-investigation/view/McpHealthNotice.tsx 新規。警告バナー
plugins/network-investigation/view/Turn.tsx          タグ + バナー
plugins/network-investigation/view/Timeline.tsx      カードのタグ
plugins/network-investigation/view/NetworkInvestigation.tsx SSE ハンドラ
plugins/network-investigation/view/styles.css        警告バナー・タグのスタイル
```

`npm run typecheck` 通過。git 操作は行っていない。

---

## NEXT

1. **警告を実行中(SSE)にも出す**。現状は完了したターンにだけ出る。probe は実行後なので、
   ライブログに出すなら別イベント(`mcp_health`)を後追いで流す形になる。
2. **Global Overview 側の Central トークン期限切れ**は 05/08 の経路で別途出ているが、
   ネットワーク調査側の central-mcp(cache proxy 経由)では検出できない(3-5)。
   proxy 側に「上流の認証状態」を返すヘルスエンドポイントを持たせれば埋められる。
3. **定期実行での通知**。定期実行が `unreachable` で終わったときに、画面を見ていなくても
   気付けるようにする(ログには出るようになったが、能動的な通知は無い)。
